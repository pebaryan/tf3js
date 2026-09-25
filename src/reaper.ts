import * as THREE from 'three';
import { soundManager } from './sound';
import { segmentIntersectsSphere, splashDamage } from './collision';
import { bevelBox } from './geometryUtils';
import { FRAG_EXPLOSION_CONFIG, EPG_EXPLOSION_CONFIG } from './effects';
import { flashLight } from './graphics';
import { Tick } from './tick';
import {
  Hostile, HostileContext, HostileHit, hasLineOfSight, steerTowards, tryMoveHorizontal, turnTowards, yawTowards,
} from './hostile';

/*
 * Reaper: a ~3 m bipedal war machine with digitigrade legs. It advances on the
 * pilot, fires homing rocket salvos from its side pods, stomps anything that
 * gets underfoot and launches ticks from a hatch on its back. On death it
 * collapses and blows up.
 */

export enum ReaperState {
  PATROL,
  ENGAGE,
  SALVO,
  STOMP,
  LAUNCH_TICKS,
  DYING,
  DEAD,
}

/**
 * The model is authored at ~6.2 m and scaled down uniformly, so it stands about
 * 3 m tall: a head and a half taller than a pilot, a quarter of a titan.
 * Constants below marked "model units" are pre-scale; world distances are not.
 */
export const REAPER_SCALE = 0.48;
const HIP_HEIGHT = 3.1; // model units
const WALK_SPEED = 3.2;
const TURN_RATE = 1.4;
const DETECTION_RANGE = 55;
const PREFERRED_RANGE = 12;
const STOMP_RANGE = 2.6;
const STOMP_DAMAGE = 40;
const STOMP_RADIUS = 3;
const ROCKETS_PER_SALVO = 6;
const ROCKET_SPEED = 20;
const ROCKET_MAX_SPEED = 34;
const ROCKET_TURN_RATE = 1.8;
const ROCKET_HOMING_TIME = 1.4;
const ROCKET_DAMAGE = 22;
const ROCKET_SPLASH = 3.5;
const MAX_TICKS_ALIVE = 5;

interface ReaperLeg {
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
  phase: number;
}

interface Rocket {
  mesh: THREE.Group;
  velocity: THREE.Vector3;
  age: number;
}

/* Shared rocket resources (many rockets, few materials) */
const rocketBodyGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.55, 10).rotateX(Math.PI / 2);
const rocketNoseGeo = new THREE.ConeGeometry(0.07, 0.18, 10).rotateX(Math.PI / 2).translate(0, 0, 0.36);
const rocketFlameGeo = new THREE.ConeGeometry(0.09, 0.5, 10).rotateX(-Math.PI / 2).translate(0, 0, -0.52);
const rocketBodyMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.6, roughness: 0.35 });
const rocketNoseMat = new THREE.MeshStandardMaterial({ color: 0xb02418, metalness: 0.3, roughness: 0.5 });
const rocketFlameMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(0xffa040).multiplyScalar(5),
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

export class Reaper implements Hostile {
  readonly kind = 'reaper' as const;
  readonly scoreValue = 400;
  readonly group: THREE.Group;
  health = 500;
  state = ReaperState.PATROL;

  private readonly scene: THREE.Scene;
  private readonly body: THREE.Group;
  private readonly head: THREE.Group;
  private readonly legs: ReaperLeg[] = [];
  private readonly podMuzzles: THREE.Vector3[] = [];
  private readonly hatch: THREE.Object3D;
  private readonly visorMat: THREE.MeshBasicMaterial;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly maxHealth = 500;
  private readonly spawnPos: THREE.Vector3;

  private stateTimer = 0;
  private gait = 0;
  private walking = false;
  private lastKnownTarget: THREE.Vector3 | null = null;
  private salvoCooldown = 3 + Math.random() * 2;
  private tickCooldown = 8;
  private stompCooldown = 0;
  private rocketsFired = 0;
  private rockets: Rocket[] = [];
  private stompDone = false;
  private ticksLaunched = 0;
  private patrolTarget: THREE.Vector3;
  private flashTimer = 0;
  private exploded = false;

  constructor(scene: THREE.Scene, position: THREE.Vector3) {
    this.scene = scene;
    this.spawnPos = position.clone();
    this.patrolTarget = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = Math.random() * Math.PI * 2;
    this.group.scale.setScalar(REAPER_SCALE);

    this.body = new THREE.Group();
    this.body.position.y = HIP_HEIGHT;
    this.group.add(this.body);
    this.head = new THREE.Group();
    this.head.position.set(0, 0.8, 0);
    this.body.add(this.head);

    this.visorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a14).multiplyScalar(3) });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.hatch = this.buildModel();
    scene.add(this.group);
  }

  /* ------------------------------ Model ------------------------------ */

  private buildModel(): THREE.Object3D {
    const paint = new THREE.MeshStandardMaterial({ color: 0x7c8580, metalness: 0.45, roughness: 0.5 });
    const paintDark = new THREE.MeshStandardMaterial({ color: 0x4d5550, metalness: 0.5, roughness: 0.5 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x23282c, metalness: 0.8, roughness: 0.35 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd3d6, metalness: 1, roughness: 0.18 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xb8321f, metalness: 0.3, roughness: 0.5 });

    const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      mesh.castShadow = !(mat instanceof THREE.MeshBasicMaterial);
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const strut = (parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
      const dir = b.clone().sub(a);
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, dir.length() - 2 * r), 4, 12), mat);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.castShadow = true;
      parent.add(m);
    };

    // Pelvis block
    part(this.body, bevelBox(1.5, 0.6, 1.1, 0.1), frame, 0, 0, 0);
    part(this.body, new THREE.CylinderGeometry(0.35, 0.45, 0.6, 16), frame, 0, 0.45, -0.05);

    // Head pod: the reaper's whole upper body
    const h = this.head;
    part(h, bevelBox(1.9, 1.15, 2.1, 0.22, 0.22), paint, 0, 0.35, 0);
    part(h, bevelBox(1.7, 0.3, 1.8, 0.1), paintDark, 0, 1.0, -0.1, 0.08);           // top armour
    part(h, bevelBox(1.5, 0.55, 0.4, 0.12), paint, 0, 0.3, 1.1, 0.25);              // snout plate
    part(h, bevelBox(1.6, 0.13, 0.12, 0.04), this.visorMat, 0, 0.62, 1.03);         // visor slit
    for (const [x, y, r] of [[-0.32, 0.12, 0.09], [0.32, 0.12, 0.09], [0, 0.02, 0.12]] as const) {
      part(h, new THREE.CylinderGeometry(r * 1.4, r * 1.4, 0.12, 16).rotateX(Math.PI / 2), frame, x, y, 1.27);
      part(h, new THREE.CylinderGeometry(r, r, 0.14, 16).rotateX(Math.PI / 2), this.visorMat, x, y, 1.29);
    }
    part(h, bevelBox(1.95, 0.12, 0.3, 0.04), accent, 0, -0.1, 0.9);                 // chin stripe
    // Side rocket pods with 2x3 launch tubes
    for (const sx of [-1, 1]) {
      const pod = part(h, bevelBox(0.55, 0.75, 1.3, 0.1), paintDark, sx * 1.25, 0.35, 0.15);
      part(pod, bevelBox(0.58, 0.1, 1.32, 0.03), accent, 0, 0.32, 0);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const tx = (col - 1) * 0.15;
          const ty = 0.12 - row * 0.24;
          part(pod, new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10).rotateX(Math.PI / 2), frame, tx, ty, 0.66);
          this.podMuzzles.push(new THREE.Vector3(sx * 1.25 + tx, 0.35 + ty, 0.9));
        }
      }
      // Pod mount
      part(h, bevelBox(0.35, 0.3, 0.6, 0.06), frame, sx * 0.98, 0.35, 0.1);
    }
    // Tick launcher hatch on the back, antennae
    const hatch = part(h, bevelBox(1.1, 0.45, 0.7, 0.1), frame, 0, 0.75, -0.95);
    part(hatch, bevelBox(0.9, 0.08, 0.5, 0.03), accent, 0, 0.24, 0);
    part(h, new THREE.CylinderGeometry(0.02, 0.03, 1.3, 6), frame, 0.6, 1.5, -0.7, -0.2, 0, -0.1);
    part(h, new THREE.CylinderGeometry(0.02, 0.03, 0.9, 6), frame, 0.45, 1.3, -0.85, -0.3, 0, -0.1);
    // Hit flash overlay
    part(h, new THREE.SphereGeometry(1.3, 16, 12), this.flashMat, 0, 0.35, 0);

    // Digitigrade legs: thigh forward/down, shin back/down, long raised metatarsal, splayed toes
    for (const sx of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sx * 0.85, 0, 0);
      this.body.add(hip);
      part(hip, new THREE.SphereGeometry(0.34, 16, 12), frame, 0, 0, 0);
      part(hip, bevelBox(0.3, 0.9, 0.9, 0.08), paint, sx * 0.25, -0.1, 0.05);        // hip armour

      const kneePos = new THREE.Vector3(0, -1.25, 0.6);
      strut(hip, new THREE.Vector3(0, 0, 0), kneePos, 0.22, paintDark);            // thigh
      part(hip, bevelBox(0.5, 0.95, 0.25, 0.08), paint, 0, -0.55, 0.42, -0.45);     // thigh plate

      const knee = new THREE.Group();
      knee.position.copy(kneePos);
      hip.add(knee);
      part(knee, new THREE.CylinderGeometry(0.26, 0.26, 0.5, 16).rotateZ(Math.PI / 2), frame, 0, 0, 0);
      const anklePos = new THREE.Vector3(0, -1.3, -0.95);
      strut(knee, new THREE.Vector3(0, 0, 0), anklePos, 0.16, frame);               // shin
      // Piston running parallel to the shin
      strut(knee, new THREE.Vector3(0, -0.15, 0.12), new THREE.Vector3(0, -1.15, -0.72), 0.05, chrome);
      part(knee, bevelBox(0.42, 0.7, 0.2, 0.06), paintDark, 0, -0.35, 0.05, 0.6);    // knee guard

      const ankle = new THREE.Group();
      ankle.position.copy(anklePos);
      knee.add(ankle);
      part(ankle, new THREE.SphereGeometry(0.2, 12, 10), frame, 0, 0, 0);
      const toeBase = new THREE.Vector3(0, -(HIP_HEIGHT - 1.25 - 1.3) + 0.08, 0.35);
      strut(ankle, new THREE.Vector3(0, 0, 0), toeBase, 0.12, paintDark);           // metatarsal
      // Toes: three forward, one back spur
      for (const [yaw, len] of [[-0.45, 0.6], [0, 0.7], [0.45, 0.6]] as const) {
        const toe = part(ankle, bevelBox(0.14, 0.12, len, 0.04), frame, toeBase.x, toeBase.y - 0.02, toeBase.z, 0, yaw, 0);
        toe.geometry.translate(0, 0, len / 2);
      }
      const spur = part(ankle, bevelBox(0.12, 0.12, 0.4, 0.04), frame, toeBase.x, toeBase.y - 0.02, toeBase.z, 0, Math.PI, 0);
      spur.geometry.translate(0, 0, 0.2);

      this.legs.push({ hip, knee, ankle, phase: sx > 0 ? 0 : Math.PI });
    }
    return hatch;
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === ReaperState.DEAD && this.stateTimer > 2.5 && this.rockets.length === 0; }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.isDead()) return false;
    // Work in model units so the hit volumes match the (scaled) mesh
    const c = this.group.position;
    const dx = (p.x - c.x) / REAPER_SCALE;
    const dz = (p.z - c.z) / REAPER_SCALE;
    const dy = (p.y - c.y) / REAPER_SCALE;
    const flat = dx * dx + dz * dz;
    // Head pod (sphere) or the legs/pelvis column below it
    const headY = this.body.position.y + 1.15; // head pod centre: body + head offset + pod offset
    const hdy = dy - headY;
    if (flat + hdy * hdy < 1.45 * 1.45) return true;
    return flat < 1.15 * 1.15 && dy > 0 && dy < headY;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    if (this.isDead()) return;
    this.health = Math.max(0, this.health - amount);
    this.flashTimer = 0.06;
    if (hitPoint && !this.lastKnownTarget) this.lastKnownTarget = hitPoint.clone();
    if (this.state === ReaperState.PATROL) this.setState(ReaperState.ENGAGE);
    if (this.health <= 0) this.setState(ReaperState.DYING);
  }

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    this.stateTimer += dt;
    const hits = this.updateRockets(ctx);

    if (this.state === ReaperState.DYING || this.state === ReaperState.DEAD) {
      this.updateDeath(ctx, hits);
      return hits;
    }

    this.salvoCooldown -= dt;
    this.tickCooldown -= dt;
    this.stompCooldown -= dt;

    const pos = this.group.position;
    const flatDist = Math.hypot(ctx.target.x - pos.x, ctx.target.z - pos.z);
    const eye = pos.clone().setY(pos.y + (HIP_HEIGHT + 1.4) * REAPER_SCALE);
    const canSee = flatDist < DETECTION_RANGE && hasLineOfSight(eye, ctx.target, ctx.worldMeshes);
    if (canSee) this.lastKnownTarget = ctx.target.clone();
    this.walking = false;

    switch (this.state) {
      case ReaperState.PATROL:
        if (canSee) {
          soundManager.playSound('titan_fire', 0.4);
          this.setState(ReaperState.ENGAGE);
          break;
        }
        if (pos.distanceTo(this.patrolTarget) < 1.5 || this.stateTimer > 8) {
          const a = Math.random() * Math.PI * 2;
          this.patrolTarget = this.spawnPos.clone().add(new THREE.Vector3(Math.cos(a) * 8, 0, Math.sin(a) * 8));
          this.stateTimer = 0;
        }
        this.walkTowards(ctx, this.patrolTarget, WALK_SPEED * 0.6);
        break;

      case ReaperState.ENGAGE: {
        const goal = this.lastKnownTarget ?? ctx.target;
        if (flatDist < STOMP_RANGE + ctx.hitbox.radius * 0.5 && this.stompCooldown <= 0) {
          this.setState(ReaperState.STOMP);
          break;
        }
        if (canSee && this.salvoCooldown <= 0 && flatDist > 8) {
          this.rocketsFired = 0;
          this.setState(ReaperState.SALVO);
          break;
        }
        if (this.tickCooldown <= 0 && this.countTicks(ctx) < MAX_TICKS_ALIVE && flatDist > 10) {
          this.ticksLaunched = 0;
          this.setState(ReaperState.LAUNCH_TICKS);
          break;
        }
        // Close to fighting range; face the target when there
        if (flatDist > PREFERRED_RANGE || !canSee) this.walkTowards(ctx, goal, WALK_SPEED);
        else this.face(goal, dt);
        break;
      }

      case ReaperState.SALVO: {
        this.face(ctx.target, dt);
        const interval = 0.18;
        while (this.rocketsFired < ROCKETS_PER_SALVO && this.stateTimer >= this.rocketsFired * interval + 0.35) {
          this.fireRocket();
          this.rocketsFired++;
        }
        if (this.stateTimer > ROCKETS_PER_SALVO * interval + 0.9) {
          this.salvoCooldown = 6 + Math.random() * 3;
          this.setState(ReaperState.ENGAGE);
        }
        break;
      }

      case ReaperState.STOMP:
        this.face(ctx.target, dt);
        // 0..0.55 raise the right foot, 0.55 slam, then recover
        if (!this.stompDone && this.stateTimer >= 0.55) {
          this.stompDone = true;
          this.stomp(ctx, hits);
        }
        if (this.stateTimer > 1.2) {
          this.stompDone = false;
          this.stompCooldown = 2.5;
          this.setState(ReaperState.ENGAGE);
        }
        break;

      case ReaperState.LAUNCH_TICKS:
        this.face(ctx.target, dt);
        if (this.ticksLaunched < 2 && this.stateTimer >= 0.5 + this.ticksLaunched * 0.35) {
          this.launchTick(ctx);
          this.ticksLaunched++;
        }
        if (this.stateTimer > 1.4) {
          this.tickCooldown = 14 + Math.random() * 4;
          this.setState(ReaperState.ENGAGE);
        }
        break;
    }

    this.animate(dt);
    return hits;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    // Rocket geometry/materials are shared; only detach
    for (const r of this.rockets) this.scene.remove(r.mesh);
    this.rockets = [];
  }

  /* ------------------------------ Actions ------------------------------ */

  private setState(state: ReaperState): void {
    this.state = state;
    this.stateTimer = 0;
  }

  private countTicks(ctx: HostileContext): number {
    return ctx.hostiles.filter((h) => h.kind === 'tick' && !h.isDead()).length;
  }

  private face(point: THREE.Vector3, dt: number): void {
    this.group.rotation.y = turnTowards(this.group.rotation.y, yawTowards(this.group.position, point), TURN_RATE * dt);
  }

  private walkTowards(ctx: HostileContext, point: THREE.Vector3, speed: number): void {
    const dt = ctx.delta;
    this.face(point, dt);
    // Walk where the body faces (heavy machines turn, then walk)
    const yaw = this.group.rotation.y;
    const facing = Math.abs(Math.atan2(Math.sin(yawTowards(this.group.position, point) - yaw), Math.cos(yawTowards(this.group.position, point) - yaw)));
    if (facing > 0.8) return;
    const step = speed * dt;
    const ok = tryMoveHorizontal(this.group, Math.sin(yaw) * step, Math.cos(yaw) * step, ctx.worldMeshes, 1.1 * REAPER_SCALE, [0.6 * REAPER_SCALE, 2.2 * REAPER_SCALE]);
    this.walking = ok;
    // Shorter legs take quicker strides for the same ground speed
    if (ok) this.gait += (dt * speed * 1.6) / REAPER_SCALE;
  }

  private fireRocket(): void {
    this.group.updateMatrixWorld(true);
    const local = this.podMuzzles[this.rocketsFired % this.podMuzzles.length];
    const start = this.head.localToWorld(local.clone());
    const forward = new THREE.Vector3(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
    // Launch up and out, then home in
    const velocity = forward.multiplyScalar(0.7).add(new THREE.Vector3(0, 0.7, 0))
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4))
      .normalize().multiplyScalar(ROCKET_SPEED);

    const mesh = new THREE.Group();
    const body = new THREE.Mesh(rocketBodyGeo, rocketBodyMat);
    const nose = new THREE.Mesh(rocketNoseGeo, rocketNoseMat);
    const flame = new THREE.Mesh(rocketFlameGeo, rocketFlameMat);
    for (const m of [body, nose, flame]) m.userData.ignoreRaycast = true;
    mesh.add(body, nose, flame);
    mesh.scale.setScalar(REAPER_SCALE * 1.4);
    mesh.position.copy(start);
    mesh.userData.ignoreRaycast = true;
    this.scene.add(mesh);
    this.rockets.push({ mesh, velocity, age: 0 });
    flashLight(start, 0xffa040, 10, 8, 0.1);
    soundManager.playSound('grenade_fire', 0.35);
  }

  private updateRockets(ctx: HostileContext): HostileHit[] {
    const hits: HostileHit[] = [];
    const raycaster = new THREE.Raycaster();
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.age += ctx.delta;
      if (r.age < ROCKET_HOMING_TIME) {
        const desired = ctx.hitbox.center.clone().sub(r.mesh.position);
        r.velocity.copy(steerTowards(r.velocity, desired, ROCKET_TURN_RATE * ctx.delta));
      }
      const speed = Math.min(ROCKET_MAX_SPEED, r.velocity.length() + 18 * ctx.delta);
      r.velocity.setLength(speed);

      const prev = r.mesh.position.clone();
      r.mesh.position.addScaledVector(r.velocity, ctx.delta);
      r.mesh.lookAt(r.mesh.position.clone().add(r.velocity));

      const step = r.mesh.position.clone().sub(prev);
      const len = step.length();
      let impact: THREE.Vector3 | null = null;
      if (len > 1e-6) {
        raycaster.set(prev, step.clone().divideScalar(len));
        raycaster.far = len;
        const wall = raycaster.intersectObjects(ctx.worldMeshes, false)[0];
        const end = wall ? wall.point : r.mesh.position;
        if (segmentIntersectsSphere(prev, end, ctx.hitbox.center, ctx.hitbox.radius)) {
          impact = r.mesh.position.clone();
          hits.push({ damage: ROCKET_DAMAGE, source: this.group.position.clone() });
        } else if (wall) {
          impact = wall.point.clone();
          const d = Math.max(0, impact.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius);
          const dmg = splashDamage(ROCKET_DAMAGE, d, ROCKET_SPLASH);
          if (dmg > 0) hits.push({ damage: dmg, source: impact.clone() });
        }
      }
      if (!impact && (r.age > 5 || r.mesh.position.y < -1)) impact = r.mesh.position.clone();

      if (impact) {
        ctx.effects.spawnExplosion(impact, EPG_EXPLOSION_CONFIG);
        flashLight(impact, 0xff7030, 30, 10, 0.25);
        soundManager.playSound('explosion', 0.35);
        this.scene.remove(r.mesh);
        this.rockets.splice(i, 1);
      }
    }
    return hits;
  }

  private stomp(ctx: HostileContext, hits: HostileHit[]): void {
    this.group.updateMatrixWorld(true);
    const foot = this.group.localToWorld(new THREE.Vector3(0.85, 0, 1.3));
    ctx.effects.spawnExplosion(foot.clone().setY(0.2), { ...FRAG_EXPLOSION_CONFIG, coreColor: 0xbba888, debrisColor: 0x887766, shockwaveColor: 0xddccaa });
    soundManager.playSound('explosion', 0.5);
    const d = Math.max(0, Math.hypot(ctx.hitbox.center.x - foot.x, ctx.hitbox.center.z - foot.z) - ctx.hitbox.radius);
    // Only things near the ground get stomped (not a titan's torso)
    if (ctx.hitbox.center.y < 2 + ctx.hitbox.radius) {
      const dmg = splashDamage(STOMP_DAMAGE, d, STOMP_RADIUS);
      if (dmg > 0) hits.push({ damage: dmg, source: foot });
    }
  }

  private launchTick(ctx: HostileContext): void {
    this.group.updateMatrixWorld(true);
    const start = this.hatch.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.3, 0));
    // Lob towards the target with a little scatter: solve for a ~1.1 s flight
    const target = ctx.target.clone().setY(0);
    const toTarget = target.sub(start).setY(0);
    const dist = Math.min(22, toTarget.length());
    const flight = 1.1;
    const dir = toTarget.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar((Math.random() - 0.5) * 4);
    const horizontal = dir.multiplyScalar(dist / flight).add(side);
    const vy = (0 - start.y + 0.5 * 22 * flight * flight) / flight;
    ctx.spawn(new Tick(this.scene, start, new THREE.Vector3(horizontal.x, vy, horizontal.z)));
    soundManager.playSound('grenade_fire', 0.4);
  }

  /* ----------------------------- Animation ----------------------------- */

  private animate(dt: number): void {
    // Gait: hips swing, knees lift on the forward swing, ankles counter-rotate
    for (const leg of this.legs) {
      const s = Math.sin(this.gait + leg.phase);
      const lift = Math.max(0, Math.cos(this.gait + leg.phase));
      const w = this.walking ? 1 : 0;
      leg.hip.rotation.x = THREE.MathUtils.lerp(leg.hip.rotation.x, w * s * 0.32, 0.25);
      leg.knee.rotation.x = THREE.MathUtils.lerp(leg.knee.rotation.x, w * -lift * 0.45, 0.25);
      leg.ankle.rotation.x = THREE.MathUtils.lerp(leg.ankle.rotation.x, -(leg.hip.rotation.x + leg.knee.rotation.x) * 0.8, 0.5);
    }
    // Body bob / sway while walking
    const bob = this.walking ? Math.abs(Math.sin(this.gait)) * 0.12 : 0;
    this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, HIP_HEIGHT + bob, 0.2);
    this.head.rotation.z = this.walking ? Math.sin(this.gait) * 0.03 : this.head.rotation.z * 0.9;

    // Stomp: raise the right leg, slam it down
    if (this.state === ReaperState.STOMP) {
      const leg = this.legs[1];
      const t = this.stateTimer;
      const raise = t < 0.55 ? Math.sin((t / 0.55) * Math.PI * 0.5) : Math.max(0, 1 - (t - 0.55) * 8);
      leg.hip.rotation.x = -0.55 * raise;
      leg.knee.rotation.x = 0.9 * raise;
      leg.ankle.rotation.x = -0.35 * raise;
      this.body.position.y = HIP_HEIGHT - 0.25 * raise;
    }
    // Salvo: pods recoil
    this.head.rotation.x = this.state === ReaperState.SALVO ? -0.12 : this.head.rotation.x * 0.9;

    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flashMat.opacity = this.flashTimer > 0 ? 0.35 : 0;
    const hurt = 1 - this.health / this.maxHealth;
    // Visor flickers once badly damaged
    const flicker = hurt > 0.7 && Math.random() < 0.15 ? 0.4 : 1;
    this.visorMat.color.setHex(0xff2a14).multiplyScalar(3 * flicker);
  }

  private updateDeath(ctx: HostileContext, hits: HostileHit[]): void {
    const dt = ctx.delta;
    if (this.state === ReaperState.DYING) {
      // Knees buckle and the body sinks, sparking, then it blows
      const t = Math.min(1, this.stateTimer / 1.2);
      for (const leg of this.legs) {
        leg.hip.rotation.x = -0.6 * t;
        leg.knee.rotation.x = 0.9 * t;
      }
      this.body.position.y = HIP_HEIGHT - 1.4 * t;
      this.head.rotation.x = 0.35 * t;
      this.visorMat.color.setHex(0xff2a14).multiplyScalar(Math.random() < 0.5 ? 0.2 : 3);
      if (Math.random() < dt * 6) {
        const p = this.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2));
        ctx.effects.spawnImpact(p, new THREE.Vector3(0, 1, 0), { ...EPG_EXPLOSION_IMPACT });
      }
      if (this.stateTimer >= 1.2) {
        this.setState(ReaperState.DEAD);
        this.blowUp(ctx, hits);
      }
    }
  }

  private blowUp(ctx: HostileContext, hits: HostileHit[]): void {
    if (this.exploded) return;
    this.exploded = true;
    const center = this.head.getWorldPosition(new THREE.Vector3());
    ctx.effects.spawnExplosion(center, { ...FRAG_EXPLOSION_CONFIG, coreRadius: 1.0, debrisCount: 32, debrisSpeedMax: 26 });
    flashLight(center, 0xff6622, 120, 25, 0.6);
    soundManager.playSound('explosion', 0.9);
    const d = Math.max(0, center.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius);
    const dmg = splashDamage(45, d, 5);
    if (dmg > 0) hits.push({ damage: dmg, source: center });
    this.group.visible = false;
  }
}

/** Sparks spat out by a dying reaper. */
const EPG_EXPLOSION_IMPACT = {
  flashInnerRadius: 0.1,
  flashOuterRadius: 0.4,
  flashSegments: 12,
  flashColor: 0xffaa55,
  flashOpacity: 0.9,
  flashLife: 0.12,
  flashNormalOffset: 0.02,
  sparkColor: 0xffcc66,
  sparkMinSize: 0.03,
  sparkMaxSize: 0.08,
  sparkCountMin: 6,
  sparkCountMax: 10,
  sparkSpeedMin: 4,
  sparkSpeedMax: 12,
  sparkGravity: -18,
  sparkLifeMin: 0.2,
  sparkLifeMax: 0.5,
  sparkMaxLife: 0.5,
};

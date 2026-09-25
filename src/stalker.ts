import * as THREE from 'three';
import { soundManager } from './sound';
import { splashDamage } from './collision';
import { bevelBox, mergeAndDispose } from './geometryUtils';
import { DEFAULT_MUZZLE_CONFIG, FRAG_EXPLOSION_CONFIG } from './effects';
import { flashLight } from './graphics';
import { HostileGun, applySpread } from './hostileWeapons';
import {
  CloakController, Hostile, HostileContext, HostileHit, hasLineOfSight, leadTarget,
  tryMoveHorizontal, turnTowards, yawTowards,
} from './hostile';

/*
 * Stalker: a skeletal IMC combat robot. Stands powered down until it spots
 * the pilot, then walks at them relentlessly, firing bursts on the move. It
 * never takes cover. The glowing reactor in its chest is a weak point, and
 * shooting its legs off leaves it crawling (and still shooting). When it
 * dies the reactor overloads and blows a moment later.
 */

export enum StalkerState {
  DORMANT,
  ACTIVATING,
  ADVANCE,
  CRAWL,
  OVERLOAD,
  DEAD,
}

const MAX_HEALTH = 130;
const LEG_HEALTH = 55;
const DETECTION_RANGE = 36;
const FIRE_RANGE = 30;
const HOLD_RANGE = 7;
const WALK_SPEED = 1.7;
const CRAWL_SPEED = 0.8;
const RADIUS = 0.4;
const MOVE_PROBES = [0.4, 1.3] as const;
const CRAWL_PROBES = [0.3] as const;
const HIP_HEIGHT = 1.02;
const HEIGHT = 2.15;
const THIGH = 0.54;
const SHIN = 0.54;
const CORE_RADIUS = 0.24;
const BULLET_SPEED = 55;
const BURST = 3;
const BURST_INTERVAL = 0.11;
const OVERLOAD_TIME = 0.9;
const BLAST_RADIUS = 4;
const BLAST_DAMAGE = 35;
const WAKE_RADIUS = 25;

const STALKER_BULLET_VISUALS = {
  meshType: 'sphere' as const,
  color: 0xff3322,
  radius: 0.045,
  length: 0,
  hasTrail: true,
  trailColor: 0xff5533,
  trailLength: 12,
  gravity: -8,
  maxLifetime: 3,
  explosive: false,
  splashRadius: 0,
};

interface StalkerLeg {
  hip: THREE.Group;
  knee: THREE.Group;
  side: number;
}

export class Stalker implements Hostile {
  readonly kind = 'stalker' as const;
  readonly scoreValue = 150;
  readonly group: THREE.Group;
  health = MAX_HEALTH;
  state = StalkerState.DORMANT;

  private readonly scene: THREE.Scene;
  private readonly pelvis: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly head: THREE.Group;
  private readonly legs: StalkerLeg[] = [];
  private readonly core: THREE.Mesh;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly flashMat: THREE.MeshBasicMaterial;
  /** Rifle muzzle in torso space. */
  private readonly muzzleLocal = new THREE.Vector3(-0.12, 0.44, 1.04);
  private readonly gun: HostileGun;
  private readonly cloak: CloakController;

  private stateTimer = 0;
  private legDamage = 0;
  private crippled = false;
  private gait = Math.random() * 10;
  private moving = false;
  private lastKnownTarget: THREE.Vector3 | null = null;
  private burstLeft = 0;
  private burstTimer = 0;
  private burstCooldown = 1 + Math.random();
  private flashTimer = 0;
  private detourSign = Math.random() < 0.5 ? 1 : -1;
  private deathAxis = new THREE.Vector3(1, 0, 0);
  private deathYaw = 0;
  private exploded = false;

  constructor(scene: THREE.Scene, position: THREE.Vector3, options: { active?: boolean } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = Math.random() * Math.PI * 2;

    this.pelvis = new THREE.Group();
    this.pelvis.position.y = HIP_HEIGHT;
    this.group.add(this.pelvis);
    this.torso = new THREE.Group();
    this.torso.position.y = 0.1;
    this.pelvis.add(this.torso);
    this.head = new THREE.Group();
    this.head.position.set(0, 0.78, 0.02);
    this.torso.add(this.head);

    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5a1a).multiplyScalar(3) });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2412).multiplyScalar(4) });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.core = this.buildModel();

    this.gun = new HostileGun(scene, {
      visuals: STALKER_BULLET_VISUALS,
      damage: (titan) => (titan ? 3 : 6),
    });
    this.cloak = new CloakController(this.group);
    if (options.active) this.setState(StalkerState.ADVANCE);
    else this.poseDormant(1);
    scene.add(this.group);
  }

  /* ------------------------------ Model ------------------------------- */

  private buildModel(): THREE.Mesh {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, metalness: 0.85, roughness: 0.35 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xa9adb0, metalness: 0.45, roughness: 0.4 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xb8401c, metalness: 0.35, roughness: 0.5 });
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x111316, metalness: 0.3, roughness: 0.8 });

    type Parts = Map<THREE.Material, THREE.BufferGeometry[]>;
    const add = (parts: Parts, mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      geo.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ));
      const list = parts.get(mat) ?? [];
      list.push(geo);
      parts.set(mat, list);
    };
    const strut = (parts: Parts, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number) => {
      const dir = b.clone().sub(a);
      const geo = new THREE.CapsuleGeometry(r, Math.max(0.01, dir.length() - r * 2), 3, 8);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      geo.translate(mid.x, mid.y, mid.z);
      add(parts, mat, geo);
    };
    const flush = (parts: Parts, parent: THREE.Object3D) => {
      for (const [mat, geos] of parts) {
        const merged = mergeAndDispose(geos);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      parts.clear();
    };
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const parts: Parts = new Map();

    // --- Pelvis: hip block and a waist actuator ---
    add(parts, frameMat, bevelBox(0.36, 0.16, 0.22, 0.04));
    add(parts, plateMat, bevelBox(0.3, 0.1, 0.08, 0.02), 0, -0.02, 0.13, -0.15);
    add(parts, frameMat, new THREE.CylinderGeometry(0.07, 0.09, 0.16, 10), 0, 0.12, 0);
    flush(parts, this.pelvis);

    // --- Torso: exposed spine, rib cage around the reactor, armoured shoulders ---
    strut(parts, frameMat, v(0, 0.05, -0.06), v(0, 0.62, -0.1), 0.05);                  // spine
    for (let i = 0; i < 4; i++) {
      const y = 0.18 + i * 0.12;
      const w = 0.2 + Math.sin((i + 1) / 5 * Math.PI) * 0.06;
      for (const sx of [-1, 1]) strut(parts, frameMat, v(0, y, -0.1), v(sx * w, y + 0.02, 0.08), 0.016); // ribs
    }
    add(parts, plateMat, bevelBox(0.5, 0.2, 0.26, 0.05), 0, 0.64, -0.02);              // collar plate
    add(parts, plateMat, bevelBox(0.18, 0.28, 0.05, 0.02), 0, 0.28, -0.2);             // back plate
    add(parts, accentMat, bevelBox(0.05, 0.22, 0.02, 0.01), 0, 0.3, -0.23);           // back stripe
    for (const sx of [-1, 1]) {
      add(parts, plateMat, bevelBox(0.2, 0.14, 0.26, 0.04), sx * 0.32, 0.66, 0, 0, 0, sx * -0.3); // pauldrons
      add(parts, accentMat, bevelBox(0.16, 0.03, 0.22, 0.01), sx * 0.34, 0.73, 0, 0, 0, sx * -0.3);
      strut(parts, cableMat, v(sx * 0.06, 0.1, -0.1), v(sx * 0.16, 0.5, -0.06), 0.012);  // cables
    }
    // Reactor housing ring (the glowing core sits inside it)
    const ring = new THREE.TorusGeometry(0.15, 0.03, 8, 20);
    add(parts, frameMat, ring, 0, 0.36, 0.02);

    // Arms: holding the rifle across the body, right hand on the grip, left on the foregrip
    const shoulderR = v(-0.3, 0.6, 0.02);
    const shoulderL = v(0.3, 0.6, 0.02);
    const elbowR = v(-0.36, 0.3, 0.0);
    const elbowL = v(0.2, 0.3, 0.24);
    const gripR = v(-0.12, 0.32, 0.14);
    const gripL = v(-0.04, 0.36, 0.5);
    for (const [s, e, g] of [[shoulderR, elbowR, gripR], [shoulderL, elbowL, gripL]] as const) {
      strut(parts, frameMat, s, e, 0.04);
      strut(parts, frameMat, e, g, 0.035);
      add(parts, plateMat, new THREE.SphereGeometry(0.055, 10, 8), e.x, e.y, e.z);
      add(parts, plateMat, bevelBox(0.09, 0.1, 0.1, 0.02), g.x, g.y - 0.02, g.z);  // hands
    }
    // Rifle: boxy IMC carbine, stock tucked into the right shoulder
    const gx = -0.12;
    add(parts, cableMat, bevelBox(0.07, 0.12, 0.62, 0.02), gx, 0.42, 0.26);
    add(parts, cableMat, bevelBox(0.06, 0.1, 0.16, 0.02), gx, 0.4, -0.1);             // stock
    add(parts, frameMat, bevelBox(0.05, 0.07, 0.26, 0.015), gx, 0.44, 0.66);
    add(parts, frameMat, new THREE.CylinderGeometry(0.018, 0.018, 0.26, 8), gx, 0.44, 0.9, Math.PI / 2);
    add(parts, cableMat, bevelBox(0.05, 0.16, 0.08, 0.015), gx, 0.3, 0.32, 0.3);        // magazine
    add(parts, cableMat, bevelBox(0.04, 0.1, 0.05, 0.01), gx, 0.33, 0.14, -0.3);        // pistol grip
    add(parts, accentMat, bevelBox(0.04, 0.03, 0.18, 0.01), gx, 0.49, 0.3);
    flush(parts, this.torso);

    // --- Head: narrow sensor skull with a single slit eye ---
    add(parts, plateMat, bevelBox(0.2, 0.2, 0.26, 0.05), 0, 0.08, 0);
    add(parts, frameMat, bevelBox(0.22, 0.06, 0.22, 0.02), 0, -0.02, -0.01);
    add(parts, frameMat, new THREE.CylinderGeometry(0.04, 0.05, 0.14, 8), 0, -0.08, -0.02);
    add(parts, accentMat, bevelBox(0.04, 0.05, 0.22, 0.01), 0, 0.2, -0.01);
    flush(parts, this.head);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.02), this.eyeMat);
    eye.position.set(0, 0.1, 0.135);
    this.head.add(eye);

    // --- Reactor core: weak point ---
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), this.coreMat);
    core.position.set(0, 0.36, 0.02);
    this.torso.add(core);

    // Hit flash shell
    const flash = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.9, 0.4), this.flashMat);
    flash.position.set(0, 0.38, 0.02);
    this.torso.add(flash);

    // --- Legs: digitigrade-ish, hip → knee → ankle, with hydraulic pistons ---
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.15, 0, 0);
      this.pelvis.add(hip);
      add(parts, frameMat, new THREE.SphereGeometry(0.07, 10, 8));
      strut(parts, frameMat, v(0, 0, 0), v(0, -THIGH, 0), 0.05);
      add(parts, plateMat, bevelBox(0.13, 0.3, 0.1, 0.03), 0, -0.22, 0.05);           // thigh plate
      strut(parts, cableMat, v(side * 0.05, -0.08, -0.05), v(side * 0.04, -0.42, -0.06), 0.018); // piston
      flush(parts, hip);

      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      hip.add(knee);
      add(parts, plateMat, new THREE.SphereGeometry(0.06, 10, 8));
      strut(parts, frameMat, v(0, 0, 0), v(0, -SHIN, 0), 0.04);
      add(parts, plateMat, bevelBox(0.1, 0.28, 0.07, 0.02), 0, -0.2, 0.05);            // shin guard
      add(parts, accentMat, bevelBox(0.06, 0.04, 0.075, 0.01), 0, -0.08, 0.06);
      add(parts, frameMat, bevelBox(0.13, 0.05, 0.28, 0.02), 0, -SHIN - 0.01, 0.06);   // foot
      add(parts, frameMat, bevelBox(0.05, 0.04, 0.08, 0.01), 0, -SHIN - 0.02, -0.1);   // heel spur
      flush(parts, knee);
      this.legs.push({ hip, knee, side });
    }
    return core;
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === StalkerState.DEAD && this.stateTimer > 2.5 && this.gun.inFlight === 0; }
  refreshCloak(): void { if (!this.isDead()) this.cloak.refresh(); }
  isCloaked(): boolean { return this.cloak.engaged; }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.state === StalkerState.DEAD || this.state === StalkerState.OVERLOAD) return false;
    const pos = this.group.position;
    if (this.crippled) {
      // Lying on its front: a low blob reaching forward of the hips
      const fwd = new THREE.Vector3(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
      const c = pos.clone().addScaledVector(fwd, 0.45).setY(pos.y + 0.35);
      return p.distanceToSquared(c) < 0.62 * 0.62;
    }
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const dy = p.y - pos.y;
    return dx * dx + dz * dz < 0.42 * 0.42 && dy > 0 && dy < HEIGHT;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    if (this.isDead()) return;
    let dmg = amount;
    if (hitPoint) {
      const corePos = this.core.getWorldPosition(new THREE.Vector3());
      if (hitPoint.distanceTo(corePos) < CORE_RADIUS) {
        dmg *= 2; // reactor hit
        this.coreFlicker = 0.25;
      } else if (!this.crippled && hitPoint.y - this.group.position.y < HIP_HEIGHT - 0.05) {
        this.legDamage += amount;
      }
      if (!this.lastKnownTarget) this.lastKnownTarget = hitPoint.clone();
    }
    this.health = Math.max(0, this.health - dmg);
    this.flashTimer = 0.08;
    if (this.state === StalkerState.DORMANT) this.setState(StalkerState.ACTIVATING);

    if (this.health <= 0) {
      this.setState(StalkerState.OVERLOAD);
      soundManager.playSound('overload', 0.35);
      return;
    }
    if (!this.crippled && this.legDamage >= LEG_HEALTH) this.cripple(hitPoint);
  }

  private coreFlicker = 0;

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    this.stateTimer += dt;
    const hits = this.gun.update(ctx, this.group.position, this);
    this.cloak.update(dt);
    this.moving = false;

    const pos = this.group.position;
    const dist = pos.distanceTo(ctx.target);
    const eye = this.head.getWorldPosition(new THREE.Vector3());
    const canSee = this.state !== StalkerState.DEAD && dist < DETECTION_RANGE * 1.3 && hasLineOfSight(eye, ctx.target, ctx.worldMeshes);
    if (canSee) this.lastKnownTarget = ctx.target.clone();

    switch (this.state) {
      case StalkerState.DORMANT:
        this.poseDormant(1);
        if (canSee && dist < DETECTION_RANGE) {
          this.setState(StalkerState.ACTIVATING);
          this.wakePack(ctx);
        }
        break;

      case StalkerState.ACTIVATING: {
        // Power up: straighten, head snaps up, core brightens
        const t = THREE.MathUtils.clamp(this.stateTimer / 0.8, 0, 1);
        this.poseDormant(1 - t);
        this.face(this.lastKnownTarget ?? ctx.target, dt, 3);
        if (t >= 1) {
          soundManager.playSound('power_up', 0.2);
          this.setState(StalkerState.ADVANCE);
        }
        break;
      }

      case StalkerState.ADVANCE:
      case StalkerState.CRAWL: {
        const crawling = this.state === StalkerState.CRAWL;
        const goal = this.lastKnownTarget ?? ctx.target;
        this.face(goal, dt, crawling ? 1.5 : 3.5);
        const firing = this.burstLeft > 0;
        const speed = crawling ? CRAWL_SPEED : firing ? WALK_SPEED * 0.5 : WALK_SPEED;
        if (pos.distanceTo(goal) > HOLD_RANGE || !canSee) this.walkTowards(ctx, goal, speed, crawling);
        if (canSee && dist < FIRE_RANGE) this.updateWeapon(ctx, dist);
        else this.burstLeft = 0;
        break;
      }

      case StalkerState.OVERLOAD: {
        // Reactor goes critical: shake, flicker faster and faster, then blow
        const shake = 0.03 * (this.stateTimer / OVERLOAD_TIME);
        this.torso.position.x = (Math.random() - 0.5) * shake;
        this.coreFlicker = Math.sin(this.stateTimer * (20 + this.stateTimer * 60)) > 0 ? 0.2 : 0;
        if (this.stateTimer >= OVERLOAD_TIME && !this.exploded) {
          hits.push(...this.explode(ctx));
          this.enterDeath(ctx.target);
        }
        break;
      }

      case StalkerState.DEAD:
        this.updateDeath(dt);
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
    this.gun.dispose();
  }

  /* ------------------------------ Brain ------------------------------- */

  private setState(state: StalkerState): void {
    this.state = state;
    this.stateTimer = 0;
  }

  /** Stalkers activate as a pack: waking one wakes the dormant ones around it. */
  private wakePack(ctx: HostileContext): void {
    for (const other of ctx.hostiles) {
      if (other === this || !(other instanceof Stalker) || other.state !== StalkerState.DORMANT) continue;
      if (other.group.position.distanceTo(this.group.position) < WAKE_RADIUS) {
        other.lastKnownTarget = ctx.target.clone();
        other.setState(StalkerState.ACTIVATING);
        other.stateTimer = -Math.random() * 0.6; // stagger the power-up
      }
    }
  }

  private cripple(hitPoint?: THREE.Vector3): void {
    this.crippled = true;
    for (const leg of this.legs) leg.hip.visible = false;
    this.burstLeft = 0;
    this.setState(StalkerState.CRAWL);
    soundManager.playSound('explosion', 0.25);
    const at = hitPoint ?? this.group.position.clone().setY(this.group.position.y + 0.6);
    flashLight(at, 0xffaa55, 20, 5, 0.15);
  }

  private walkTowards(ctx: HostileContext, goal: THREE.Vector3, speed: number, crawling: boolean): void {
    const pos = this.group.position;
    const to = goal.clone().sub(pos).setY(0);
    const len = to.length();
    if (len < 0.05) return;
    to.divideScalar(len);
    const step = Math.min(len, speed * ctx.delta);
    const probes = crawling ? CRAWL_PROBES : MOVE_PROBES;
    // Straight at the target; if blocked, try progressively wider detours to one side
    for (const angle of [0, 0.6, 1.2, 1.7]) {
      const dir = to.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle * this.detourSign);
      if (tryMoveHorizontal(this.group, dir.x * step, dir.z * step, ctx.worldMeshes, RADIUS, probes)) {
        this.moving = true;
        return;
      }
    }
    this.detourSign *= -1;
  }

  private face(point: THREE.Vector3, dt: number, rate: number): void {
    this.group.rotation.y = turnTowards(this.group.rotation.y, yawTowards(this.group.position, point), rate * dt);
  }

  /* ------------------------------ Weapon ------------------------------ */

  private updateWeapon(ctx: HostileContext, dist: number): void {
    const dt = ctx.delta;
    // Only fire roughly facing the target
    const facing = Math.abs(Math.atan2(
      Math.sin(yawTowards(this.group.position, ctx.target) - this.group.rotation.y),
      Math.cos(yawTowards(this.group.position, ctx.target) - this.group.rotation.y),
    ));
    if (this.burstLeft > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0 && facing < 0.5) {
        this.shoot(ctx, dist);
        this.burstLeft--;
        this.burstTimer = BURST_INTERVAL;
        if (this.burstLeft === 0) this.burstCooldown = 1.5 + Math.random() * 0.9;
      }
    } else {
      this.burstCooldown -= dt;
      if (this.burstCooldown <= 0) {
        this.burstLeft = BURST;
        this.burstTimer = 0;
      }
    }
  }

  private shoot(ctx: HostileContext, dist: number): void {
    this.group.updateMatrixWorld();
    const muzzle = this.torso.localToWorld(this.muzzleLocal.clone());
    // Robots lead well but aren't perfect: spread grows with distance and while crawling
    const aim = leadTarget(muzzle, ctx.target, ctx.targetVelocity, BULLET_SPEED).lerp(ctx.target, 0.3);
    const dir = aim.sub(muzzle).normalize();
    applySpread(dir, THREE.MathUtils.degToRad((this.crippled ? 6 : 4) + dist * 0.05));
    this.gun.fire(muzzle, dir.multiplyScalar(BULLET_SPEED));
    ctx.effects.spawnMuzzleFlash(muzzle, dir.clone().normalize(), { ...DEFAULT_MUZZLE_CONFIG, color: 0xff6a33, radius: 0.09 });
    soundManager.playSound('enemy_fire', 0.28);
  }

  /* ---------------------------- Death ---------------------------- */

  private explode(ctx: HostileContext): HostileHit[] {
    this.exploded = true;
    const center = this.core.getWorldPosition(new THREE.Vector3());
    ctx.effects.spawnExplosion(center, FRAG_EXPLOSION_CONFIG);
    flashLight(center, 0xff6622, 55, 12, 0.3);
    soundManager.playSound('explosion', 0.5);
    this.coreMat.color.setRGB(0.05, 0.05, 0.05);
    this.eyeMat.color.setRGB(0.05, 0.02, 0.02);

    const hits: HostileHit[] = [];
    const d = splashDamage(BLAST_DAMAGE, Math.max(0, center.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius), BLAST_RADIUS);
    if (d > 0) hits.push({ damage: d, source: center });
    for (const other of ctx.hostiles) {
      if (other === this || other.isDead()) continue;
      const od = splashDamage(BLAST_DAMAGE, center.distanceTo(other.group.position), BLAST_RADIUS);
      if (od > 0) other.takeDamage(od, center);
    }
    return hits;
  }

  private enterDeath(from: THREE.Vector3): void {
    this.setState(StalkerState.DEAD);
    this.torso.position.x = 0;
    this.deathYaw = this.group.rotation.y;
    const away = this.group.position.clone().sub(from).setY(0);
    if (away.lengthSq() < 1e-6) away.set(0, 0, -1);
    away.normalize();
    this.deathAxis.set(0, 1, 0).cross(away).normalize();
  }

  private updateDeath(dt: number): void {
    if (this.crippled) {
      if (this.stateTimer > 1.5) this.group.position.y -= dt * 0.5;
      return;
    }
    const fall = Math.min(1, this.stateTimer / 0.6);
    this.group.quaternion.setFromAxisAngle(this.deathAxis, fall * fall * (Math.PI / 2 - 0.12))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.deathYaw));
    if (this.stateTimer > 1.5) this.group.position.y -= dt * 0.6;
  }

  /* ---------------------------- Animation ----------------------------- */

  /** 1 = fully powered down (slumped), 0 = standing ready. */
  private poseDormant(k: number): void {
    this.torso.rotation.x = 0.35 * k;
    this.head.rotation.x = 0.6 * k;
    this.pelvis.position.y = HIP_HEIGHT - 0.08 * k;
    for (const leg of this.legs) {
      leg.hip.rotation.x = -0.35 * k - 0.12;
      leg.knee.rotation.x = 0.7 * k + 0.24;
    }
    const glow = 0.4 + (1 - k) * 2.6;
    this.coreMat.color.set(0xff5a1a).multiplyScalar(glow);
    this.eyeMat.color.set(0xff2412).multiplyScalar(0.3 + (1 - k) * 3.7);
  }

  private animate(dt: number): void {
    if (this.state === StalkerState.ADVANCE || this.state === StalkerState.OVERLOAD) {
      // Mechanical gait: long stride, stiff torso with a slight counter-sway
      if (this.moving) this.gait += dt * 5.5;
      const s = this.moving ? Math.sin(this.gait) : 0;
      for (const leg of this.legs) {
        const phase = leg.side > 0 ? 0 : Math.PI;
        const swing = this.moving ? Math.sin(this.gait + phase) : 0;
        leg.hip.rotation.x = -0.12 - swing * 0.45;
        leg.knee.rotation.x = 0.24 + (this.moving ? Math.max(0, Math.cos(this.gait + phase)) * 0.75 : 0);
      }
      this.pelvis.position.y = HIP_HEIGHT - 0.05 + Math.abs(s) * 0.04;
      this.pelvis.rotation.z = s * 0.04;
      this.torso.rotation.x = 0.06;
      this.torso.rotation.y = -s * 0.08;
      this.head.rotation.x = 0;
    } else if (this.state === StalkerState.CRAWL || (this.state === StalkerState.DEAD && this.crippled)) {
      // Legless: lying face down, dragging itself along on the elbows
      if (this.moving) this.gait += dt * 4;
      this.pelvis.position.y = 0.28;
      this.pelvis.rotation.x = 0;
      this.torso.rotation.x = Math.PI / 2 - 0.25 + (this.moving ? Math.sin(this.gait) * 0.08 : 0);
      this.torso.position.y = 0.05;
      this.head.rotation.x = -1.1;
    }

    // Core pulses; hit flash
    if (this.state !== StalkerState.DORMANT && this.state !== StalkerState.ACTIVATING && !this.exploded) {
      this.coreFlicker = Math.max(0, this.coreFlicker - dt);
      const pulse = 2.6 + Math.sin(this.stateTimer * 4) * 0.4 + (this.coreFlicker > 0 ? 5 : 0);
      this.coreMat.color.set(0xff5a1a).multiplyScalar(pulse);
    }
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flashMat.opacity = this.flashTimer * 5;
  }
}

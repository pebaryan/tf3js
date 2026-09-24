import * as THREE from 'three';
import { soundManager } from './sound';
import { splashDamage } from './collision';
import { bevelBox, mergeAndDispose } from './geometryUtils';
import { FRAG_EXPLOSION_CONFIG } from './effects';
import { flashLight } from './graphics';
import { Hostile, HostileContext, HostileHit, hasLineOfSight, tryMoveHorizontal, turnTowards, yawTowards } from './hostile';

/*
 * Tick (frag drone): a four-legged suicide drone. Dormant until it sees the
 * pilot, then scuttles at them in a weave, arms with an accelerating beep and
 * detonates. It also detonates when destroyed, so shooting one next to you
 * still hurts. Reapers launch ticks in a ballistic arc.
 */

export enum TickState {
  DORMANT,
  WAKING,
  LAUNCHED,
  CHASE,
  ARMING,
  EXPLODED,
}

const DETECTION_RANGE = 28;
const SPEED = 7.5;
const TRIGGER_RANGE = 2.6;
const ARM_TIME = 0.55;
const BLAST_RADIUS = 5.5;
const BLAST_DAMAGE = 70;
const BODY_HEIGHT = 0.38;
const GRAVITY = -22;

export const TICK_BLAST_RADIUS = BLAST_RADIUS;
export const TICK_BLAST_DAMAGE = BLAST_DAMAGE;

interface TickLeg {
  pivot: THREE.Group;
  baseYaw: number;
  phase: number;
}

export class Tick implements Hostile {
  readonly kind = 'tick' as const;
  /** Only a tick destroyed by the player is worth points; one that reaches you and detonates isn't a kill. */
  get scoreValue(): number { return this.selfDetonated ? 0 : 50; }
  private selfDetonated = false;
  readonly group: THREE.Group;
  health = 30;
  state: TickState;

  private readonly scene: THREE.Scene;
  private readonly body: THREE.Group;
  private readonly legs: TickLeg[] = [];
  private readonly glow: THREE.MeshBasicMaterial;
  private readonly glowColor = new THREE.Color(0xff2a14);
  private readonly velocity = new THREE.Vector3();
  private stateTimer = 0;
  private gait = Math.random() * 10;
  private weaveSeed = Math.random() * 10;
  private beepTimer = 0;
  private flashTimer = 0;

  constructor(scene: THREE.Scene, position: THREE.Vector3, launchVelocity?: THREE.Vector3) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = Math.random() * Math.PI * 2;

    this.body = new THREE.Group();
    this.body.position.y = BODY_HEIGHT;
    this.group.add(this.body);
    this.glow = new THREE.MeshBasicMaterial({ color: this.glowColor.clone().multiplyScalar(2) });
    this.buildModel();

    if (launchVelocity) {
      this.state = TickState.LAUNCHED;
      this.velocity.copy(launchVelocity);
    } else {
      this.state = TickState.DORMANT;
      this.group.position.y = 0;
    }
    scene.add(this.group);
  }

  private buildModel(): void {
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.7, roughness: 0.35 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x8c2a1e, metalness: 0.4, roughness: 0.45 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.6, roughness: 0.5 });

    // Body: squat armoured dome over a dark belly, with a glowing charge band
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry) => {
      const list = parts.get(mat) ?? [];
      list.push(geo);
      parts.set(mat, list);
    };
    const dome = new THREE.SphereGeometry(0.3, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    dome.scale(1, 0.75, 1.15);
    add(shellMat, dome);
    const belly = new THREE.SphereGeometry(0.27, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    belly.scale(1, 0.7, 1.1);
    add(darkMat, belly);
    const spine = bevelBox(0.12, 0.08, 0.5, 0.03);
    spine.translate(0, 0.21, -0.02);
    add(plateMat, spine);
    for (const sx of [-1, 1]) {
      const plate = bevelBox(0.14, 0.05, 0.3, 0.02);
      plate.rotateZ(sx * 0.5);
      plate.translate(sx * 0.17, 0.14, 0.02);
      add(plateMat, plate);
    }
    const antenna = new THREE.CylinderGeometry(0.008, 0.012, 0.28, 5);
    antenna.rotateX(-0.5);
    antenna.translate(0.08, 0.3, -0.18);
    add(darkMat, antenna);
    for (const [mat, geos] of parts) {
      const mesh = new THREE.Mesh(mergeAndDispose(geos)!, mat);
      mesh.castShadow = true;
      this.body.add(mesh);
    }

    // Glowing parts: charge band around the waist, sensor eye, antenna tip
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.295, 0.018, 8, 32), this.glow);
    band.rotation.x = Math.PI / 2;
    band.scale.set(1, 1.15, 1);
    this.body.add(band);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), this.glow);
    eye.position.set(0, 0.03, 0.32);
    this.body.add(eye);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), this.glow);
    tip.position.set(0.08, 0.42, -0.25);
    this.body.add(tip);

    // Four spider legs: high knees, feet planted wide
    const legMat = darkMat;
    const jointMat = plateMat;
    const corners: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
    corners.forEach(([sx, sz], i) => {
      const pivot = new THREE.Group();
      pivot.position.set(sx * 0.2, 0, sz * 0.14);
      const baseYaw = Math.atan2(sx, sz); // point the leg diagonally outwards
      pivot.rotation.y = baseYaw;
      this.body.add(pivot);
      // In pivot space the leg reaches out along +z
      const hip = new THREE.Vector3(0, 0, 0);
      const knee = new THREE.Vector3(0, 0.16, 0.3);
      const foot = new THREE.Vector3(0, -BODY_HEIGHT, 0.5);
      pivot.add(this.segment(hip, knee, 0.03, legMat));
      pivot.add(this.segment(knee, foot, 0.022, legMat));
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), jointMat);
      joint.position.copy(knee);
      pivot.add(joint);
      const toe = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 6), legMat);
      toe.position.copy(foot).add(new THREE.Vector3(0, 0.03, 0));
      toe.rotation.x = Math.PI;
      pivot.add(toe);
      this.legs.push({ pivot, baseYaw, phase: i % 2 === 0 ? 0 : Math.PI });
    });
  }

  private segment(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
    const dir = b.clone().sub(a);
    const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, dir.length() - radius * 2), 3, 8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.castShadow = true;
    return mesh;
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === TickState.EXPLODED; }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.isDead()) return false;
    const c = this.group.position;
    const dx = p.x - c.x;
    const dy = p.y - (c.y + BODY_HEIGHT);
    const dz = p.z - c.z;
    return dx * dx + dy * dy + dz * dz < 0.5 * 0.5;
  }

  takeDamage(amount: number): void {
    if (this.isDead()) return;
    this.health = Math.max(0, this.health - amount);
    this.flashTimer = 0.08;
    // Getting shot wakes it up
    if (this.state === TickState.DORMANT) this.setState(TickState.WAKING);
  }

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    this.stateTimer += dt;

    // Destroyed (by anyone): detonate on the next update
    if (this.isDead() && this.state !== TickState.EXPLODED) return this.explode(ctx);

    const pos = this.group.position;
    const dist = pos.distanceTo(ctx.target);

    switch (this.state) {
      case TickState.DORMANT: {
        // Idle twitch; wake on sight
        this.body.position.y = BODY_HEIGHT * 0.7;
        if (dist < DETECTION_RANGE) {
          const eye = pos.clone().setY(pos.y + 0.5);
          if (hasLineOfSight(eye, ctx.target, ctx.worldMeshes)) this.setState(TickState.WAKING);
        }
        break;
      }

      case TickState.WAKING:
        // Stand up on its legs and chirp
        this.body.position.y = THREE.MathUtils.lerp(BODY_HEIGHT * 0.7, BODY_HEIGHT, Math.min(1, this.stateTimer / 0.35));
        this.group.rotation.y = turnTowards(this.group.rotation.y, yawTowards(pos, ctx.target), 10 * dt);
        if (this.stateTimer > 0.45) {
          soundManager.playSound('grapple', 0.2);
          this.setState(TickState.CHASE);
        }
        break;

      case TickState.LAUNCHED:
        this.velocity.y += GRAVITY * dt;
        pos.addScaledVector(this.velocity, dt);
        this.group.rotation.x += dt * 6; // tumbling through the air
        if (pos.y <= 0 && this.velocity.y < 0) {
          pos.y = 0;
          this.group.rotation.x = 0;
          this.setState(TickState.CHASE);
        }
        break;

      case TickState.CHASE: {
        this.body.position.y = BODY_HEIGHT;
        // Weave side to side so it's harder to hit
        const toTarget = ctx.target.clone().sub(pos).setY(0);
        const flat = toTarget.length();
        if (flat > 1e-3) toTarget.divideScalar(flat);
        const side = new THREE.Vector3(-toTarget.z, 0, toTarget.x);
        const weave = Math.sin(this.stateTimer * 5 + this.weaveSeed) * 0.6;
        const dir = toTarget.clone().addScaledVector(side, weave).normalize();
        this.group.rotation.y = turnTowards(this.group.rotation.y, Math.atan2(dir.x, dir.z), 12 * dt);
        const step = dir.multiplyScalar(SPEED * dt);
        if (!tryMoveHorizontal(this.group, step.x, step.z, ctx.worldMeshes, 0.3, [0.25])) {
          // Scrabble around the obstacle
          tryMoveHorizontal(this.group, side.x * SPEED * dt, side.z * SPEED * dt, ctx.worldMeshes, 0.3, [0.25]);
        }
        this.gait += dt * 22;
        if (dist < TRIGGER_RANGE + ctx.hitbox.radius) {
          soundManager.playSound('wallrun', 0.35);
          this.setState(TickState.ARMING);
        }
        break;
      }

      case TickState.ARMING:
        // Crouch and flash, then go off
        this.body.position.y = BODY_HEIGHT * (1 - Math.min(1, this.stateTimer / ARM_TIME) * 0.35);
        if (this.stateTimer >= ARM_TIME) {
          this.selfDetonated = true;
          return this.explode(ctx);
        }
        break;
    }

    this.animate(ctx, dist);
    return [];
  }

  private setState(state: TickState): void {
    this.state = state;
    this.stateTimer = 0;
  }

  private explode(ctx: HostileContext): HostileHit[] {
    this.health = 0;
    this.setState(TickState.EXPLODED);
    const center = this.group.position.clone().setY(this.group.position.y + BODY_HEIGHT);
    ctx.effects.spawnExplosion(center, FRAG_EXPLOSION_CONFIG);
    flashLight(center, 0xff5522, 60, 14, 0.35);
    soundManager.playSound('explosion', 0.6);

    // Splash hurts the player/titan and any other hostile nearby (chain reactions!)
    const hits: HostileHit[] = [];
    const toTarget = Math.max(0, center.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius);
    const dmg = splashDamage(BLAST_DAMAGE, toTarget, BLAST_RADIUS);
    if (dmg > 0) hits.push({ damage: dmg, source: center });
    for (const other of ctx.hostiles) {
      if (other === this || other.isDead()) continue;
      const d = splashDamage(BLAST_DAMAGE, center.distanceTo(other.group.position), BLAST_RADIUS);
      if (d > 0) other.takeDamage(d, center);
    }
    this.group.visible = false;
    return hits;
  }

  private animate(ctx: HostileContext, dist: number): void {
    const dt = ctx.delta;
    // Legs: alternating diagonal pairs sweep and lift while running
    const running = this.state === TickState.CHASE;
    for (const leg of this.legs) {
      const s = Math.sin(this.gait + leg.phase);
      leg.pivot.rotation.y = leg.baseYaw + (running ? s * 0.35 : 0);
      leg.pivot.rotation.x = running ? Math.max(0, s) * -0.35 : this.state === TickState.LAUNCHED ? -0.9 : 0;
    }
    if (running) this.body.position.y = BODY_HEIGHT + Math.abs(Math.sin(this.gait)) * 0.03;

    // Beep faster the closer it gets; flash in sync
    let blink = 0.35;
    if (this.state === TickState.CHASE || this.state === TickState.ARMING) {
      const interval = this.state === TickState.ARMING ? 0.08 : THREE.MathUtils.clamp(dist / 25, 0.12, 0.6);
      this.beepTimer += dt;
      if (this.beepTimer >= interval) {
        this.beepTimer = 0;
        this.flashTimer = Math.max(this.flashTimer, 0.05);
        if (dist < 20) soundManager.playSound('wallrun', 0.08);
      }
      blink = this.flashTimer > 0 ? 6 : 1.6;
    } else if (this.state === TickState.WAKING) {
      blink = 3;
    }
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.glow.color.copy(this.glowColor).multiplyScalar(blink);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
  }
}

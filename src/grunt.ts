import * as THREE from 'three';
import { BallisticsSystem, Bullet } from './ballistics';
import { soundManager } from './sound';
import { segmentIntersectsSphere } from './collision';
import { bevelBox, mergeAndDispose } from './geometryUtils';
import { DEFAULT_MUZZLE_CONFIG, PLAYER_IMPACT_CONFIG } from './effects';
import {
  CoverCandidate, Hostile, HostileContext, HostileHit, chooseCover, hasLineOfSight,
  tryMoveHorizontal, turnTowards, yawTowards,
} from './hostile';

/*
 * Grunt: IMC rifleman. Fights in squads: whoever spots the pilot alerts the
 * rest, they take cover behind real level geometry, peek out to fire bursts,
 * reload between magazines, and run from titans.
 */

export enum GruntState {
  IDLE,
  PATROL,
  ALERT,
  CHASE,
  ENGAGE,
  TAKE_COVER,
  IN_COVER,
  PEEK,
  RELOAD,
  FLEE,
  DEAD,
}

export interface GruntOptions {
  health?: number;
  /** 0 (green recruit) .. 1 (veteran): accuracy, reaction time, burst length. */
  difficulty?: number;
  /** Grunts sharing a squad id alert each other. */
  squadId?: number;
  /** Start patrolling (true) or standing guard (false). */
  aggressive?: boolean;
}

const GRUNT_BULLET_VISUALS = {
  meshType: 'sphere' as const,
  color: 0xff4422,
  radius: 0.04,
  length: 0,
  hasTrail: true,
  trailColor: 0xff6633,
  trailLength: 12,
  gravity: -10,
  maxLifetime: 3,
  explosive: false,
  splashRadius: 0,
};

const BULLET_DAMAGE = 8;
const BULLET_SPEED = 60;
const MAGAZINE = 18;
const RELOAD_TIME = 2.2;
const DETECTION_RANGE = 32;
const ENGAGE_RANGE = 24;
const SQUAD_RADIO_RANGE = 40;
const FLEE_TITAN_RANGE = 20;
const WALK_SPEED = 1.6;
const RUN_SPEED = 4.2;
const RADIUS = 0.4;
const MOVE_PROBES = [0.4, 1.2] as const;
const EYE_HEIGHT = 1.62;
const CHEST_HEIGHT = 1.2;

interface GruntModel {
  head: THREE.Object3D | null;
  leftLeg: THREE.Object3D | null;
  rightLeg: THREE.Object3D | null;
  flashMeshes: THREE.Mesh[];
}

/**
 * Build the soldier model. Static parts are merged per material so each
 * soldier costs about a dozen draw calls; legs and head stay separate
 * because they animate.
 */
function buildGruntModel(root: THREE.Group): GruntModel {
  const model: GruntModel = { head: null, leftLeg: null, rightLeg: null, flashMeshes: [] };

    const armorMat = new THREE.MeshStandardMaterial({ color: 0xb8322a, metalness: 0.35, roughness: 0.45 });
    const suitMat = new THREE.MeshStandardMaterial({ color: 0x1d2129, metalness: 0.2, roughness: 0.75 });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.8, roughness: 0.3 });
    // HDR colour so the visor and jump-kit nozzles pick up bloom
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3a1a).multiplyScalar(3) });

    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (target: Map<THREE.Material, THREE.BufferGeometry[]>, mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      geo.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ));
      const list = target.get(mat) ?? [];
      list.push(geo);
      target.set(mat, list);
    };
    /** Capsule limb segment running from `a` to `b`. */
    const limb = (target: Map<THREE.Material, THREE.BufferGeometry[]>, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
      const dir = b.clone().sub(a);
      const length = dir.length();
      const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 3, 8);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      geo.translate(mid.x, mid.y, mid.z);
      const list = target.get(mat) ?? [];
      list.push(geo);
      target.set(mat, list);
    };
    const flush = (target: Map<THREE.Material, THREE.BufferGeometry[]>, parent: THREE.Object3D) => {
      for (const [mat, geos] of target) {
        const merged = mergeAndDispose(geos);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = !(mat instanceof THREE.MeshBasicMaterial);
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      target.clear();
    };
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // --- Torso ---
    add(parts, suitMat, bevelBox(0.34, 0.17, 0.22), 0, 0.95, 0);                 // pelvis
    add(parts, suitMat, bevelBox(0.3, 0.2, 0.2), 0, 1.1, 0);                     // abdomen
    add(parts, armorMat, bevelBox(0.44, 0.34, 0.27, 0.05), 0, 1.33, 0);          // chest rig
    add(parts, armorMat, bevelBox(0.3, 0.2, 0.05, 0.02), 0, 1.3, 0.145, -0.08);  // chest plate
    add(parts, gunMat, bevelBox(0.36, 0.05, 0.24), 0, 1.03, 0);                  // belt
    for (const sx of [-1, 1]) add(parts, suitMat, bevelBox(0.08, 0.1, 0.06), sx * 0.12, 1.02, 0.13); // pouches
    add(parts, suitMat, new THREE.CylinderGeometry(0.055, 0.065, 0.1, 10), 0, 1.54, 0); // neck

    // --- Jump kit ---
    add(parts, gunMat, bevelBox(0.32, 0.38, 0.13, 0.03), 0, 1.3, -0.2);
    for (const sx of [-1, 1]) {
      add(parts, gunMat, new THREE.CylinderGeometry(0.045, 0.06, 0.16, 12), sx * 0.09, 1.08, -0.24);
      add(parts, glowMat, new THREE.CylinderGeometry(0.035, 0.035, 0.02, 12), sx * 0.09, 0.995, -0.24);
    }

    // --- Shoulders ---
    for (const sx of [-1, 1]) add(parts, armorMat, bevelBox(0.15, 0.1, 0.17, 0.04), sx * 0.27, 1.47, 0, 0, 0, sx * -0.25);

    // --- Arms, holding the rifle at the ready ---
    const rShoulder = v(0.25, 1.44, 0), rElbow = v(0.24, 1.2, 0.06), rHand = v(0.08, 1.13, 0.27);
    const lShoulder = v(-0.25, 1.44, 0), lElbow = v(-0.24, 1.22, 0.16), lHand = v(0.0, 1.17, 0.5);
    limb(parts, suitMat, rShoulder, rElbow, 0.055);
    limb(parts, armorMat, rElbow, rHand, 0.05);
    limb(parts, suitMat, lShoulder, lElbow, 0.055);
    limb(parts, armorMat, lElbow, lHand, 0.05);
    add(parts, suitMat, bevelBox(0.07, 0.08, 0.09), rHand.x, rHand.y, rHand.z);  // gloves
    add(parts, suitMat, bevelBox(0.07, 0.08, 0.09), lHand.x, lHand.y, lHand.z);

    // --- Rifle ---
    add(parts, gunMat, bevelBox(0.06, 0.1, 0.42, 0.015), 0.05, 1.18, 0.36);      // receiver
    add(parts, gunMat, new THREE.CylinderGeometry(0.014, 0.016, 0.28, 10), 0.05, 1.2, 0.7, Math.PI / 2); // barrel
    add(parts, gunMat, bevelBox(0.04, 0.13, 0.07, 0.01), 0.05, 1.08, 0.4, -0.25); // magazine
    add(parts, gunMat, bevelBox(0.045, 0.09, 0.18, 0.012), 0.05, 1.15, 0.08);    // stock
    add(parts, gunMat, bevelBox(0.04, 0.045, 0.1, 0.01), 0.05, 1.255, 0.36);     // optic
    add(parts, glowMat, bevelBox(0.062, 0.012, 0.16, 0.004), 0.05, 1.215, 0.42); // accent strip

    flush(parts, root);

    // --- Head (tracks the player) ---
    const head = new THREE.Group();
    head.position.set(0, 1.66, 0);
    const helmet = new THREE.SphereGeometry(0.13, 16, 12);
    helmet.scale(1, 1.05, 1.12);
    add(parts, armorMat, helmet, 0, 0, 0);
    add(parts, suitMat, bevelBox(0.2, 0.09, 0.12, 0.03), 0, -0.08, 0.05);          // jaw guard
    add(parts, glowMat, bevelBox(0.19, 0.045, 0.05, 0.015), 0, 0.01, 0.125);       // visor
    add(parts, gunMat, new THREE.CylinderGeometry(0.006, 0.006, 0.18, 6), 0.09, 0.13, -0.06, 0.2); // antenna
    flush(parts, head);
    root.add(head);
    model.head = head;

    // --- Legs, pivoting at the hip ---
    const buildLeg = (side: number): THREE.Group => {
      const leg = new THREE.Group();
      leg.position.set(side * 0.11, 0.92, 0);
      limb(parts, suitMat, v(0, -0.02, 0), v(0, -0.44, 0.02), 0.075);             // thigh
      add(parts, armorMat, bevelBox(0.1, 0.12, 0.08, 0.025), 0, -0.44, 0.07);     // knee pad
      limb(parts, suitMat, v(0, -0.46, 0.02), v(0, -0.84, -0.01), 0.062);         // shin
      add(parts, armorMat, bevelBox(0.1, 0.22, 0.06, 0.02), 0, -0.64, 0.05);      // shin guard
      add(parts, gunMat, bevelBox(0.12, 0.09, 0.25, 0.03), 0, -0.875, 0.04);      // boot
      flush(parts, leg);
      root.add(leg);
      return leg;
    };
    model.leftLeg = buildLeg(-1);
    model.rightLeg = buildLeg(1);

    // Flash overlays on torso and head
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const torsoFlash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.34), flashMat);
    torsoFlash.position.set(0, 1.22, -0.02);
    root.add(torsoFlash);
    model.flashMeshes.push(torsoFlash);

    const headFlash = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), flashMat.clone());
    head.add(headFlash);
    model.flashMeshes.push(headFlash);
  
  return model;
}

let nextSquadId = 1000;

export class Grunt implements Hostile {
  readonly kind = 'grunt' as const;
  readonly scoreValue = 100;
  readonly group: THREE.Group;
  health: number;
  state: GruntState;
  readonly squadId: number;

  private readonly scene: THREE.Scene;
  private readonly model: GruntModel;
  private readonly maxHealth: number;
  private readonly difficulty: number;
  private readonly ballistics: BallisticsSystem;
  private bullets: Bullet[] = [];

  private stateTimer = 0;
  private lastKnownTarget: THREE.Vector3 | null = null;
  private reaction = 0;
  private readonly reactionTime: number;
  private hasLOS = false;

  // Weapon
  private ammo = MAGAZINE;
  private burstLeft = 0;
  private burstCooldown = 0;
  private fireTimer = 0;
  private readonly fireInterval: number;
  private readonly burstSize: number;
  private readonly spreadDeg: number;

  // Movement / tactics
  private patrolPoints: THREE.Vector3[] = [];
  private patrolIndex = 0;
  private strafeDir = Math.random() < 0.5 ? -1 : 1;
  private coverPos: THREE.Vector3 | null = null;
  private peekPos: THREE.Vector3 | null = null;
  private coverCooldown = 0;
  private walkPhase = 0;
  private moving = false;

  // Feedback
  private flashTimer = 0;
  private deathTimer = 0;
  private deathAxis = new THREE.Vector3(1, 0, 0);
  private deathYaw = 0;

  constructor(scene: THREE.Scene, position: THREE.Vector3, options: GruntOptions = {}) {
    this.scene = scene;
    this.difficulty = THREE.MathUtils.clamp(options.difficulty ?? 0.5, 0, 1);
    this.maxHealth = options.health ?? 50;
    this.health = this.maxHealth;
    this.squadId = options.squadId ?? nextSquadId++;

    this.fireInterval = 0.12 + (1 - this.difficulty) * 0.12;
    this.burstSize = 3 + Math.floor(this.difficulty * 3);
    this.spreadDeg = 5.5 - this.difficulty * 3.5;
    this.reactionTime = 0.35 + (1 - this.difficulty) * 0.7;

    this.group = new THREE.Group();
    this.model = buildGruntModel(this.group);
    this.group.position.copy(position);
    this.group.rotation.y = Math.random() * Math.PI * 2;
    scene.add(this.group);

    this.ballistics = new BallisticsSystem(scene);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.random();
      const r = 4 + Math.random() * 4;
      this.patrolPoints.push(new THREE.Vector3(position.x + Math.cos(a) * r, position.y, position.z + Math.sin(a) * r));
    }
    this.state = options.aggressive === false ? GruntState.IDLE : GruntState.PATROL;
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === GruntState.DEAD && this.deathTimer > 2 && this.bullets.length === 0; }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.isDead()) return false;
    const pos = this.group.position;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const dy = p.y - pos.y;
    // Upright capsule: 0.45 m radius from the feet to the top of the helmet
    return dx * dx + dz * dz < 0.45 * 0.45 && dy > 0 && dy < 1.85;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    if (this.isDead()) return;
    this.health = Math.max(0, this.health - amount);
    this.flashTimer = 0.1;
    this.reaction = this.reactionTime; // getting shot skips the reaction delay
    if (hitPoint && !this.lastKnownTarget) this.lastKnownTarget = hitPoint.clone();
    if (this.health <= 0) {
      this.enterDeath(hitPoint);
      return;
    }
    if (this.state === GruntState.IDLE || this.state === GruntState.PATROL || this.state === GruntState.ALERT) {
      this.setState(GruntState.CHASE);
    }
    // Wounded and exposed: look for cover
    if (this.health < this.maxHealth * 0.6 && (this.state === GruntState.ENGAGE || this.state === GruntState.CHASE)) {
      this.coverCooldown = 0;
    }
  }

  /** Squad radio: a squadmate spotted the pilot at `position`. */
  hearAlert(position: THREE.Vector3): void {
    if (this.isDead()) return;
    this.lastKnownTarget = position.clone();
    if (this.state === GruntState.IDLE || this.state === GruntState.PATROL) this.setState(GruntState.ALERT);
  }

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    const hits = this.updateBullets(ctx);

    if (this.state === GruntState.DEAD) {
      this.updateDeath(dt);
      return hits;
    }

    this.stateTimer += dt;
    this.fireTimer += dt;
    this.burstCooldown = Math.max(0, this.burstCooldown - dt);
    this.coverCooldown = Math.max(0, this.coverCooldown - dt);

    const pos = this.group.position;
    const dist = pos.distanceTo(ctx.target);
    const eye = pos.clone().setY(pos.y + EYE_HEIGHT);
    this.hasLOS = dist < DETECTION_RANGE * 1.5 && hasLineOfSight(eye, ctx.target, ctx.worldMeshes);
    const canSee = this.hasLOS && dist < DETECTION_RANGE;
    if (canSee) {
      if (!this.lastKnownTarget) this.alertSquad(ctx);
      this.lastKnownTarget = ctx.target.clone();
      this.reaction = Math.min(this.reactionTime, this.reaction + dt);
    }

    this.think(ctx, dist, canSee);
    this.moving = false;
    this.act(ctx, dist, canSee);
    this.animate(ctx, dt);
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
    for (const b of this.bullets) this.ballistics.disposeBullet(b);
    this.bullets = [];
  }

  /* ------------------------------ Brain ------------------------------- */

  private setState(state: GruntState): void {
    this.state = state;
    this.stateTimer = 0;
  }

  private alertSquad(ctx: HostileContext): void {
    for (const other of ctx.hostiles) {
      if (other === this || !(other instanceof Grunt) || other.squadId !== this.squadId) continue;
      if (other.group.position.distanceTo(this.group.position) <= SQUAD_RADIO_RANGE) other.hearAlert(ctx.target);
    }
  }

  private think(ctx: HostileContext, dist: number, canSee: boolean): void {
    // Titans are not a fight a grunt wins: run, turning to fire over the shoulder
    if (ctx.targetIsTitan && dist < FLEE_TITAN_RANGE && this.state !== GruntState.FLEE) {
      this.setState(GruntState.FLEE);
      return;
    }

    switch (this.state) {
      case GruntState.IDLE:
      case GruntState.PATROL:
        if (canSee) this.setState(GruntState.CHASE);
        break;

      case GruntState.ALERT:
        if (canSee) this.setState(GruntState.ENGAGE);
        else if (this.stateTimer > 0.8) this.setState(GruntState.CHASE);
        break;

      case GruntState.CHASE:
        if (canSee && dist < ENGAGE_RANGE) this.setState(GruntState.ENGAGE);
        else if (!this.lastKnownTarget || (this.stateTimer > 12 && !canSee)) this.setState(GruntState.PATROL);
        break;

      case GruntState.ENGAGE:
        if (this.ammo <= 0) {
          this.startReload(ctx);
        } else if (!canSee && this.stateTimer > 1.2) {
          this.setState(GruntState.CHASE);
        } else if (dist > ENGAGE_RANGE * 1.3) {
          this.setState(GruntState.CHASE);
        } else if (this.coverCooldown <= 0 && (this.health < this.maxHealth * 0.6 || this.stateTimer > 4 + Math.random() * 3)) {
          this.coverCooldown = 5;
          if (this.findCover(ctx)) this.setState(GruntState.TAKE_COVER);
        }
        break;

      case GruntState.TAKE_COVER:
        if (!this.coverPos || this.stateTimer > 5) this.setState(GruntState.ENGAGE);
        else if (this.group.position.distanceTo(this.coverPos) < 0.6) this.setState(GruntState.IN_COVER);
        break;

      case GruntState.IN_COVER:
        if (this.ammo < MAGAZINE && this.stateTimer > 0.4 && this.ammo < MAGAZINE / 2) {
          this.startReload(ctx);
        } else if (this.stateTimer > 1.5 + Math.random() * 1.5) {
          this.peekPos = this.findPeek(ctx);
          if (this.peekPos) this.setState(GruntState.PEEK);
          else this.setState(GruntState.ENGAGE);
        }
        break;

      case GruntState.PEEK:
        // Pop out, fire a burst, duck back
        if (this.ammo <= 0 || (this.stateTimer > 1.6 && this.burstLeft === 0)) {
          this.setState(this.coverPos ? GruntState.TAKE_COVER : GruntState.ENGAGE);
        }
        break;

      case GruntState.RELOAD:
        if (this.stateTimer >= RELOAD_TIME) {
          this.ammo = MAGAZINE;
          this.setState(this.coverPos && this.group.position.distanceTo(this.coverPos) < 1 ? GruntState.IN_COVER : GruntState.ENGAGE);
        }
        break;

      case GruntState.FLEE:
        if (!ctx.targetIsTitan || dist > FLEE_TITAN_RANGE * 1.5) this.setState(GruntState.CHASE);
        break;
    }
  }

  private act(ctx: HostileContext, dist: number, canSee: boolean): void {
    const dt = ctx.delta;
    const pos = this.group.position;
    const readyToFire = canSee && this.reaction >= this.reactionTime;

    switch (this.state) {
      case GruntState.IDLE:
        this.group.rotation.y += 0.25 * dt;
        break;

      case GruntState.PATROL: {
        const wp = this.patrolPoints[this.patrolIndex];
        this.face(wp, dt, 3);
        if (pos.distanceTo(wp) < 0.8 || !this.moveTowards(ctx, wp, WALK_SPEED)) {
          this.patrolIndex = (this.patrolIndex + 1) % this.patrolPoints.length;
        }
        break;
      }

      case GruntState.ALERT:
        if (this.lastKnownTarget) this.face(this.lastKnownTarget, dt, 5);
        break;

      case GruntState.CHASE:
        if (this.lastKnownTarget) {
          this.face(this.lastKnownTarget, dt, 6);
          if (pos.distanceTo(this.lastKnownTarget) > 2) this.moveTowards(ctx, this.lastKnownTarget, RUN_SPEED);
        }
        break;

      case GruntState.ENGAGE: {
        this.face(ctx.target, dt, 8);
        // Keep moving laterally so they're not free kills; close in if far
        const toTarget = ctx.target.clone().sub(pos).setY(0).normalize();
        const side = new THREE.Vector3(-toTarget.z, 0, toTarget.x).multiplyScalar(this.strafeDir);
        const advance = dist > ENGAGE_RANGE * 0.7 ? 0.6 : dist < 8 ? -0.5 : 0;
        const move = side.add(toTarget.multiplyScalar(advance)).normalize().multiplyScalar(2.2 * dt);
        if (!tryMoveHorizontal(this.group, move.x, move.z, ctx.worldMeshes, RADIUS, MOVE_PROBES)) this.strafeDir *= -1;
        else this.moving = true;
        if (Math.random() < dt * 0.4) this.strafeDir *= -1;
        if (readyToFire) this.burstFire(ctx);
        break;
      }

      case GruntState.TAKE_COVER:
        if (this.coverPos) {
          this.face(this.coverPos, dt, 8);
          if (!this.moveTowards(ctx, this.coverPos, RUN_SPEED)) this.coverPos = null;
        }
        break;

      case GruntState.IN_COVER:
        if (this.lastKnownTarget) this.face(this.lastKnownTarget, dt, 5);
        break;

      case GruntState.PEEK:
        if (this.peekPos && pos.distanceTo(this.peekPos) > 0.3) this.moveTowards(ctx, this.peekPos, RUN_SPEED * 0.7);
        this.face(ctx.target, dt, 10);
        if (readyToFire) this.burstFire(ctx);
        break;

      case GruntState.RELOAD:
        if (this.lastKnownTarget) this.face(this.lastKnownTarget, dt, 3);
        break;

      case GruntState.FLEE: {
        const away = pos.clone().sub(ctx.target).setY(0);
        if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
        away.normalize().multiplyScalar(RUN_SPEED * 1.1 * dt);
        if (!tryMoveHorizontal(this.group, away.x, away.z, ctx.worldMeshes, RADIUS, MOVE_PROBES)) {
          // Cornered: slide sideways
          tryMoveHorizontal(this.group, -away.z * this.strafeDir, away.x * this.strafeDir, ctx.worldMeshes, RADIUS, MOVE_PROBES);
        }
        this.moving = true;
        // Face away while running, glance back to shoot now and then
        const shootBack = Math.sin(this.stateTimer * 1.3) > 0.6;
        this.face(shootBack ? ctx.target : pos.clone().add(away), dt, 8);
        if (shootBack && readyToFire) this.burstFire(ctx);
        break;
      }
    }
  }

  private startReload(ctx: HostileContext): void {
    this.burstLeft = 0;
    // Prefer reloading behind cover if there's some nearby
    if (!this.coverPos && this.coverCooldown <= 0) {
      this.coverCooldown = 5;
      this.findCover(ctx);
    }
    this.setState(GruntState.RELOAD);
    soundManager.playSound('reload', 0.15);
  }

  /* ------------------------------ Tactics ------------------------------ */

  /** Search a ring of spots around the grunt for one the threat can't see. */
  private findCover(ctx: HostileContext): boolean {
    const pos = this.group.position;
    const threat = this.lastKnownTarget ?? ctx.target;
    const candidates: CoverCandidate[] = [];
    const knee = new THREE.Vector3();
    const chest = new THREE.Vector3();
    for (const radius of [3, 6, 9]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const p = new THREE.Vector3(pos.x + Math.cos(a) * radius, pos.y, pos.z + Math.sin(a) * radius);
        knee.copy(pos).setY(pos.y + 0.5);
        const reachable = hasLineOfSight(knee, p.clone().setY(pos.y + 0.5), ctx.worldMeshes);
        chest.copy(p).setY(p.y + CHEST_HEIGHT);
        const hidden = reachable && !hasLineOfSight(chest, threat, ctx.worldMeshes);
        candidates.push({ position: p, hidden, reachable });
      }
    }
    const best = chooseCover(candidates, pos, threat);
    this.coverPos = best >= 0 ? candidates[best].position : null;
    return this.coverPos !== null;
  }

  /** From cover, find a nearby sidestep that has a line of fire to the target. */
  private findPeek(ctx: HostileContext): THREE.Vector3 | null {
    const pos = this.group.position;
    const toTarget = ctx.target.clone().sub(pos).setY(0).normalize();
    const side = new THREE.Vector3(-toTarget.z, 0, toTarget.x);
    for (const offset of [1.2, -1.2, 2.2, -2.2, 3.2, -3.2]) {
      const p = pos.clone().addScaledVector(side, offset);
      const eye = p.clone().setY(p.y + EYE_HEIGHT);
      if (hasLineOfSight(pos.clone().setY(pos.y + 0.5), p.clone().setY(p.y + 0.5), ctx.worldMeshes)
          && hasLineOfSight(eye, ctx.target, ctx.worldMeshes)) return p;
    }
    return null;
  }

  /* ------------------------------ Weapon ------------------------------ */

  private burstFire(ctx: HostileContext): void {
    if (this.ammo <= 0) return;
    if (this.burstLeft > 0) {
      if (this.fireTimer >= this.fireInterval) {
        this.shoot(ctx);
        this.fireTimer = 0;
        this.burstLeft--;
        this.ammo--;
        if (this.burstLeft === 0) this.burstCooldown = 0.6 + (1 - this.difficulty) * 1.1;
      }
    } else if (this.burstCooldown <= 0) {
      this.burstLeft = Math.min(this.burstSize, this.ammo);
    }
  }

  private shoot(ctx: HostileContext): void {
    this.group.updateMatrixWorld();
    const muzzle = this.group.localToWorld(new THREE.Vector3(0.05, 1.2, 0.86));

    // Lead the target, more accurately for veterans
    const aim = ctx.target.clone();
    if (ctx.targetVelocity.lengthSq() > 1) {
      const travel = muzzle.distanceTo(ctx.target) / BULLET_SPEED;
      aim.addScaledVector(ctx.targetVelocity, travel * (0.3 + this.difficulty * 0.5));
    }
    const dir = aim.sub(muzzle).normalize();
    const spread = THREE.MathUtils.degToRad(this.spreadDeg) * (this.state === GruntState.FLEE ? 2 : 1);
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * spread;
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

    this.bullets.push(this.ballistics.createBullet(muzzle, dir.clone().multiplyScalar(BULLET_SPEED), GRUNT_BULLET_VISUALS));
    ctx.effects.spawnMuzzleFlash(muzzle, dir, { ...DEFAULT_MUZZLE_CONFIG, color: 0xff8844, radius: 0.08 });
    soundManager.playSound('enemy_fire', 0.3);
  }

  private updateBullets(ctx: HostileContext): HostileHit[] {
    const hits: HostileHit[] = [];
    const raycaster = new THREE.Raycaster();
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prev = b.mesh.position.clone();
      this.ballistics.updateBullet(b, ctx.delta);

      // Clip this frame's travel against level geometry so bullets can't pass through walls
      let end = b.mesh.position;
      let hitWall: THREE.Intersection | null = null;
      const step = b.mesh.position.clone().sub(prev);
      const len = step.length();
      if (len > 1e-6) {
        raycaster.set(prev, step.divideScalar(len));
        raycaster.far = len;
        hitWall = raycaster.intersectObjects(ctx.worldMeshes, false)[0] ?? null;
        if (hitWall) end = hitWall.point;
      }

      const hitTarget = segmentIntersectsSphere(prev, end, ctx.hitbox.center, ctx.hitbox.radius);
      if (hitTarget) hits.push({ damage: BULLET_DAMAGE, source: this.group.position.clone() });
      else if (hitWall) {
        const normal = hitWall.face ? hitWall.face.normal.clone().transformDirection(hitWall.object.matrixWorld) : step.negate();
        ctx.effects.spawnImpact(hitWall.point, normal, PLAYER_IMPACT_CONFIG);
      }

      if (hitTarget || hitWall || b.time > b.maxLifetime || b.mesh.position.y < -5) {
        this.ballistics.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }
    return hits;
  }

  /* ---------------------------- Locomotion ---------------------------- */

  private moveTowards(ctx: HostileContext, target: THREE.Vector3, speed: number): boolean {
    const d = target.clone().sub(this.group.position).setY(0);
    const len = d.length();
    if (len < 0.05) return true;
    const stepLen = Math.min(len, speed * ctx.delta);
    d.multiplyScalar(stepLen / len);
    const ok = tryMoveHorizontal(this.group, d.x, d.z, ctx.worldMeshes, RADIUS, MOVE_PROBES);
    this.moving = ok;
    return ok;
  }

  private face(point: THREE.Vector3, dt: number, turnRate: number): void {
    this.group.rotation.y = turnTowards(this.group.rotation.y, yawTowards(this.group.position, point), turnRate * dt);
  }

  /* ---------------------------- Animation ----------------------------- */

  private animate(ctx: HostileContext, dt: number): void {
    const { leftLeg, rightLeg, head, flashMeshes } = this.model;
    if (this.moving) {
      const running = this.state !== GruntState.PATROL;
      this.walkPhase += dt * (running ? 11 : 6);
      const swing = Math.sin(this.walkPhase) * (running ? 0.55 : 0.35);
      if (leftLeg) leftLeg.rotation.x = swing;
      if (rightLeg) rightLeg.rotation.x = -swing;
    } else {
      if (leftLeg) leftLeg.rotation.x *= 0.85;
      if (rightLeg) rightLeg.rotation.x *= 0.85;
    }

    // Head tracks the target when aware of it
    if (head) {
      const aware = this.state !== GruntState.IDLE && this.state !== GruntState.PATROL;
      const local = aware
        ? THREE.MathUtils.clamp(Math.atan2(Math.sin(yawTowards(this.group.position, ctx.target) - this.group.rotation.y), Math.cos(yawTowards(this.group.position, ctx.target) - this.group.rotation.y)), -0.8, 0.8)
        : 0;
      head.rotation.y += (local - head.rotation.y) * 0.12;
    }

    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);
    const opacity = this.flashTimer * 5;
    for (const fm of flashMeshes) (fm.material as THREE.MeshBasicMaterial).opacity = opacity;
  }

  private enterDeath(hitPoint?: THREE.Vector3): void {
    this.setState(GruntState.DEAD);
    this.deathTimer = 0;
    this.deathYaw = this.group.rotation.y;
    // Topple away from the shot
    const away = hitPoint ? this.group.position.clone().sub(hitPoint).setY(0) : new THREE.Vector3(0, 0, -1);
    if (away.lengthSq() < 1e-6) away.set(0, 0, -1);
    away.normalize();
    this.deathAxis.set(0, 1, 0).cross(away).normalize();
    for (const fm of this.model.flashMeshes) (fm.material as THREE.MeshBasicMaterial).opacity = 0;
  }

  private updateDeath(dt: number): void {
    this.deathTimer += dt;
    const fall = Math.min(1, this.deathTimer / 0.55);
    const eased = fall * fall;
    this.group.quaternion.setFromAxisAngle(this.deathAxis, eased * (Math.PI / 2 - 0.1))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.deathYaw));
    // Sink into the floor once down
    if (this.deathTimer > 1.3) this.group.position.y -= dt * 0.8;
  }
}

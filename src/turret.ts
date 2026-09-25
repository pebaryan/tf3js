import * as THREE from 'three';
import { soundManager } from './sound';
import { bevelBox, mergeAndDispose } from './geometryUtils';
import { DEFAULT_MUZZLE_CONFIG, FRAG_EXPLOSION_CONFIG, PLAYER_IMPACT_CONFIG, TITAN_IMPACT_CONFIG } from './effects';
import { flashLight } from './graphics';
import { HostileGun, applySpread } from './hostileWeapons';
import { Hostile, HostileContext, HostileHit, hasLineOfSight, leadTarget, pitchTowards, turnTowards, yawTowards } from './hostile';

/*
 * Automated sentry turrets. Both sweep their arc until they see the target,
 * lock on (a laser sight shows where they're looking), then track it with a
 * limited turn rate and fire. Lose line of sight and they watch the last
 * known position for a while before going back to sweeping.
 *
 *  - Light turret: tripod anti-personnel gun. Fast, accurate bursts that
 *    shred pilots but barely scratch a titan.
 *  - Titan turret: heavy anti-armour cannon. Slow-traversing, high-damage
 *    explosive shells; a nimble pilot can get under its guard, a titan can't.
 */

export type TurretVariant = 'light' | 'titan';

export enum TurretState {
  IDLE,
  ACQUIRE,
  FIRING,
  SEARCH,
  DESTROYED,
}

interface TurretSpec {
  health: number;
  score: number;
  range: number;
  acquireTime: number;
  /** Faster lock-on against titans (the heavy turret's preferred prey). */
  acquireTimeTitan: number;
  yawRate: number;
  pitchRate: number;
  pivotHeight: number;
  hitRadius: number;
  hitHeight: number;
  fireInterval: number;
  /** Slower cadence against pilots (the heavy gun is built to kill titans). */
  fireIntervalPilot: number;
  burst: number;
  burstPause: number;
  bulletSpeed: number;
  spreadDeg: number;
  /** Max aim error (radians) at which it will fire. */
  fireCone: number;
}

const SPECS: Record<TurretVariant, TurretSpec> = {
  light: {
    health: 160, score: 150, range: 38, acquireTime: 0.6, acquireTimeTitan: 0.6,
    yawRate: 2.1, pitchRate: 1.6, pivotHeight: 1.0, hitRadius: 0.6, hitHeight: 1.45,
    fireInterval: 0.1, fireIntervalPilot: 0.1, burst: 10, burstPause: 1.4, bulletSpeed: 95, spreadDeg: 2.2, fireCone: 0.12,
  },
  titan: {
    health: 700, score: 400, range: 75, acquireTime: 1.1, acquireTimeTitan: 0.6,
    yawRate: 0.7, pitchRate: 0.5, pivotHeight: 2.15, hitRadius: 1.25, hitHeight: 3.3,
    fireInterval: 1.5, fireIntervalPilot: 2.3, burst: 1, burstPause: 0, bulletSpeed: 75, spreadDeg: 0.6, fireCone: 0.06,
  },
};

const SWEEP_ARC = 0.9;
const SEARCH_TIME = 2.5;
const WRECK_TIME = 6;
const PITCH_MIN = -0.5;
const PITCH_MAX = 0.9;

const LIGHT_ROUND = {
  meshType: 'sphere' as const,
  color: 0xffaa33,
  radius: 0.035,
  length: 0,
  hasTrail: true,
  trailColor: 0xff8833,
  trailLength: 14,
  gravity: -4,
  maxLifetime: 2,
  explosive: false,
  splashRadius: 0,
};

const HEAVY_SHELL = {
  meshType: 'capsule' as const,
  color: 0xff6622,
  radius: 0.12,
  length: 0.35,
  hasTrail: true,
  trailColor: 0xff9944,
  trailLength: 24,
  gravity: -3,
  maxLifetime: 3,
  explosive: true,
  splashRadius: 3.5,
};

/** Unit beam along +Y (y ∈ [0, 1]) for the laser sight. */
const sightGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);

export class Turret implements Hostile {
  readonly kind = 'turret' as const;
  readonly variant: TurretVariant;
  readonly group: THREE.Group;
  health: number;
  state = TurretState.IDLE;
  /** Static collision cylinder (the game gives turrets a physics body). */
  readonly collider: { radius: number; height: number };
  get scoreValue(): number { return this.spec.score; }

  private readonly scene: THREE.Scene;
  private readonly spec: TurretSpec;
  private readonly yawPivot: THREE.Group;
  private readonly pitchPivot: THREE.Group;
  private readonly muzzles: THREE.Vector3[] = [];
  private readonly eyeLocal = new THREE.Vector3();
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly sightMat: THREE.MeshBasicMaterial;
  private readonly sight: THREE.Mesh;
  private readonly recoilParts: THREE.Object3D[] = [];
  private readonly gun: HostileGun;
  private readonly homeYaw: number;

  private stateTimer = 0;
  private time = Math.random() * 10;
  private fireTimer = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private muzzleIndex = 0;
  private recoil = 0;
  private flashTimer = 0;
  private lastKnownTarget: THREE.Vector3 | null = null;
  private smokeTimer = 0;

  constructor(scene: THREE.Scene, position: THREE.Vector3, variant: TurretVariant = 'light', facing = 0) {
    this.scene = scene;
    this.variant = variant;
    this.spec = SPECS[variant];
    this.health = this.spec.health;
    this.homeYaw = facing;
    this.collider = { radius: variant === 'titan' ? 1.1 : 0.45, height: this.spec.hitHeight };

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.yawPivot = new THREE.Group();
    this.yawPivot.position.y = this.spec.pivotHeight;
    this.yawPivot.rotation.y = facing;
    this.group.add(this.yawPivot);
    this.pitchPivot = new THREE.Group();
    this.yawPivot.add(this.pitchPivot);

    const glow = new THREE.Color(0xff2a14);
    this.eyeMat = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(3) });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.sightMat = new THREE.MeshBasicMaterial({
      color: glow.clone().multiplyScalar(5),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    if (variant === 'titan') this.buildHeavyModel();
    else this.buildLightModel();

    this.sight = new THREE.Mesh(sightGeo, this.sightMat);
    this.sight.visible = false;
    this.sight.frustumCulled = false;
    this.sight.userData.ignoreRaycast = true;
    scene.add(this.sight);

    this.gun = variant === 'titan'
      ? new HostileGun(scene, {
        visuals: HEAVY_SHELL,
        damage: (titan) => (titan ? 18 : 30),
        splashRadius: HEAVY_SHELL.splashRadius,
        explosion: FRAG_EXPLOSION_CONFIG,
        impact: TITAN_IMPACT_CONFIG,
      })
      : new HostileGun(scene, { visuals: LIGHT_ROUND, damage: (titan) => (titan ? 1 : 4) });
    scene.add(this.group);
  }

  /* ------------------------------ Models ------------------------------ */

  private static parts(): {
    add: (mat: THREE.Material, geo: THREE.BufferGeometry, x?: number, y?: number, z?: number, rx?: number, ry?: number, rz?: number) => void;
    strut: (mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number) => void;
    flush: (parent: THREE.Object3D) => void;
  } {
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      geo.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ));
      const list = parts.get(mat) ?? [];
      list.push(geo);
      parts.set(mat, list);
    };
    const strut = (mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number) => {
      const dir = b.clone().sub(a);
      const geo = new THREE.CylinderGeometry(r, r, dir.length(), 8);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      geo.translate(mid.x, mid.y, mid.z);
      add(mat, geo);
    };
    const flush = (parent: THREE.Object3D) => {
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
    return { add, strut, flush };
  }

  private buildLightModel(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8e9398, metalness: 0.55, roughness: 0.38 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1f23, metalness: 0.7, roughness: 0.45 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xb8401c, metalness: 0.35, roughness: 0.5 });
    const { add, strut, flush } = Turret.parts();
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // Tripod: three splayed legs with pads, a central post and a traverse ring
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const foot = v(Math.cos(a) * 0.62, 0.04, Math.sin(a) * 0.62);
      strut(darkMat, v(Math.cos(a) * 0.1, 0.62, Math.sin(a) * 0.1), foot, 0.035);
      add(darkMat, new THREE.CylinderGeometry(0.09, 0.1, 0.05, 10), foot.x, 0.025, foot.z);
      strut(bodyMat, v(Math.cos(a) * 0.08, 0.45, Math.sin(a) * 0.08), v(Math.cos(a) * 0.38, 0.3, Math.sin(a) * 0.38), 0.02);
    }
    add(darkMat, new THREE.CylinderGeometry(0.1, 0.12, 0.5, 12), 0, 0.72, 0);
    add(bodyMat, new THREE.CylinderGeometry(0.2, 0.2, 0.08, 18), 0, 0.96, 0);
    flush(this.group);

    // Head: receiver, armour shield, twin barrels, ammo drum
    add(bodyMat, bevelBox(0.34, 0.28, 0.5, 0.05), 0, 0.12, 0);
    add(darkMat, bevelBox(0.3, 0.06, 0.46, 0.02), 0, -0.04, 0);
    add(bodyMat, bevelBox(0.62, 0.44, 0.05, 0.03), 0, 0.14, 0.28, -0.1);            // shield plate
    add(accentMat, bevelBox(0.62, 0.05, 0.055, 0.01), 0, 0.33, 0.29, -0.1);
    for (const sx of [-1, 1]) add(bodyMat, bevelBox(0.14, 0.36, 0.05, 0.02), sx * 0.34, 0.12, 0.22, -0.1, sx * 0.5);
    add(darkMat, new THREE.CylinderGeometry(0.12, 0.12, 0.16, 14), -0.25, 0.06, -0.08, 0, 0, Math.PI / 2); // ammo drum
    add(accentMat, bevelBox(0.06, 0.03, 0.3, 0.01), 0, 0.27, -0.04);
    flush(this.pitchPivot);

    const barrels = new THREE.Group();
    barrels.position.set(0, 0.08, 0.3);
    this.pitchPivot.add(barrels);
    for (const sx of [-1, 1]) {
      add(darkMat, new THREE.CylinderGeometry(0.028, 0.028, 0.62, 10), sx * 0.07, 0, 0.31, Math.PI / 2);
      add(darkMat, new THREE.CylinderGeometry(0.042, 0.042, 0.1, 10), sx * 0.07, 0, 0.6, Math.PI / 2); // flash hider
      this.muzzles.push(new THREE.Vector3(sx * 0.07, 0.08, 0.95));
    }
    flush(barrels);
    this.recoilParts.push(barrels);

    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), this.eyeMat);
    eye.position.set(0.1, 0.26, 0.31);
    this.pitchPivot.add(eye);
    this.eyeLocal.copy(eye.position);
    const flash = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.7), this.flashMat);
    flash.position.set(0, 0.12, 0.05);
    this.pitchPivot.add(flash);
  }

  private buildHeavyModel(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x7c8187, metalness: 0.6, roughness: 0.36 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1d21, metalness: 0.75, roughness: 0.42 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xc2a02a, metalness: 0.35, roughness: 0.5 });
    const { add, strut, flush } = Turret.parts();
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // Base: armoured octagonal plinth with buttresses, a column and a slewing ring
    add(darkMat, new THREE.CylinderGeometry(1.2, 1.35, 0.35, 8), 0, 0.175, 0);
    add(bodyMat, new THREE.CylinderGeometry(1.0, 1.15, 0.3, 8), 0, 0.5, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      add(bodyMat, bevelBox(0.3, 0.9, 0.6, 0.05), Math.cos(a) * 0.72, 0.8, Math.sin(a) * 0.72, 0, -a, 0);
      add(accentMat, bevelBox(0.31, 0.12, 0.61, 0.02), Math.cos(a) * 0.72, 1.12, Math.sin(a) * 0.72, 0, -a, 0);
    }
    add(darkMat, new THREE.CylinderGeometry(0.55, 0.65, 1.2, 12), 0, 1.3, 0);
    add(bodyMat, new THREE.CylinderGeometry(0.85, 0.85, 0.2, 20), 0, 1.95, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      add(darkMat, new THREE.CylinderGeometry(0.04, 0.04, 0.22, 6), Math.cos(a) * 0.8, 1.95, Math.sin(a) * 0.8); // bolts
    }
    flush(this.group);

    // Head: sloped armoured housing, heavy cannon with muzzle brake, sensor pod
    add(bodyMat, bevelBox(1.3, 0.8, 1.6, 0.1), 0, 0.3, -0.1);
    add(bodyMat, bevelBox(1.2, 0.35, 0.7, 0.08), 0, 0.72, -0.3, 0.25);
    add(darkMat, bevelBox(1.36, 0.14, 1.5, 0.04), 0, -0.1, -0.1);
    add(bodyMat, bevelBox(1.1, 0.6, 0.3, 0.08), 0, 0.3, 0.72, -0.35);                 // mantlet
    for (const sx of [-1, 1]) {
      add(accentMat, bevelBox(0.05, 0.5, 1.2, 0.02), sx * 0.66, 0.35, -0.1);        // hazard side stripes
      add(darkMat, bevelBox(0.26, 0.42, 0.9, 0.05), sx * 0.8, 0.3, -0.3);           // side armour boxes
    }
    add(darkMat, bevelBox(0.3, 0.3, 0.4, 0.05), 0.5, 0.82, 0.2);                     // sensor pod
    strut(darkMat, v(-0.4, 0.7, -0.6), v(-0.46, 1.4, -0.72), 0.02);                   // antenna
    flush(this.pitchPivot);

    const barrel = new THREE.Group();
    barrel.position.set(0, 0.3, 0.8);
    this.pitchPivot.add(barrel);
    add(darkMat, new THREE.CylinderGeometry(0.16, 0.2, 2.2, 16), 0, 0, 1.1, Math.PI / 2);
    add(bodyMat, new THREE.CylinderGeometry(0.24, 0.24, 0.5, 16), 0, 0, 0.35, Math.PI / 2);   // recoil sleeve
    add(darkMat, bevelBox(0.5, 0.22, 0.4, 0.04), 0, 0, 2.3);                                    // muzzle brake
    for (const sx of [-1, 1]) add(darkMat, bevelBox(0.06, 0.18, 0.1, 0.02), sx * 0.26, 0, 2.3);
    this.muzzles.push(new THREE.Vector3(0, 0.3, 3.4));
    flush(barrel);
    this.recoilParts.push(barrel);

    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.04), this.eyeMat);
    eye.position.set(0.5, 0.84, 0.41);
    this.pitchPivot.add(eye);
    this.eyeLocal.copy(eye.position);
    const flash = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.9), this.flashMat);
    flash.position.set(0, 0.35, -0.05);
    this.pitchPivot.add(flash);
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === TurretState.DESTROYED && this.stateTimer > WRECK_TIME && this.gun.inFlight === 0; }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.isDead()) return false;
    const pos = this.group.position;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const dy = p.y - pos.y;
    const r = this.spec.hitRadius;
    return dx * dx + dz * dz < r * r && dy > 0 && dy < this.spec.hitHeight;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    if (this.isDead()) return;
    this.health = Math.max(0, this.health - amount);
    this.flashTimer = 0.08;
    // Being shot from outside its arc makes it turn to look
    if (hitPoint && (this.state === TurretState.IDLE || this.state === TurretState.SEARCH)) {
      this.lastKnownTarget = hitPoint.clone();
      this.setState(TurretState.SEARCH);
    }
    if (this.health <= 0) this.destroyed = true;
  }

  private destroyed = false;

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    this.stateTimer += dt;
    this.time += dt;
    const hits = this.gun.update(ctx, this.group.position, this);

    if (this.destroyed && this.state !== TurretState.DESTROYED) {
      this.enterDestroyed(ctx);
      return hits;
    }
    if (this.state === TurretState.DESTROYED) {
      this.updateWreck(ctx);
      return hits;
    }

    const eye = this.pitchPivot.localToWorld(this.eyeLocal.clone());
    const dist = eye.distanceTo(ctx.target);
    const canSee = dist < this.spec.range && hasLineOfSight(eye, ctx.target, ctx.worldMeshes);
    if (canSee) this.lastKnownTarget = ctx.target.clone();

    switch (this.state) {
      case TurretState.IDLE: {
        // Sweep the arc around the facing it was deployed with
        const sweep = this.homeYaw + Math.sin(this.time * 0.6) * SWEEP_ARC;
        this.trackAngles(sweep, 0, dt, 0.5);
        if (canSee && this.inArcOfView(ctx.target)) this.startAcquire();
        break;
      }

      case TurretState.ACQUIRE: {
        this.trackTarget(ctx, dt);
        this.showSight(ctx, 0.008 + 0.01 * (this.stateTimer * 4 % 1), 0.6);
        const lockTime = ctx.targetIsTitan ? this.spec.acquireTimeTitan : this.spec.acquireTime;
        if (!canSee) this.setState(TurretState.SEARCH);
        else if (this.stateTimer >= lockTime) {
          this.burstLeft = this.spec.burst;
          this.setState(TurretState.FIRING);
        }
        break;
      }

      case TurretState.FIRING: {
        const error = this.trackTarget(ctx, dt);
        this.showSight(ctx, 0.01, 0.35);
        if (!canSee) {
          this.setState(TurretState.SEARCH);
          break;
        }
        this.fireTimer -= dt;
        if (this.burstLeft <= 0) {
          this.burstPause -= dt;
          if (this.burstPause <= 0) this.burstLeft = this.spec.burst;
        } else if (this.fireTimer <= 0 && error < this.spec.fireCone) {
          this.shoot(ctx);
          this.fireTimer = ctx.targetIsTitan ? this.spec.fireInterval : this.spec.fireIntervalPilot;
          this.burstLeft--;
          if (this.burstLeft === 0) this.burstPause = this.spec.burstPause;
        }
        break;
      }

      case TurretState.SEARCH:
        this.sight.visible = false;
        if (this.lastKnownTarget) this.aimAt(this.lastKnownTarget, dt);
        if (canSee) this.startAcquire();
        else if (this.stateTimer > SEARCH_TIME) {
          this.lastKnownTarget = null;
          this.setState(TurretState.IDLE);
        }
        break;
    }

    this.animate(dt);
    return hits;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.remove(this.sight);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.sightMat.dispose();
    this.gun.dispose();
  }

  /* ------------------------------ Aiming ------------------------------ */

  private setState(state: TurretState): void {
    this.state = state;
    this.stateTimer = 0;
  }

  private startAcquire(): void {
    this.setState(TurretState.ACQUIRE);
    soundManager.playSound('power_up', this.variant === 'titan' ? 0.35 : 0.2);
  }

  /** Targets directly behind a sweeping turret aren't noticed until it turns (or gets shot). */
  private inArcOfView(target: THREE.Vector3): boolean {
    const yaw = yawTowards(this.group.position, target);
    const diff = Math.atan2(Math.sin(yaw - this.yawPivot.rotation.y), Math.cos(yaw - this.yawPivot.rotation.y));
    return Math.abs(diff) < 1.3;
  }

  private pivotWorld(): THREE.Vector3 {
    return this.group.position.clone().setY(this.group.position.y + this.spec.pivotHeight);
  }

  /** Turn towards the (led) target; returns the remaining aim error in radians. */
  private trackTarget(ctx: HostileContext, dt: number): number {
    const pivot = this.pivotWorld();
    const lead = leadTarget(pivot, ctx.target, ctx.targetVelocity, this.spec.bulletSpeed);
    return this.aimAt(lead, dt);
  }

  private aimAt(point: THREE.Vector3, dt: number): number {
    const pivot = this.pivotWorld();
    const yaw = yawTowards(pivot, point);
    const pitch = THREE.MathUtils.clamp(pitchTowards(pivot, point), PITCH_MIN, PITCH_MAX);
    this.trackAngles(yaw, pitch, dt, 1);
    const yawErr = Math.abs(Math.atan2(Math.sin(yaw - this.yawPivot.rotation.y), Math.cos(yaw - this.yawPivot.rotation.y)));
    return Math.max(yawErr, Math.abs(pitch + this.pitchPivot.rotation.x));
  }

  private trackAngles(yaw: number, pitch: number, dt: number, rateScale: number): void {
    this.yawPivot.rotation.y = turnTowards(this.yawPivot.rotation.y, yaw, this.spec.yawRate * rateScale * dt);
    // rotation.x is negative for "up" (rotating +Z towards +Y)
    const current = -this.pitchPivot.rotation.x;
    const step = this.spec.pitchRate * rateScale * dt;
    this.pitchPivot.rotation.x = -(current + THREE.MathUtils.clamp(pitch - current, -step, step));
  }

  private showSight(ctx: HostileContext, radius: number, opacity: number): void {
    const from = this.pitchPivot.localToWorld(this.eyeLocal.clone());
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pitchPivot.getWorldQuaternion(new THREE.Quaternion()));
    const ray = new THREE.Raycaster(from, dir, 0, this.spec.range);
    const hit = ray.intersectObjects(ctx.worldMeshes, false)[0];
    let len = hit ? hit.distance : this.spec.range;
    // Stop the dot on the target if the beam is on it
    const toTarget = ctx.target.clone().sub(from);
    const along = toTarget.dot(dir);
    if (along > 0 && along < len && toTarget.clone().addScaledVector(dir, -along).length() < ctx.hitbox.radius) len = along;
    this.sight.position.copy(from);
    this.sight.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.sight.scale.set(radius, len, radius);
    this.sightMat.opacity = opacity;
    this.sight.visible = true;
  }

  /* ------------------------------ Weapon ------------------------------ */

  private shoot(ctx: HostileContext): void {
    this.group.updateMatrixWorld(true);
    const local = this.muzzles[this.muzzleIndex % this.muzzles.length];
    this.muzzleIndex++;
    const muzzle = this.pitchPivot.localToWorld(local.clone());
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pitchPivot.getWorldQuaternion(new THREE.Quaternion()));
    applySpread(dir, THREE.MathUtils.degToRad(this.spec.spreadDeg));
    // Heavy shells drop a little: aim slightly high over distance
    if (this.variant === 'titan') dir.y += muzzle.distanceTo(ctx.target) * 0.0006;
    this.gun.fire(muzzle, dir.normalize().multiplyScalar(this.spec.bulletSpeed));
    this.recoil = 1;
    if (this.variant === 'titan') {
      ctx.effects.spawnMuzzleFlash(muzzle, dir, { ...DEFAULT_MUZZLE_CONFIG, color: 0xffaa55, radius: 0.5, life: 0.1 });
      flashLight(muzzle, 0xffaa55, 40, 12, 0.12);
      soundManager.playSound('heavy_cannon', 0.6);
    } else {
      ctx.effects.spawnMuzzleFlash(muzzle, dir, { ...DEFAULT_MUZZLE_CONFIG, color: 0xffcc66, radius: 0.1 });
      if (this.muzzleIndex % 3 === 0) flashLight(muzzle, 0xffbb55, 12, 5, 0.05);
      soundManager.playSound('turret_fire', 0.25);
    }
  }

  /* ---------------------------- Destruction --------------------------- */

  private enterDestroyed(ctx: HostileContext): void {
    this.setState(TurretState.DESTROYED);
    this.sight.visible = false;
    const center = this.pivotWorld();
    ctx.effects.spawnExplosion(center, FRAG_EXPLOSION_CONFIG);
    flashLight(center, 0xff6622, this.variant === 'titan' ? 70 : 40, this.variant === 'titan' ? 16 : 10, 0.35);
    soundManager.playSound('explosion', this.variant === 'titan' ? 0.7 : 0.45);
    this.eyeMat.color.setRGB(0.04, 0.02, 0.02);
    this.flashMat.opacity = 0;
  }

  private updateWreck(ctx: HostileContext): void {
    const dt = ctx.delta;
    // Head slumps forward and sideways, sparks now and then, then the wreck sinks
    const t = Math.min(1, this.stateTimer / 0.5);
    this.pitchPivot.rotation.x = THREE.MathUtils.lerp(this.pitchPivot.rotation.x, 0.45, t * 0.2);
    this.pitchPivot.rotation.z = THREE.MathUtils.lerp(this.pitchPivot.rotation.z, 0.2, t * 0.2);
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0 && this.stateTimer < WRECK_TIME - 1.5) {
      this.smokeTimer = 0.25 + Math.random() * 0.4;
      const p = this.pivotWorld().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.2, (Math.random() - 0.5) * 0.6));
      ctx.effects.spawnImpact(p, new THREE.Vector3(0, 1, 0), PLAYER_IMPACT_CONFIG);
    }
    if (this.stateTimer > WRECK_TIME - 1.5) this.group.position.y -= dt * 1.2;
  }

  /* ---------------------------- Animation ----------------------------- */

  private animate(dt: number): void {
    this.recoil = Math.max(0, this.recoil - dt * (this.variant === 'titan' ? 3 : 18));
    const kick = this.variant === 'titan' ? 0.45 : 0.05;
    for (const part of this.recoilParts) part.position.z = (this.variant === 'titan' ? 0.8 : 0.3) - this.recoil * kick;

    const locked = this.state === TurretState.ACQUIRE || this.state === TurretState.FIRING;
    const blink = this.state === TurretState.ACQUIRE ? (Math.sin(this.stateTimer * 30) > 0 ? 7 : 2) : locked ? 5 : 2.5;
    this.eyeMat.color.set(0xff2a14).multiplyScalar(blink);
    if (!locked) this.sight.visible = false;
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flashMat.opacity = this.flashTimer * 5;
  }
}

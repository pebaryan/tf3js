import * as THREE from 'three';
import type { Damageable } from './types';
import type { ImpactEffectsRenderer } from './effects';

/*
 * Shared contract for every AI enemy (grunts, ticks, reapers).
 *
 * Game owns the list of hostiles and calls update() once per frame with a
 * context describing the target and the world. Hostiles never touch the
 * player or titan directly: they return HostileHit records and Game routes
 * the damage to the pilot or to the titan being piloted.
 */

export type HostileKind = 'grunt' | 'tick' | 'reaper' | 'stalker' | 'drone' | 'turret';

export interface HostileHit {
  damage: number;
  /** Where the damage came from (for the damage-direction indicator). */
  source: THREE.Vector3;
}

export interface TargetHitbox {
  center: THREE.Vector3;
  radius: number;
}

export interface HostileContext {
  delta: number;
  /** Point to aim/move at: the pilot's centre, or the titan's torso while piloting. */
  target: THREE.Vector3;
  targetVelocity: THREE.Vector3;
  /** True while the player is inside a titan (grunts run from titans). */
  targetIsTitan: boolean;
  hitbox: TargetHitbox;
  /** Opaque level geometry for line-of-sight, movement and projectile collision. */
  worldMeshes: THREE.Mesh[];
  /** Every hostile alive this frame (for squad communication). */
  hostiles: readonly Hostile[];
  /** Shared world-space effects (explosions, impacts) that outlive whoever spawned them. */
  effects: ImpactEffectsRenderer;
  /** Add a new hostile to the world (reapers launching ticks). */
  spawn: (hostile: Hostile) => void;
}

export interface Hostile extends Damageable {
  readonly kind: HostileKind;
  /** Score awarded when killed. */
  readonly scoreValue: number;
  update(ctx: HostileContext): HostileHit[];
  /** Health reached zero (it may still be playing a death animation). */
  isDead(): boolean;
  /** Death animation finished; safe to dispose and remove. */
  isFinished(): boolean;
  dispose(): void;
  /**
   * Cloak support (units a cloak drone can hide). Call every frame the unit
   * should stay cloaked; the cloak fades out shortly after the calls stop.
   */
  refreshCloak?(): void;
  /** Mostly invisible right now (hidden from the radar too). */
  isCloaked?(): boolean;
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

const _raycaster = new THREE.Raycaster();
const _dir = new THREE.Vector3();

/** True if nothing in `meshes` blocks the straight line between `from` and `to`. */
export function hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3, meshes: THREE.Mesh[]): boolean {
  _dir.copy(to).sub(from);
  const dist = _dir.length();
  if (dist < 0.1) return true;
  _raycaster.set(from, _dir.divideScalar(dist));
  _raycaster.far = dist;
  return _raycaster.intersectObjects(meshes, false).length === 0;
}

/**
 * Move `object` horizontally by (dx, dz) unless a wall blocks the path at any
 * of `heights` (probe rays at those heights above the object's origin).
 * Returns false if blocked.
 */
export function tryMoveHorizontal(
  object: THREE.Object3D,
  dx: number,
  dz: number,
  meshes: THREE.Mesh[],
  radius: number,
  heights: readonly number[],
): boolean {
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) return true;
  _dir.set(dx / distance, 0, dz / distance);
  const origin = new THREE.Vector3();
  for (const h of heights) {
    origin.copy(object.position);
    origin.y += h;
    _raycaster.set(origin, _dir);
    _raycaster.far = distance + radius;
    if (_raycaster.intersectObjects(meshes, false).length > 0) return false;
  }
  object.position.x += dx;
  object.position.z += dz;
  return true;
}

/** Yaw (rotation about Y) that makes a +Z-forward object face from `from` towards `to`. */
export function yawTowards(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** Rotate `current` yaw towards `target` by at most `maxStep` radians, taking the short way round. */
export function turnTowards(current: number, target: number, maxStep: number): number {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/**
 * Rotate direction `current` towards `desired` by at most `maxAngle` radians
 * (homing missiles). Both are treated as directions; the result has the
 * length of `current`.
 */
export function steerTowards(current: THREE.Vector3, desired: THREE.Vector3, maxAngle: number): THREE.Vector3 {
  const speed = current.length();
  if (speed < 1e-6) return desired.clone().setLength(1e-6);
  const a = current.clone().normalize();
  const b = desired.clone().normalize();
  const angle = a.angleTo(b);
  if (angle <= maxAngle || angle < 1e-6) return b.multiplyScalar(speed);
  const axis = new THREE.Vector3().crossVectors(a, b);
  if (axis.lengthSq() < 1e-10) {
    // Exactly opposite: pick any perpendicular axis
    axis.set(0, 1, 0);
    if (Math.abs(a.y) > 0.9) axis.set(1, 0, 0);
  }
  axis.normalize();
  return a.applyAxisAngle(axis, maxAngle).multiplyScalar(speed);
}

/**
 * Pick the best cover spot from candidates. A good spot hides the unit from
 * the threat, is reachable in a straight line, is close to the unit and not
 * too close to the threat. Returns the index of the chosen candidate or -1.
 */
export interface CoverCandidate {
  position: THREE.Vector3;
  hidden: boolean;
  reachable: boolean;
}

export function chooseCover(candidates: readonly CoverCandidate[], self: THREE.Vector3, threat: THREE.Vector3, minThreatDistance = 6): number {
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    if (!c.hidden || !c.reachable) return;
    const toThreat = c.position.distanceTo(threat);
    if (toThreat < minThreatDistance) return;
    // Prefer short runs, and spots that don't bring us closer to the threat
    const score = c.position.distanceTo(self) + Math.max(0, self.distanceTo(threat) - toThreat) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * Where to aim so a projectile fired at `speed` from `shooter` meets a target
 * at `target` moving with constant `velocity`. Falls back to the target's
 * current position when no intercept exists (target outrunning the round).
 */
export function leadTarget(shooter: THREE.Vector3, target: THREE.Vector3, velocity: THREE.Vector3, speed: number): THREE.Vector3 {
  const rel = target.clone().sub(shooter);
  const a = velocity.lengthSq() - speed * speed;
  const b = 2 * rel.dot(velocity);
  const c = rel.lengthSq();
  let t: number;
  if (Math.abs(a) < 1e-6) {
    t = b !== 0 ? -c / b : -1;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return target.clone();
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  }
  if (!(t > 0)) return target.clone();
  return target.clone().addScaledVector(velocity, t);
}

/** Pitch (rotation about X, positive = up) to look from `from` towards `to`. */
export function pitchTowards(from: THREE.Vector3, to: THREE.Vector3): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.atan2(to.y - from.y, Math.hypot(dx, dz));
}

/** Opacity multiplier for a cloak that is `amount` (0..1) engaged: never fully invisible. */
export function cloakOpacity(amount: number): number {
  return 1 - 0.9 * THREE.MathUtils.clamp(amount, 0, 1);
}

/**
 * Fades every opaque material under `root` in and out for the cloak effect.
 * Materials that are already transparent (hit flashes, glows with their own
 * fades) are left alone. Each unit owns its materials, so this never leaks
 * onto another unit.
 */
export class CloakController {
  private readonly materials: { mat: THREE.Material; opacity: number }[] = [];
  private readonly meshes: { mesh: THREE.Mesh; castShadow: boolean }[] = [];
  private amount = 0;
  private hold = 0;
  private applied = -1;
  private time = Math.random() * 10;

  constructor(root: THREE.Object3D) {
    const seen = new Set<THREE.Material>();
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshes.push({ mesh, castShadow: mesh.castShadow });
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seen.has(mat) || mat.transparent) continue;
        seen.add(mat);
        this.materials.push({ mat, opacity: mat.opacity });
      }
    });
  }

  /** Keep the cloak up for a little longer. */
  refresh(): void {
    this.hold = 0.35;
  }

  get engaged(): boolean {
    return this.amount > 0.5;
  }

  update(dt: number): void {
    this.hold = Math.max(0, this.hold - dt);
    const target = this.hold > 0 ? 1 : 0;
    this.amount += (target - this.amount) * Math.min(1, dt * 4);
    if (Math.abs(this.amount - target) < 0.01) this.amount = target;
    this.time += dt;
    if (this.amount === 0 && this.applied === 0) return;

    // Faint shimmer so a sharp-eyed pilot can still pick them out
    const shimmer = this.amount > 0 ? 0.05 * Math.sin(this.time * 9) * this.amount : 0;
    const k = THREE.MathUtils.clamp(cloakOpacity(this.amount) + shimmer, 0, 1);
    for (const { mat, opacity } of this.materials) {
      const cloaked = this.amount > 0;
      if (mat.transparent !== cloaked) {
        // Transparency is part of the shader's program key (OPAQUE define)
        mat.transparent = cloaked;
        mat.needsUpdate = true;
      }
      mat.depthWrite = !cloaked || this.amount < 0.5;
      mat.opacity = opacity * k;
    }
    for (const { mesh, castShadow } of this.meshes) mesh.castShadow = castShadow && this.amount < 0.5;
    this.applied = this.amount;
  }
}

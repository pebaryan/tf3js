import * as THREE from 'three';

/*
 * Pure logic for the Colossus boss (no scene access), kept separate so it can
 * be unit-tested: leg IK, pose keyframing and attack selection.
 */

/**
 * Two-bone leg IK in the leg's sagittal (Y/Z) plane. `dy`/`dz` is the ankle
 * relative to the hip (dy < 0 below, dz > 0 forward). Returns rotations about
 * X for hip, knee and ankle such that the knee bends forward and the foot
 * stays level. Conventions match Three.js: a bone hanging along -Y rotated by
 * a negative X angle swings forward.
 */
export function legIK(thigh: number, shin: number, dy: number, dz: number): { hip: number; knee: number; ankle: number } {
  const max = thigh + shin;
  const d = THREE.MathUtils.clamp(Math.hypot(dy, dz), max * 0.3, max * 0.999);
  const phi = Math.atan2(dz, -dy); // forward angle of the hip→ankle line from straight down
  const a1 = Math.acos(THREE.MathUtils.clamp((thigh * thigh + d * d - shin * shin) / (2 * thigh * d), -1, 1));
  const a2 = Math.acos(THREE.MathUtils.clamp((shin * shin + d * d - thigh * thigh) / (2 * shin * d), -1, 1));
  const hip = -(phi + a1);
  const knee = a1 + a2;
  return { hip, knee, ankle: -(hip + knee) };
}

/** Forward kinematics for `legIK` (used by tests): ankle position relative to the hip. */
export function legFK(thigh: number, shin: number, hip: number, knee: number): { dy: number; dz: number } {
  // A bone along -Y rotated by angle a about X ends at (y, z) = (-cos a, -sin a) * length
  const a = hip;
  const b = hip + knee;
  return {
    dy: -Math.cos(a) * thigh - Math.cos(b) * shin,
    dz: -Math.sin(a) * thigh - Math.sin(b) * shin,
  };
}

/** Joint targets the boss animates between. Angles in radians, crouch/lift in metres. */
export interface ColossusPose {
  /** How far the pelvis drops (knees bend to keep the feet planted). */
  crouch: number;
  /** Torso pitch: positive leans forward. */
  lean: number;
  /** Torso yaw relative to the hips: positive turns the right shoulder forward. */
  twist: number;
  headX: number;
  /** Shoulder pitch (negative swings the arm forward/up), abduction, elbow bend. */
  lShX: number; lShZ: number; lEl: number;
  rShX: number; rShZ: number; rEl: number;
  /** Foot lift and forward offset when not walking (stomps, kneeling). */
  lFootLift: number; lFootZ: number;
  rFootLift: number; rFootZ: number;
}

export const NEUTRAL_POSE: ColossusPose = {
  crouch: 0.3, lean: 0.12, twist: 0, headX: 0.12,
  lShX: -0.35, lShZ: 0.2, lEl: -0.75,
  rShX: -0.35, rShZ: -0.2, rEl: -0.75,
  lFootLift: 0, lFootZ: 0.4, rFootLift: 0, rFootZ: -0.4,
};

export function pose(p: Partial<ColossusPose>): ColossusPose {
  return { ...NEUTRAL_POSE, ...p };
}

export type PoseKey = [time: number, pose: ColossusPose];

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Sample keyframes at `time` with smoothstep easing between keys (clamped at both ends). */
export function samplePose(keys: readonly PoseKey[], time: number, out: ColossusPose = { ...NEUTRAL_POSE }): ColossusPose {
  if (keys.length === 0) return Object.assign(out, NEUTRAL_POSE);
  if (time <= keys[0][0]) return Object.assign(out, keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1] = keys[i];
    if (time <= t1) {
      const [t0, p0] = keys[i - 1];
      const u = smooth(THREE.MathUtils.clamp((time - t0) / Math.max(1e-6, t1 - t0), 0, 1));
      for (const k of Object.keys(p0) as (keyof ColossusPose)[]) out[k] = p0[k] + (p1[k] - p0[k]) * u;
      return out;
    }
  }
  return Object.assign(out, keys[keys.length - 1][1]);
}

export type ColossusAttack = 'sweep' | 'slam' | 'stomp' | 'mortar' | 'beam' | 'leap';

/**
 * Pick the next attack from the target's distance and bearing (radians,
 * 0 = straight ahead) with some randomness, avoiding repeating the last one.
 * Returns null when it should close the distance (or turn) first.
 */
export function chooseColossusAttack(
  distance: number,
  bearing: number,
  phase: 1 | 2,
  last: ColossusAttack | null,
  rand: () => number = Math.random,
): ColossusAttack | null {
  const behind = Math.abs(bearing) > 1.7;
  const inFront = Math.abs(bearing) < 0.9;
  const weights: [ColossusAttack, number][] = [];
  if (distance < 9) {
    if (behind || distance < 5) weights.push(['stomp', 3]);
    if (inFront) weights.push(['sweep', 3], ['slam', 1.5]);
    if (!inFront && !behind) weights.push(['stomp', 1.5]);
  } else if (distance < 17) {
    if (inFront) weights.push(['slam', 3]);
    if (inFront && distance < 13) weights.push(['sweep', 1.5]);
    if (phase === 2) weights.push(['leap', 0.9], ['beam', 1.1]);
    weights.push(['mortar', 0.6]);
  } else {
    weights.push(['mortar', 2.2]);
    if (phase === 2) weights.push(['beam', 2], ['leap', 1.1]);
  }
  const pool = weights.map(([a, w]) => [a, a === last ? w * 0.25 : w] as [ColossusAttack, number]);
  const total = pool.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return null;
  // Far away in phase 1 there's a fair chance it just walks in instead
  if (distance >= 17 && phase === 1 && rand() < 0.35) return null;
  let r = rand() * total;
  for (const [a, w] of pool) {
    r -= w;
    if (r <= 0) return a;
  }
  return pool[pool.length - 1][0];
}

/** Damage multiplier for where a round hit the boss. */
export type ColossusHitZone = 'core' | 'knee' | 'head' | 'armor';

export function colossusDamageMultiplier(zone: ColossusHitZone, staggered: boolean): number {
  const base = zone === 'core' ? 2.5 : zone === 'knee' ? 1.5 : zone === 'head' ? 1.5 : 0.35;
  return staggered ? base * 1.6 : base;
}

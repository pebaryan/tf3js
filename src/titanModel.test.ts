import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  TITAN_ANKLE_HEIGHT, TITAN_FOREARM_LENGTH, TITAN_HIP_HEIGHT, TITAN_SHIN_LENGTH, TITAN_SHOULDER,
  TITAN_THIGH_LENGTH, TITAN_UPPER_ARM_LENGTH, XO16_MOUNTS, solveArmIK, solveTwoBoneIK,
} from './titanModel';

/** Forward kinematics in the sagittal plane: returns the ankle's (z, y) relative to the hip. */
function ankle(thigh: number, shin: number, hip: number, knee: number): { z: number; y: number } {
  // Rotation about X by θ maps down (0, -1, 0) to (0, -cos θ, -sin θ) in (y, z)
  const a1 = hip;
  const a2 = hip + knee;
  return {
    y: -thigh * Math.cos(a1) - shin * Math.cos(a2),
    z: -thigh * Math.sin(a1) - shin * Math.sin(a2),
  };
}

describe('solveTwoBoneIK', () => {
  it('places the ankle directly below the hip at the requested distance', () => {
    for (const d of [4.6, 3.5, 2.4, 1.8]) {
      const { hip, knee } = solveTwoBoneIK(2.4, 2.3, d);
      const p = ankle(2.4, 2.3, hip, knee);
      expect(p.y).toBeCloseTo(-d, 5);
      expect(p.z).toBeCloseTo(0, 5);
    }
  });

  it('bends the knee forward (+z) like a biped', () => {
    const { hip } = solveTwoBoneIK(2.4, 2.3, 3);
    expect(hip).toBeLessThan(0);
    // Knee position: rotate down by `hip` about X
    expect(-2.4 * Math.sin(hip)).toBeGreaterThan(0);
  });

  it('keeps the foot flat: hip + knee + ankle = 0', () => {
    const { hip, knee, ankle: a } = solveTwoBoneIK(2.4, 2.3, 2.9);
    expect(hip + knee + a).toBeCloseTo(0, 10);
  });

  it('straightens out instead of producing NaN when the target is out of reach', () => {
    const r = solveTwoBoneIK(2.4, 2.3, 10);
    expect(r.hip).toBeCloseTo(0);
    expect(r.knee).toBeCloseTo(0);
    const tooClose = solveTwoBoneIK(2.4, 2.3, 0);
    expect(Number.isFinite(tooClose.hip)).toBe(true);
    expect(Number.isFinite(tooClose.knee)).toBe(true);
  });
});

describe('solveArmIK', () => {
  const shoulder = new THREE.Vector3(2.55, 0.75, -0.1);
  const pole = new THREE.Vector3(1, -0.2, -0.7);

  it('reaches a target within range with correct bone lengths', () => {
    const target = new THREE.Vector3(0.5, -1.4, 2.0);
    const { elbow, hand } = solveArmIK(shoulder, target, 2.2, 2.4, pole);
    expect(hand.distanceTo(target)).toBeLessThan(1e-6);
    expect(elbow.distanceTo(shoulder)).toBeCloseTo(2.2, 5);
    expect(elbow.distanceTo(hand)).toBeCloseTo(2.4, 5);
  });

  it('bends the elbow towards the pole', () => {
    const target = new THREE.Vector3(0.5, -1.4, 2.0);
    const { elbow } = solveArmIK(shoulder, target, 2.2, 2.4, pole);
    const mid = shoulder.clone().add(target).multiplyScalar(0.5);
    expect(elbow.clone().sub(mid).dot(pole)).toBeGreaterThan(0);
  });

  it('stretches straight towards an out-of-reach target without NaNs', () => {
    const target = new THREE.Vector3(-10, 0, 10);
    const { elbow, hand } = solveArmIK(shoulder, target, 2.2, 2.4, pole);
    expect(hand.distanceTo(shoulder)).toBeCloseTo(4.6, 2);
    expect(Number.isFinite(elbow.x + elbow.y + elbow.z)).toBe(true);
  });
});

describe('titan proportions', () => {
  it('stands with the knees slightly bent, not locked straight', () => {
    const { knee } = solveTwoBoneIK(TITAN_THIGH_LENGTH, TITAN_SHIN_LENGTH, TITAN_HIP_HEIGHT - TITAN_ANKLE_HEIGHT);
    const degrees = THREE.MathUtils.radToDeg(knee);
    expect(degrees).toBeGreaterThan(25);
    expect(degrees).toBeLessThan(70);
  });

  it('can reach both grips of every XO-16 mount without over-stretching', () => {
    const reach = TITAN_UPPER_ARM_LENGTH + TITAN_FOREARM_LENGTH;
    const leftShoulder = TITAN_SHOULDER.clone().setX(-TITAN_SHOULDER.x);
    for (const mount of Object.values(XO16_MOUNTS)) {
      const main = mount.mainGrip.clone().add(mount.position);
      const support = mount.supportGrip.clone().add(mount.position);
      expect(main.distanceTo(TITAN_SHOULDER)).toBeLessThan(reach * 0.97);
      expect(support.distanceTo(leftShoulder)).toBeLessThan(reach * 0.97);
    }
  });
});

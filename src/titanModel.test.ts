import { describe, expect, it } from 'vitest';
import { solveTwoBoneIK } from './titanModel';

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

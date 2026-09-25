import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { chooseCover, steerTowards, turnTowards, yawTowards } from './hostile';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('yawTowards', () => {
  it('returns 0 when the target is straight ahead (+z)', () => {
    expect(yawTowards(v(0, 0, 0), v(0, 0, 5))).toBeCloseTo(0);
  });
  it('returns +90° for a target on +x', () => {
    expect(yawTowards(v(0, 0, 0), v(5, 0, 0))).toBeCloseTo(Math.PI / 2);
  });
});

describe('turnTowards', () => {
  it('limits the turn to maxStep', () => {
    expect(turnTowards(0, 1, 0.1)).toBeCloseTo(0.1);
  });
  it('snaps when within reach', () => {
    expect(turnTowards(0, 0.05, 0.1)).toBeCloseTo(0.05);
  });
  it('takes the short way round across ±π', () => {
    // From 170° to -170° is a 20° turn through 180°, not 340° the other way
    const next = turnTowards(THREE.MathUtils.degToRad(170), THREE.MathUtils.degToRad(-170), THREE.MathUtils.degToRad(5));
    expect(THREE.MathUtils.radToDeg(next)).toBeCloseTo(175);
  });
});

describe('steerTowards', () => {
  it('keeps speed while turning by at most the max angle', () => {
    const out = steerTowards(v(10, 0, 0), v(0, 0, 1), 0.2);
    expect(out.length()).toBeCloseTo(10);
    expect(out.angleTo(v(1, 0, 0))).toBeCloseTo(0.2);
  });
  it('aligns fully when the desired direction is within the max angle', () => {
    const out = steerTowards(v(5, 0, 0), v(1, 0.05, 0), 0.5);
    expect(out.clone().normalize().angleTo(v(1, 0.05, 0).normalize())).toBeCloseTo(0);
  });
  it('handles exactly opposite directions without NaN', () => {
    const out = steerTowards(v(1, 0, 0), v(-1, 0, 0), 0.3);
    expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
    expect(out.angleTo(v(1, 0, 0))).toBeCloseTo(0.3);
  });
});

describe('chooseCover', () => {
  const self = v(0, 0, 0);
  const threat = v(0, 0, 20);

  it('ignores spots the threat can see or that cannot be reached', () => {
    const best = chooseCover([
      { position: v(1, 0, 0), hidden: false, reachable: true },
      { position: v(2, 0, 0), hidden: true, reachable: false },
    ], self, threat);
    expect(best).toBe(-1);
  });

  it('picks the nearest hidden, reachable spot', () => {
    const best = chooseCover([
      { position: v(8, 0, 0), hidden: true, reachable: true },
      { position: v(3, 0, -1), hidden: true, reachable: true },
    ], self, threat);
    expect(best).toBe(1);
  });

  it('rejects cover that is too close to the threat', () => {
    const best = chooseCover([{ position: v(0, 0, 17), hidden: true, reachable: true }], self, threat, 6);
    expect(best).toBe(-1);
  });

  it('prefers not to run towards the threat', () => {
    const best = chooseCover([
      { position: v(0, 0, 4), hidden: true, reachable: true },   // 4 m, but 4 m closer to the threat
      { position: v(0, 0, -5), hidden: true, reachable: true },  // 5 m, away from the threat
    ], self, threat);
    expect(best).toBe(1);
  });
});

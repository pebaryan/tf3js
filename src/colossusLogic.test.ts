import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_POSE, chooseColossusAttack, colossusDamageMultiplier, legFK, legIK, pose, samplePose,
} from './colossusLogic';

describe('legIK', () => {
  it('reaches the requested ankle position with the knee bent forward', () => {
    for (const [dy, dz] of [[-6.6, 0], [-5.5, 1.5], [-6, -1.2], [-3.5, 2.5]]) {
      const { hip, knee, ankle } = legIK(4, 3.8, dy, dz);
      const fk = legFK(4, 3.8, hip, knee);
      expect(fk.dy).toBeCloseTo(dy, 4);
      expect(fk.dz).toBeCloseTo(dz, 4);
      expect(knee).toBeGreaterThan(0);
      // Foot stays level
      expect(hip + knee + ankle).toBeCloseTo(0, 6);
      // Knee sits in front of the hip→ankle line
      const kneeZ = -Math.sin(hip) * 4;
      expect(kneeZ).toBeGreaterThan(dz * (4 / 7.8) - 1e-6);
    }
  });

  it('clamps unreachable targets to a nearly straight leg (never locks the knee)', () => {
    const { hip, knee } = legIK(4, 3.8, -20, 0);
    expect(knee).toBeGreaterThan(0);
    expect(knee).toBeLessThan(0.15);
    expect(Math.abs(hip)).toBeLessThan(0.1);
  });
});

describe('samplePose', () => {
  const keys = [
    [0, NEUTRAL_POSE],
    [1, pose({ lean: 1, crouch: 2 })],
  ] as const;

  it('clamps before and after the keys', () => {
    expect(samplePose(keys as never, -1).lean).toBeCloseTo(NEUTRAL_POSE.lean);
    expect(samplePose(keys as never, 5).crouch).toBeCloseTo(2);
  });

  it('eases between keys (smoothstep: halfway in time is halfway in value)', () => {
    const mid = samplePose(keys as never, 0.5);
    expect(mid.lean).toBeCloseTo((NEUTRAL_POSE.lean + 1) / 2);
    const early = samplePose(keys as never, 0.1);
    // Slow start: less than 10% of the way there
    expect(early.crouch - NEUTRAL_POSE.crouch).toBeLessThan((2 - NEUTRAL_POSE.crouch) * 0.1);
  });
});

describe('chooseColossusAttack', () => {
  const pick = (d: number, b: number, phase: 1 | 2, r: number) => chooseColossusAttack(d, b, phase, null, () => r);

  it('stomps a pilot hiding behind or under it', () => {
    for (const r of [0.1, 0.5, 0.9]) expect(pick(4, Math.PI, 1, r)).toBe('stomp');
  });

  it('only uses the beam and the leap in phase 2', () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 50; i++) seen.add(pick(25, 0, 1, i / 50));
    expect(seen.has('beam')).toBe(false);
    expect(seen.has('leap')).toBe(false);
    const seen2 = new Set<string | null>();
    for (let i = 0; i < 50; i++) seen2.add(pick(25, 0, 2, i / 50));
    expect(seen2.has('beam')).toBe(true);
    expect(seen2.has('leap')).toBe(true);
  });

  it('prefers melee in front at close range', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      const a = pick(7, 0, 1, (i + 0.5) / 100) ?? 'none';
      counts[a] = (counts[a] ?? 0) + 1;
    }
    expect((counts.sweep ?? 0) + (counts.slam ?? 0)).toBeGreaterThan(80);
  });

  it('rarely repeats the previous attack', () => {
    let repeats = 0;
    for (let i = 0; i < 100; i++) if (chooseColossusAttack(12, 0, 2, 'slam', () => (i + 0.5) / 100) === 'slam') repeats++;
    expect(repeats).toBeLessThan(35);
  });
});

describe('colossusDamageMultiplier', () => {
  it('rewards weak points and punishes armour hits, more so while staggered', () => {
    expect(colossusDamageMultiplier('core', false)).toBeGreaterThan(colossusDamageMultiplier('knee', false));
    expect(colossusDamageMultiplier('armor', false)).toBeLessThan(0.5);
    expect(colossusDamageMultiplier('core', true)).toBeGreaterThan(colossusDamageMultiplier('core', false));
  });
});

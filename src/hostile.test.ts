import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CloakController, chooseCover, cloakOpacity, leadTarget, pitchTowards, steerTowards, turnTowards, yawTowards } from './hostile';

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

describe('leadTarget', () => {
  it('aims at a stationary target directly', () => {
    const aim = leadTarget(v(0, 0, 0), v(0, 0, 20), v(0, 0, 0), 50);
    expect(aim.distanceTo(v(0, 0, 20))).toBeCloseTo(0);
  });
  it('leads a crossing target so the round and target meet', () => {
    const shooter = v(0, 0, 0);
    const target = v(0, 0, 30);
    const vel = v(8, 0, 0);
    const speed = 60;
    const aim = leadTarget(shooter, target, vel, speed);
    expect(aim.x).toBeGreaterThan(0);
    // Time for the round to reach the aim point equals the time for the target to get there
    const tRound = aim.length() / speed;
    const tTarget = aim.distanceTo(target) / vel.length();
    expect(tRound).toBeCloseTo(tTarget, 4);
  });
  it('falls back to the current position when the target outruns the round', () => {
    const aim = leadTarget(v(0, 0, 0), v(0, 0, 10), v(0, 0, 100), 20);
    expect(aim.distanceTo(v(0, 0, 10))).toBeCloseTo(0);
  });
});

describe('pitchTowards', () => {
  it('is zero for a level target and positive for a higher one', () => {
    expect(pitchTowards(v(0, 1, 0), v(0, 1, 10))).toBeCloseTo(0);
    expect(pitchTowards(v(0, 0, 0), v(0, 10, 10))).toBeCloseTo(Math.PI / 4);
    expect(pitchTowards(v(0, 10, 0), v(10, 0, 0))).toBeCloseTo(-Math.PI / 4);
  });
});

describe('cloak', () => {
  it('never makes a unit fully invisible', () => {
    expect(cloakOpacity(0)).toBe(1);
    expect(cloakOpacity(1)).toBeGreaterThan(0);
    expect(cloakOpacity(1)).toBeLessThan(0.2);
  });

  it('fades opaque materials while refreshed, restores them after, and skips transparent ones', () => {
    const root = new THREE.Group();
    const body = new THREE.MeshStandardMaterial();
    const flash = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3 });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), body));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), flash));
    const cloak = new CloakController(root);

    for (let i = 0; i < 60; i++) { cloak.refresh(); cloak.update(1 / 30); }
    expect(cloak.engaged).toBe(true);
    expect(body.transparent).toBe(true);
    expect(body.opacity).toBeLessThan(0.25);
    expect(flash.opacity).toBe(0.3);

    for (let i = 0; i < 90; i++) cloak.update(1 / 30);
    expect(cloak.engaged).toBe(false);
    expect(body.transparent).toBe(false);
    expect(body.opacity).toBe(1);
  });
});

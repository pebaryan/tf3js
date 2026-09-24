import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BallisticsSystem } from './ballistics';

describe('BallisticsSystem.calculateParabolicVelocity', () => {
  const start = new THREE.Vector3(0, 0, 0);
  const fallback = new THREE.Vector3(0, 0, -1);

  it('keeps the requested muzzle speed', () => {
    const v = BallisticsSystem.calculateParabolicVelocity(start, new THREE.Vector3(0, 0, -50), 100, -10, fallback);
    expect(v.length()).toBeCloseTo(100);
  });

  it('aims slightly upward to compensate for bullet drop', () => {
    const v = BallisticsSystem.calculateParabolicVelocity(start, new THREE.Vector3(0, 0, -50), 100, -10, fallback);
    expect(v.y).toBeGreaterThan(0);
    expect(v.z).toBeLessThan(0);
  });

  it('lands on the target when simulated', () => {
    const target = new THREE.Vector3(10, 2, -60);
    const gravity = -10;
    const v = BallisticsSystem.calculateParabolicVelocity(start, target, 120, gravity, fallback);
    const horizontalSpeed = Math.hypot(v.x, v.z);
    const t = Math.hypot(target.x, target.z) / horizontalSpeed;
    const y = v.y * t + 0.5 * gravity * t * t;
    expect(y).toBeCloseTo(target.y, 1);
  });

  it('aims directly at the target when there is no gravity', () => {
    const v = BallisticsSystem.calculateParabolicVelocity(start, new THREE.Vector3(0, 10, -10), 50, 0, fallback);
    expect(v.y).toBeCloseTo(v.z * -1);
    expect(v.length()).toBeCloseTo(50);
  });

  it('falls back to a straight shot when the target is out of range', () => {
    const v = BallisticsSystem.calculateParabolicVelocity(start, new THREE.Vector3(0, 0, -10000), 20, -10, fallback);
    expect(v.toArray()).toEqual([0, 0, -20]);
  });
});

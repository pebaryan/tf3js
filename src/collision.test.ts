import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { disposeObject3D, segmentIntersectsSphere, splashDamage } from './collision';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('segmentIntersectsSphere', () => {
  const center = v(0, 0, 0);

  it('detects a fast segment that passes straight through the sphere', () => {
    // Neither endpoint is inside the sphere; a point test would miss this.
    expect(segmentIntersectsSphere(v(-5, 0, 0), v(5, 0, 0), center, 0.5)).toBe(true);
  });

  it('misses a segment that passes beside the sphere', () => {
    expect(segmentIntersectsSphere(v(-5, 1, 0), v(5, 1, 0), center, 0.5)).toBe(false);
  });

  it('misses when the sphere lies beyond the end of the segment', () => {
    expect(segmentIntersectsSphere(v(-5, 0, 0), v(-1, 0, 0), center, 0.5)).toBe(false);
  });

  it('hits when an endpoint is inside the sphere', () => {
    expect(segmentIntersectsSphere(v(-5, 0, 0), v(-0.2, 0, 0), center, 0.5)).toBe(true);
  });

  it('handles a zero-length segment as a point test', () => {
    expect(segmentIntersectsSphere(v(0.1, 0, 0), v(0.1, 0, 0), center, 0.5)).toBe(true);
    expect(segmentIntersectsSphere(v(2, 0, 0), v(2, 0, 0), center, 0.5)).toBe(false);
  });
});

describe('splashDamage', () => {
  it('deals full damage at the centre', () => {
    expect(splashDamage(100, 0, 6)).toBe(100);
  });

  it('falls off linearly with distance', () => {
    expect(splashDamage(100, 3, 6)).toBe(50);
  });

  it('deals nothing at or beyond the radius', () => {
    expect(splashDamage(100, 6, 6)).toBe(0);
    expect(splashDamage(100, 10, 6)).toBe(0);
  });

  it('deals nothing for a zero radius', () => {
    expect(splashDamage(100, 0, 0)).toBe(0);
  });
});

describe('disposeObject3D', () => {
  it('disposes geometries, materials and textures of the whole tree', () => {
    const texture = new THREE.Texture();
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const geometry = new THREE.BoxGeometry();
    const root = new THREE.Group();
    const child = new THREE.Mesh(geometry, [material]);
    root.add(child);

    const disposed: string[] = [];
    geometry.addEventListener('dispose', () => disposed.push('geometry'));
    material.addEventListener('dispose', () => disposed.push('material'));
    texture.addEventListener('dispose', () => disposed.push('texture'));

    disposeObject3D(root);

    expect(disposed.sort()).toEqual(['geometry', 'material', 'texture']);
  });
});

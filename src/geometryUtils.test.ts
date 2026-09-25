import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bevelBox, mergeAndDispose, placedBox } from './geometryUtils';

const size = (geo: THREE.BufferGeometry) => {
  geo.computeBoundingBox();
  return geo.boundingBox!.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(4));
};

describe('bevelBox', () => {
  it('keeps the exact outer dimensions (collision boxes still match the visuals)', () => {
    expect(size(bevelBox(0.5, 3, 60, 0.05))).toEqual([0.5, 3, 60]);
    expect(size(bevelBox(0.02, 0.01, 0.3))).toEqual([0.02, 0.01, 0.3]);
  });

  it('keeps six material groups so per-face materials still work', () => {
    expect(bevelBox(2, 3, 4).groups).toHaveLength(6);
  });

  it('clamps the radius below half the smallest side', () => {
    const geo = bevelBox(0.1, 1, 1, 5);
    expect(size(geo)).toEqual([0.1, 1, 1]);
  });
});

describe('mergeAndDispose', () => {
  it('returns null for no input', () => {
    expect(mergeAndDispose([])).toBeNull();
  });

  it('merges placed boxes into one geometry covering all of them', () => {
    const merged = mergeAndDispose([placedBox(1, 1, 1, -2, 0, 0), placedBox(1, 1, 1, 2, 0, 0)])!;
    expect(size(merged)).toEqual([5, 1, 1]);
  });

  it('can mix indexed and non-indexed inputs', () => {
    const merged = mergeAndDispose([placedBox(1, 1, 1, 0, 0, 0), bevelBox(1, 1, 1)]);
    expect(merged).not.toBeNull();
    expect(merged!.index).toBeNull();
  });
});

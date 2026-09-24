import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Box with softly bevelled edges. Hard 90° edges look synthetic because they
 * never catch a highlight; even a few millimetres of bevel reads as machined.
 *
 * `radius` defaults to a fraction of the smallest side (capped by `maxRadius`).
 * One bevel segment keeps the triangle count low while giving smooth normals.
 */
export function bevelBox(
  width: number,
  height: number,
  depth: number,
  radius?: number,
  maxRadius = 0.08,
): THREE.BufferGeometry {
  const minSide = Math.min(width, height, depth);
  const r = Math.min(radius ?? minSide * 0.18, maxRadius, minSide / 2 - 1e-4);
  if (r <= 1e-4) return new THREE.BoxGeometry(width, height, depth);
  return new RoundedBoxGeometry(width, height, depth, 1, r);
}

/** A box geometry already translated (and optionally rotated) into its parent's space, for merging. */
export function placedBox(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  rotationY = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(width, height, depth);
  if (rotationY !== 0) geo.rotateY(rotationY);
  geo.translate(x, y, z);
  return geo;
}

/**
 * Merge several geometries that share one material into a single geometry
 * (one draw call). Inputs are disposed.
 */
export function mergeAndDispose(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  // mergeGeometries requires all inputs to be either indexed or non-indexed
  const allIndexed = geometries.every((g) => g.index !== null);
  const inputs = allIndexed ? geometries : geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(inputs, false);
  for (const g of new Set([...geometries, ...inputs])) g.dispose();
  return merged;
}

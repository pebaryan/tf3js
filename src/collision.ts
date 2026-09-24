import * as THREE from 'three';

/**
 * Returns true if the segment from `start` to `end` passes within `radius`
 * of `center`.
 *
 * Fast projectiles can move further than a hitbox's diameter in one frame, so
 * a point-in-sphere test on the bullet's new position alone lets them tunnel
 * straight through. Testing the whole segment travelled this frame avoids that.
 */
export function segmentIntersectsSphere(
  start: THREE.Vector3,
  end: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): boolean {
  const abX = end.x - start.x;
  const abY = end.y - start.y;
  const abZ = end.z - start.z;
  const acX = center.x - start.x;
  const acY = center.y - start.y;
  const acZ = center.z - start.z;

  const lenSq = abX * abX + abY * abY + abZ * abZ;
  let t = 0;
  if (lenSq > 1e-12) {
    t = (acX * abX + acY * abY + acZ * abZ) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }

  const dx = start.x + abX * t - center.x;
  const dy = start.y + abY * t - center.y;
  const dz = start.z + abZ * t - center.z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/** Linear damage falloff for splash damage: full damage at the centre, zero at `radius`. */
export function splashDamage(baseDamage: number, distance: number, radius: number): number {
  if (radius <= 0 || distance >= radius) return 0;
  return Math.round(baseDamage * (1 - Math.max(0, distance) / radius));
}

/** Recursively dispose every geometry, material and texture under `root`. */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    for (const m of materials) {
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      m.dispose();
    }
  });
}

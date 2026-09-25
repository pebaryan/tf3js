import * as THREE from 'three';
import { BulletVisuals } from './weapons';

export interface Bullet {
  mesh: THREE.Mesh;
  meshType?: string;
  /** Tapered glowing streak from the oldest recorded position to the bullet. */
  trail: THREE.Mesh | null;
  trailPositions: THREE.Vector3[];
  maxTrailLength: number;
  trailRadius: number;
  velocity: THREE.Vector3;
  time: number;
  maxLifetime: number;
  gravity: number;
  explosive: boolean;
  splashRadius: number;
  /** Damage dealt on hit, captured at fire time so weapon swaps mid-flight don't change it. */
  damage: number;
}

/*
 * Shared GPU resources. Bullets are created and destroyed many times a second,
 * so every round reuses cached geometries/materials and only updates its
 * transform, instead of allocating (and uploading) new buffers each frame.
 */
const geometryCache = new Map<string, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.Material>();

function cachedGeometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = create();
    geometryCache.set(key, geo);
  }
  return geo;
}

function cachedMaterial(key: string, create: () => THREE.Material): THREE.Material {
  let mat = materialCache.get(key);
  if (!mat) {
    mat = create();
    materialCache.set(key, mat);
  }
  return mat;
}

/** Unit streak spanning y ∈ [0, 1]: full width at the head (y = 1), tapering to the tail. */
function trailGeometry(): THREE.BufferGeometry {
  return cachedGeometry('trail', () => {
    const geo = new THREE.CylinderGeometry(1, 0.12, 1, 8, 1, true);
    geo.translate(0, 0.5, 0);
    return geo;
  });
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

export class BallisticsSystem {
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  createBullet(startPos: THREE.Vector3, velocity: THREE.Vector3, visuals: BulletVisuals): Bullet {
    const geo = visuals.meshType === 'capsule'
      ? cachedGeometry(`capsule:${visuals.radius}:${visuals.length}`, () => new THREE.CapsuleGeometry(visuals.radius, visuals.length, 4, 8))
      : cachedGeometry(`sphere:${visuals.radius}`, () => new THREE.SphereGeometry(visuals.radius, 8, 8));
    // HDR tracer colour so rounds glow under bloom
    const mat = cachedMaterial(`core:${visuals.color}`, () => new THREE.MeshBasicMaterial({
      color: new THREE.Color(visuals.color).multiplyScalar(4),
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(startPos);
    mesh.userData.ignoreRaycast = true;
    mesh.frustumCulled = false;
    this.orient(mesh, velocity, visuals.meshType);
    this.scene.add(mesh);

    let trail: THREE.Mesh | null = null;
    const trailRadius = Math.max(visuals.radius * 0.9, 0.012);
    if (visuals.hasTrail) {
      const trailMat = cachedMaterial(`trail:${visuals.trailColor}`, () => new THREE.MeshBasicMaterial({
        color: new THREE.Color(visuals.trailColor).multiplyScalar(2),
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending, // Glow effect
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      trail = new THREE.Mesh(trailGeometry(), trailMat);
      trail.userData.ignoreRaycast = true;
      trail.frustumCulled = false;
      trail.visible = false; // needs two samples before it has a length
      this.scene.add(trail);
    }

    return {
      mesh,
      meshType: visuals.meshType,
      trail,
      trailPositions: [mesh.position.clone()],
      maxTrailLength: visuals.trailLength || 20,
      trailRadius,
      velocity,
      time: 0,
      maxLifetime: visuals.maxLifetime,
      gravity: visuals.gravity,
      explosive: visuals.explosive,
      splashRadius: visuals.splashRadius,
      damage: 0,
    };
  }

  private orient(mesh: THREE.Mesh, velocity: THREE.Vector3, meshType?: string): void {
    if (velocity.lengthSq() < 0.01) return;
    if (meshType === 'capsule') {
      // Capsule is Y-up; align its axis with the direction of travel
      mesh.quaternion.setFromUnitVectors(_up, _dir.copy(velocity).normalize());
    } else {
      mesh.lookAt(_dir.copy(mesh.position).add(velocity));
    }
  }

  updateBullet(bullet: Bullet, delta: number): void {
    bullet.time += delta;

    // Apply gravity
    bullet.velocity.y += bullet.gravity * delta;

    // Integrate position
    bullet.mesh.position.addScaledVector(bullet.velocity, delta);
    this.orient(bullet.mesh, bullet.velocity, bullet.meshType);

    const trail = bullet.trail;
    if (!trail) return;

    // Record history; the streak runs from the oldest sample to the bullet
    const history = bullet.trailPositions;
    const recycled = history.length >= bullet.maxTrailLength ? history.pop()! : new THREE.Vector3();
    history.unshift(recycled.copy(bullet.mesh.position));

    const tail = history[history.length - 1];
    _dir.copy(bullet.mesh.position).sub(tail);
    const length = _dir.length();
    if (length < 1e-3) {
      trail.visible = false;
      return;
    }
    // Thin out as the round ages instead of fading opacity, so the material can be shared
    const age = Math.max(0, 1 - bullet.time / bullet.maxLifetime);
    const radius = bullet.trailRadius * (0.35 + 0.65 * age);
    trail.visible = true;
    trail.position.copy(tail);
    trail.quaternion.setFromUnitVectors(_up, _dir.divideScalar(length));
    trail.scale.set(radius, length, radius);
  }

  /** Remove a bullet from the scene. Geometry and materials are shared, so nothing is disposed. */
  disposeBullet(bullet: Bullet): void {
    this.scene.remove(bullet.mesh);
    if (bullet.trail) this.scene.remove(bullet.trail);
  }

  /**
   * Calculate a parabolic launch velocity to hit a target point, compensating for gravity.
   * `gravity` uses the same convention as BulletVisuals.gravity: the per-second change in
   * velocity.y, so bullet drop is negative. Falls back to straight aim if no valid solution
   * exists or the angle is too steep.
   */
  static calculateParabolicVelocity(
    startPos: THREE.Vector3,
    targetPoint: THREE.Vector3,
    bulletSpeed: number,
    gravity: number,
    fallbackAimDir: THREE.Vector3,
  ): THREE.Vector3 {
    const displacement = targetPoint.clone().sub(startPos);
    const horizontalDist = Math.sqrt(
      displacement.x * displacement.x + displacement.z * displacement.z,
    );
    const verticalDist = displacement.y;

    // Standard projectile formula uses the magnitude of downward acceleration
    const g = -gravity;
    if (g <= 1e-6) {
      // No drop: aim straight at the target
      if (displacement.lengthSq() < 1e-12) return fallbackAimDir.clone().multiplyScalar(bulletSpeed);
      return displacement.normalize().multiplyScalar(bulletSpeed);
    }

    const v2 = bulletSpeed * bulletSpeed;
    const discriminant = v2 * v2 - g * (g * horizontalDist * horizontalDist + 2 * verticalDist * v2);

    if (discriminant >= 0 && horizontalDist > 0.1) {
      // Low (flat) trajectory solution
      const tanTheta = (v2 - Math.sqrt(discriminant)) / (g * horizontalDist);
      const launchAngle = Math.atan(tanTheta);

      // Only compensate if angle is reasonable (less than 15 degrees)
      if (Math.abs(launchAngle) < Math.PI / 12) {
        const horizontalDir = new THREE.Vector3(
          displacement.x,
          0,
          displacement.z,
        ).normalize();
        return new THREE.Vector3(
          horizontalDir.x * Math.cos(launchAngle) * bulletSpeed,
          Math.sin(launchAngle) * bulletSpeed,
          horizontalDir.z * Math.cos(launchAngle) * bulletSpeed,
        );
      }
    }

    // No valid solution or angle too steep — shoot straight
    return fallbackAimDir.clone().multiplyScalar(bulletSpeed);
  }

  /**
   * Shared collision mesh filter. Excludes the owner's meshes, bullet meshes,
   * and transparent materials from the scene.
   */
  static getCollisionMeshes(
    scene: THREE.Scene,
    ownerGroup: THREE.Object3D,
    activeBullets: Bullet[],
  ): THREE.Mesh[] {
    return scene.children.filter((o) => {
      if (!(o instanceof THREE.Mesh)) return false;
      if (o.userData.ignoreRaycast) return false;
      // Exclude owner's parts
      let current: THREE.Object3D | null = o;
      while (current) {
        if (current === ownerGroup) return false;
        current = current.parent;
      }
      // Exclude bullet meshes
      if (activeBullets.some((b) => b.mesh === o)) return false;
      // Exclude transparent meshes
      const mat = o.material;
      if (Array.isArray(mat)) {
        if (mat.some((m) => (m as THREE.Material).transparent)) return false;
      } else if ((mat as THREE.Material).transparent) {
        return false;
      }
      return true;
    }) as THREE.Mesh[];
  }
}

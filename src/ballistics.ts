import * as THREE from 'three';
import { BulletVisuals } from './weapons';

export interface Bullet {
  mesh: THREE.Mesh;
  meshType?: string;
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
}

export class BallisticsSystem {
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  createBullet(startPos: THREE.Vector3, velocity: THREE.Vector3, visuals: BulletVisuals): Bullet {
    // Create bullet mesh
    let geo: THREE.BufferGeometry;
    if (visuals.meshType === 'capsule') {
      geo = new THREE.CapsuleGeometry(visuals.radius, visuals.length, 4, 8);
    } else {
      geo = new THREE.SphereGeometry(visuals.radius, 8, 8);
    }
    const mat = new THREE.MeshBasicMaterial({ color: visuals.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(startPos);

    // Orient bullet along velocity
    if (velocity.length() > 0.1) {
      const lookTarget = startPos.clone().add(velocity);
      mesh.lookAt(lookTarget);
      if (visuals.meshType === 'capsule') {
        mesh.rotateX(-Math.PI / 2);
      }
    }
    this.scene.add(mesh);

    // Create trail if enabled
    let trail: THREE.Mesh | null = null;
    const trailRadius = Math.max(visuals.radius * 0.9, 0.012);
    if (visuals.hasTrail) {
      const trailGeo = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([startPos.clone(), startPos.clone().add(velocity.clone().setLength(0.01))]),
        1,
        trailRadius,
        6,
        false,
      );
      const trailMat = new THREE.MeshBasicMaterial({
        color: visuals.trailColor,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending, // Glow effect
        depthWrite: false,
      });
      trail = new THREE.Mesh(trailGeo, trailMat);
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
    };
  }

  updateBullet(bullet: Bullet, delta: number): void {
    bullet.time += delta;

    // Apply gravity
    bullet.velocity.y += bullet.gravity * delta;

    // Integrate position
    bullet.mesh.position.add(bullet.velocity.clone().multiplyScalar(delta));

    // Orient mesh along velocity
    if (bullet.velocity.length() > 0.1) {
      const lookTarget = bullet.mesh.position.clone().add(bullet.velocity);
      bullet.mesh.lookAt(lookTarget);
      // Re-apply rotation for capsule mesh (originally Y-up)
      if (bullet.meshType === 'capsule') {
        bullet.mesh.rotateX(-Math.PI / 2);
      }
    }

    // Update trail
    if (bullet.trail) {
      bullet.trailPositions.unshift(bullet.mesh.position.clone());
      if (bullet.trailPositions.length > bullet.maxTrailLength) {
        bullet.trailPositions.pop();
      }

      if (bullet.trailPositions.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(
          bullet.trailPositions.map((pos) => pos.clone()),
          false,
          'centripetal',
        );
        const nextGeometry = new THREE.TubeGeometry(
          curve,
          Math.max(2, bullet.trailPositions.length - 1),
          bullet.trailRadius,
          6,
          false,
        );
        bullet.trail.geometry.dispose();
        bullet.trail.geometry = nextGeometry;

        // Fade trail based on age
        const alpha = 1 - bullet.time / bullet.maxLifetime;
        (bullet.trail.material as THREE.MeshBasicMaterial).opacity = Math.max(0, alpha * 0.22);
      }
    }
  }

  disposeBullet(bullet: Bullet): void {
    this.scene.remove(bullet.mesh);
    bullet.mesh.geometry.dispose();
    (bullet.mesh.material as THREE.Material).dispose();

    if (bullet.trail) {
      this.scene.remove(bullet.trail);
      bullet.trail.geometry.dispose();
      (bullet.trail.material as THREE.Material).dispose();
    }
  }

  /**
   * Calculate a parabolic launch velocity to hit a target point, compensating for gravity.
   * Falls back to straight aim if no valid solution exists or the angle is too steep.
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

    const discriminant =
      bulletSpeed * bulletSpeed * bulletSpeed * bulletSpeed -
      gravity *
        (gravity * horizontalDist * horizontalDist +
          2 * verticalDist * bulletSpeed * bulletSpeed);

    if (discriminant >= 0 && horizontalDist > 0.1) {
      const tanTheta =
        (bulletSpeed * bulletSpeed - Math.sqrt(discriminant)) /
        (gravity * horizontalDist);
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

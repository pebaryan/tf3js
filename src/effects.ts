import * as THREE from 'three';

export type EffectType = 'impact' | 'muzzle' | 'shockwave' | 'debris';

export interface BallisticEffect {
  type: EffectType;
  position: THREE.Vector3;
  scale: number;
  speed: number;
  life: number;
  maxLife: number;
  color: string;
  direction: THREE.Vector3;
}

export class BallisticEffects {
  private effects: BallisticEffect[] = [];

  createImpactEffect(position: THREE.Vector3, normal: THREE.Vector3, color: string): BallisticEffect {
    return {
      type: 'impact',
      position: position.clone(),
      scale: 0.2,
      speed: 5,
      life: 0.1,
      maxLife: 0.1,
      color,
      direction: normal.clone()
    };
  }

  createMuzzleFlash(position: THREE.Vector3, color: string): BallisticEffect {
    return {
      type: 'muzzle',
      position: position.clone(),
      scale: 0.5,
      speed: 0,
      life: 0.3,
      maxLife: 0.3,
      color,
      direction: new THREE.Vector3(0, 1, 0)
    };
  }

  createShockwave(position: THREE.Vector3, strength: number, color: string): BallisticEffect {
    const angle = Math.random() * Math.PI * 2;
    const direction = new THREE.Vector3(
      Math.cos(angle) * strength,
      Math.random() * 0.5 * strength,
      Math.sin(angle) * strength
    ).normalize();

    return {
      type: 'shockwave',
      position: position.clone(),
      scale: strength * 0.3,
      speed: 2,
      life: 0.2,
      maxLife: 0.5,
      color,
      direction
    };
  }

  createDebris(position: THREE.Vector3, count: number, color: string): BallisticEffect[] {
    const debris: BallisticEffect[] = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 2;
      const direction = new THREE.Vector3(
        Math.cos(angle) * speed,
        Math.random() * 0.5 * speed,
        Math.sin(angle) * speed
      ).normalize();

      debris.push({
        type: 'debris',
        position: position.clone(),
        scale: 0.1 + Math.random() * 0.2,
        speed,
        life: 0.1,
        maxLife: 0.3,
        color,
        direction
      });
    }
    return debris;
  }

  updateEffects(delta: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.life -= delta;
      effect.position.add(effect.direction.clone().multiplyScalar(effect.speed * delta));
      effect.scale *= 0.99;

      if (effect.life <= 0) {
        this.effects.splice(i, 1);
      }
    }
  }

  showEffects(effect: BallisticEffect | BallisticEffect[]): void {
    if (Array.isArray(effect)) {
      this.effects.push(...effect);
    } else {
      this.effects.push(effect);
    }
  }

  getEffects(): BallisticEffect[] {
    return this.effects;
  }

  removeAllEffects(): void {
    this.effects = [];
  }
}

/* ------------------------------------------------------------------ */
/*  Impact Effects Renderer (Three.js mesh-backed)                     */
/* ------------------------------------------------------------------ */

export interface ImpactConfig {
  flashInnerRadius: number;
  flashOuterRadius: number;
  flashSegments: number;
  flashColor: number;
  flashOpacity: number;
  flashLife: number;
  flashNormalOffset: number;
  sparkColor: number;
  sparkMinSize: number;
  sparkMaxSize: number;
  sparkCountMin: number;
  sparkCountMax: number;
  sparkSpeedMin: number;
  sparkSpeedMax: number;
  sparkGravity: number;
  sparkLifeMin: number;
  sparkLifeMax: number;
  sparkMaxLife: number;
}

export const PLAYER_IMPACT_CONFIG: ImpactConfig = {
  flashInnerRadius: 0.04,
  flashOuterRadius: 0.16,
  flashSegments: 16,
  flashColor: 0x66ddff,
  flashOpacity: 0.85,
  flashLife: 0.1,
  flashNormalOffset: 0.02,
  sparkColor: 0x88eeff,
  sparkMinSize: 0.012,
  sparkMaxSize: 0.030,
  sparkCountMin: 8,
  sparkCountMax: 12,
  sparkSpeedMin: 5,
  sparkSpeedMax: 15,
  sparkGravity: -16,
  sparkLifeMin: 0.15,
  sparkLifeMax: 0.35,
  sparkMaxLife: 0.35,
};

export const TITAN_IMPACT_CONFIG: ImpactConfig = {
  flashInnerRadius: 0.08,
  flashOuterRadius: 0.30,
  flashSegments: 20,
  flashColor: 0xffaa66,
  flashOpacity: 0.90,
  flashLife: 0.12,
  flashNormalOffset: 0.03,
  sparkColor: 0xff9922,
  sparkMinSize: 0.03,
  sparkMaxSize: 0.07,
  sparkCountMin: 10,
  sparkCountMax: 14,
  sparkSpeedMin: 8,
  sparkSpeedMax: 22,
  sparkGravity: -18,
  sparkLifeMin: 0.2,
  sparkLifeMax: 0.45,
  sparkMaxLife: 0.45,
};

export interface ExplosionConfig {
  coreColor: number;
  coreRadius: number;
  coreLife: number;
  shockwaveColor: number;
  shockwaveRadius: number;
  shockwaveLife: number;
  debrisColor: number;
  debrisCount: number;
  debrisMinSize: number;
  debrisMaxSize: number;
  debrisSpeedMin: number;
  debrisSpeedMax: number;
  debrisGravity: number;
  debrisLife: number;
}

export const EPG_EXPLOSION_CONFIG: ExplosionConfig = {
  coreColor: 0x44aaff,
  coreRadius: 0.4,
  coreLife: 0.15,
  shockwaveColor: 0x88ccff,
  shockwaveRadius: 0.1,
  shockwaveLife: 0.25,
  debrisColor: 0x2288ff,
  debrisCount: 15,
  debrisMinSize: 0.02,
  debrisMaxSize: 0.06,
  debrisSpeedMin: 6,
  debrisSpeedMax: 18,
  debrisGravity: -12,
  debrisLife: 0.5,
};

export const FRAG_EXPLOSION_CONFIG: ExplosionConfig = {
  coreColor: 0xff6622,
  coreRadius: 0.6,
  coreLife: 0.2,
  shockwaveColor: 0xff9944,
  shockwaveRadius: 0.15,
  shockwaveLife: 0.3,
  debrisColor: 0xff4400,
  debrisCount: 20,
  debrisMinSize: 0.03,
  debrisMaxSize: 0.08,
  debrisSpeedMin: 8,
  debrisSpeedMax: 22,
  debrisGravity: -14,
  debrisLife: 0.6,
};

export interface MuzzleFlashConfig {
  color: number;
  radius: number;
  life: number;
}

export const DEFAULT_MUZZLE_CONFIG: MuzzleFlashConfig = {
  color: 0xffee88,
  radius: 0.12,
  life: 0.06,
};

interface MeshParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  gravity: number;
  life: number;
  maxLife: number;
}

interface MeshFlash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

export class ImpactEffectsRenderer {
  private scene: THREE.Scene;
  private particles: MeshParticle[] = [];
  private flashes: MeshFlash[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  spawnImpact(point: THREE.Vector3, normal: THREE.Vector3, config: ImpactConfig): void {
    const n = normal.lengthSq() > 1e-6
      ? normal.clone().normalize()
      : new THREE.Vector3(0, 1, 0);

    // Flash ring
    const flashGeo = new THREE.RingGeometry(
      config.flashInnerRadius,
      config.flashOuterRadius,
      config.flashSegments,
    );
    const flashMat = new THREE.MeshBasicMaterial({
      color: config.flashColor,
      transparent: true,
      opacity: config.flashOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(point).add(n.clone().multiplyScalar(config.flashNormalOffset));
    flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.scene.add(flash);
    this.flashes.push({ mesh: flash, life: config.flashLife, maxLife: config.flashLife });

    // Spark particles
    const sparkCount = config.sparkCountMin +
      Math.floor(Math.random() * (config.sparkCountMax - config.sparkCountMin + 1));
    for (let i = 0; i < sparkCount; i++) {
      const size = config.sparkMinSize + Math.random() * (config.sparkMaxSize - config.sparkMinSize);
      // Elongated streak for sparks
      const sparkGeo = new THREE.CylinderGeometry(size * 0.5, size * 0.5, size * 4, 4);
      const sparkMat = new THREE.MeshBasicMaterial({
        color: config.sparkColor,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const spark = new THREE.Mesh(sparkGeo, sparkMat);
      spark.position.copy(point);

      const rand = new THREE.Vector3(
        (Math.random() - 0.5) * 1.6,
        Math.random() * 1.2,
        (Math.random() - 0.5) * 1.6,
      );
      const dir = n.clone().multiplyScalar(0.9).add(rand).normalize();
      const speed = config.sparkSpeedMin + Math.random() * (config.sparkSpeedMax - config.sparkSpeedMin);
      const velocity = dir.multiplyScalar(speed);

      // Orient spark along its velocity
      spark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

      this.scene.add(spark);
      this.particles.push({
        mesh: spark,
        velocity: velocity,
        gravity: config.sparkGravity,
        life: config.sparkLifeMin + Math.random() * (config.sparkLifeMax - config.sparkLifeMin),
        maxLife: config.sparkMaxLife,
      });
    }
  }

  update(delta: number): void {
    // Update spark particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= delta;
      p.velocity.y += p.gravity * delta;
      p.mesh.position.add(p.velocity.clone().multiplyScalar(delta));
      
      // Orient spark along its velocity
      if (p.velocity.lengthSq() > 0.01) {
        p.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.velocity.clone().normalize());
      }

      p.mesh.scale.multiplyScalar(0.98);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, p.life / p.maxLife);

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }

    // Update impact flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= delta;
      f.mesh.scale.multiplyScalar(1 + 8 * delta);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, f.life / f.maxLife);

      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        (f.mesh.material as THREE.Material).dispose();
        this.flashes.splice(i, 1);
      }
    }
  }

  spawnMuzzleFlash(position: THREE.Vector3, direction: THREE.Vector3, config: MuzzleFlashConfig): void {
    const geo = new THREE.SphereGeometry(config.radius, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(direction.clone().multiplyScalar(0.3));
    this.scene.add(mesh);
    this.flashes.push({ mesh, life: config.life, maxLife: config.life });
  }

  spawnExplosion(position: THREE.Vector3, config: ExplosionConfig): void {
    // Core flash sphere
    const coreGeo = new THREE.SphereGeometry(config.coreRadius, 12, 12);
    const coreMat = new THREE.MeshBasicMaterial({
      color: config.coreColor,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.copy(position);
    this.scene.add(core);
    this.flashes.push({ mesh: core, life: config.coreLife, maxLife: config.coreLife });

    // Shockwave ring
    const ringGeo = new THREE.RingGeometry(config.shockwaveRadius, config.shockwaveRadius * 1.5, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: config.shockwaveColor,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(position);
    // Random orientation for visual variety
    ring.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    this.scene.add(ring);
    this.flashes.push({ mesh: ring, life: config.shockwaveLife, maxLife: config.shockwaveLife });

    // Debris particles
    for (let i = 0; i < config.debrisCount; i++) {
      const size = config.debrisMinSize + Math.random() * (config.debrisMaxSize - config.debrisMinSize);
      const geo = new THREE.SphereGeometry(size, 4, 4);
      const mat = new THREE.MeshBasicMaterial({
        color: config.debrisColor,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(position);

      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.3) * Math.PI;
      const speed = config.debrisSpeedMin + Math.random() * (config.debrisSpeedMax - config.debrisSpeedMin);
      const velocity = new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation) * speed,
        Math.sin(elevation) * speed,
        Math.sin(angle) * Math.cos(elevation) * speed,
      );

      this.scene.add(mesh);
      this.particles.push({
        mesh,
        velocity,
        gravity: config.debrisGravity,
        life: config.debrisLife,
        maxLife: config.debrisLife,
      });
    }
  }

  disposeAll(): void {
    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.particles = [];

    for (const f of this.flashes) {
      this.scene.remove(f.mesh);
      f.mesh.geometry.dispose();
      (f.mesh.material as THREE.Material).dispose();
    }
    this.flashes = [];
  }
}

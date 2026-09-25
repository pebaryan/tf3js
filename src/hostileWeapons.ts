import * as THREE from 'three';
import { BallisticsSystem, Bullet } from './ballistics';
import { segmentIntersectsSphere, splashDamage } from './collision';
import { ExplosionConfig, ImpactConfig, PLAYER_IMPACT_CONFIG } from './effects';
import { flashLight } from './graphics';
import { soundManager } from './sound';
import type { BulletVisuals } from './weapons';
import type { HostileContext, HostileHit } from './hostile';

/*
 * Projectile weapon shared by the AI units that shoot physical rounds
 * (grunts, stalkers, turrets). It owns the rounds in flight, clips each
 * frame's travel against level geometry, and returns HostileHits for the
 * rounds that reach the player's hitbox. Explosive rounds deal splash
 * damage to the player and to other hostiles caught in the blast.
 */

export interface HostileGunOptions {
  visuals: BulletVisuals;
  /** Damage of a direct hit; may differ against titans. */
  damage: (targetIsTitan: boolean) => number;
  impact?: ImpactConfig;
  /** Explosive rounds: blast radius and effect. Direct hits still deal full damage. */
  splashRadius?: number;
  explosion?: ExplosionConfig;
}

export class HostileGun {
  private readonly ballistics: BallisticsSystem;
  private readonly options: HostileGunOptions;
  private bullets: Bullet[] = [];
  private readonly raycaster = new THREE.Raycaster();

  constructor(scene: THREE.Scene, options: HostileGunOptions) {
    this.ballistics = new BallisticsSystem(scene);
    this.options = options;
  }

  get inFlight(): number {
    return this.bullets.length;
  }

  fire(muzzle: THREE.Vector3, velocity: THREE.Vector3): void {
    this.bullets.push(this.ballistics.createBullet(muzzle.clone(), velocity.clone(), this.options.visuals));
  }

  /**
   * Advance every round. `source` is reported as the damage origin (for the
   * damage-direction indicator); `owner` is excluded from splash damage.
   */
  update(ctx: HostileContext, source: THREE.Vector3, owner: object): HostileHit[] {
    const hits: HostileHit[] = [];
    const { damage, impact = PLAYER_IMPACT_CONFIG, splashRadius = 0, explosion } = this.options;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prev = b.mesh.position.clone();
      this.ballistics.updateBullet(b, ctx.delta);

      // Clip this frame's travel against level geometry so rounds can't pass through walls
      let end = b.mesh.position;
      let hitWall: THREE.Intersection | null = null;
      const step = b.mesh.position.clone().sub(prev);
      const len = step.length();
      if (len > 1e-6) {
        this.raycaster.set(prev, step.divideScalar(len));
        this.raycaster.far = len;
        hitWall = this.raycaster.intersectObjects(ctx.worldMeshes, false)[0] ?? null;
        if (hitWall) end = hitWall.point;
      }

      const hitTarget = segmentIntersectsSphere(prev, end, ctx.hitbox.center, ctx.hitbox.radius);
      const expired = b.time > b.maxLifetime || b.mesh.position.y < -5;
      if (hitTarget) hits.push({ damage: damage(ctx.targetIsTitan), source: source.clone() });

      if (splashRadius > 0 && (hitTarget || hitWall || expired)) {
        // Explosive round: blast at the impact point (or wherever it ran out of fuel)
        const at = hitTarget ? this.closestPointTo(prev, end, ctx.hitbox.center) : end.clone();
        if (explosion) ctx.effects.spawnExplosion(at, explosion);
        flashLight(at, 0xff7733, 45, splashRadius * 3, 0.3);
        soundManager.playSound('explosion', 0.4);
        if (!hitTarget) {
          const d = splashDamage(damage(ctx.targetIsTitan), Math.max(0, at.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius), splashRadius);
          if (d > 0) hits.push({ damage: d, source: source.clone() });
        }
        for (const other of ctx.hostiles) {
          if (other === owner || other.isDead()) continue;
          const d = splashDamage(damage(false) * 0.5, at.distanceTo(other.group.position), splashRadius);
          if (d > 0) other.takeDamage(d, at);
        }
      } else if (hitWall && !hitTarget) {
        const normal = hitWall.face ? hitWall.face.normal.clone().transformDirection(hitWall.object.matrixWorld) : step.clone().negate();
        ctx.effects.spawnImpact(hitWall.point, normal, impact);
      }

      if (hitTarget || hitWall || expired) {
        this.ballistics.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }
    return hits;
  }

  private closestPointTo(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): THREE.Vector3 {
    return new THREE.Line3(a, b).closestPointToPoint(p, true, new THREE.Vector3());
  }

  dispose(): void {
    for (const b of this.bullets) this.ballistics.disposeBullet(b);
    this.bullets = [];
  }
}

/** Randomly deflect unit direction `dir` (in place) by up to `spreadRad` radians. */
export function applySpread(dir: THREE.Vector3, spreadRad: number): THREE.Vector3 {
  if (spreadRad <= 0) return dir;
  const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, dir).normalize();
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * spreadRad;
  return dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
}

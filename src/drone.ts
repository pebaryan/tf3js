import * as THREE from 'three';
import { soundManager } from './sound';
import { segmentIntersectsSphere, splashDamage } from './collision';
import { bevelBox, mergeAndDispose } from './geometryUtils';
import { FRAG_EXPLOSION_CONFIG, PLAYER_IMPACT_CONFIG } from './effects';
import { flashLight } from './graphics';
import { Hostile, HostileContext, HostileHit, hasLineOfSight } from './hostile';

/*
 * Drones: slow quad-rotor units that hover above the fight.
 *
 *  - Laser drone: keeps its distance, charges a laser with a visible
 *    targeting beam that trails the pilot, then fires a single heavy shot.
 *    Slow cadence: keep moving while it charges and the shot misses.
 *  - Cloak drone: unarmed support unit. It shadows the nearest ground unit
 *    and cloaks every ally around it; the tethers show who it's hiding.
 *    Kill it first and the cloaked squad reappears.
 *
 * A destroyed drone spirals down and blows up where it lands.
 */

export type DroneVariant = 'laser' | 'cloak';

export enum DroneState {
  PATROL,
  ENGAGE,
  CHARGE,
  FIRE,
  COOLDOWN,
  SUPPORT,
  FALLING,
  EXPLODED,
}

const DETECTION_RANGE = 42;
const ATTACK_RANGE = 36;
const STANDOFF = 13;
const HOVER_ABOVE_TARGET = 4;
const MIN_ALTITUDE = 3;
const MAX_ALTITUDE = 14;
const SPEED = 3.2;
const ACCEL = 2.5;
const CHARGE_TIME = 1.2;
/** The aim stops tracking this long before the shot, so a sidestep dodges it. */
const AIM_LOCK = 0.3;
const FIRE_TIME = 0.18;
const COOLDOWN_TIME = 2.6;
const LASER_RANGE = 60;
const LASER_DAMAGE = 22;
const LASER_DAMAGE_TITAN = 12;
const CLOAK_RADIUS = 10;
const HEARING_RANGE = 20;
const MAX_TETHERS = 4;
const BODY_RADIUS = 0.55;

/** Unit beam along +Y (y ∈ [0, 1]), scaled to length at runtime. */
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0);

export class Drone implements Hostile {
  readonly kind = 'drone' as const;
  readonly variant: DroneVariant;
  readonly group: THREE.Group;
  health: number;
  state: DroneState;
  get scoreValue(): number { return this.variant === 'cloak' ? 150 : 120; }

  private readonly scene: THREE.Scene;
  private readonly hull: THREE.Group;
  private readonly rotors: THREE.Object3D[] = [];
  private readonly emitter = new THREE.Vector3();
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly flashMat: THREE.MeshBasicMaterial;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly beam: THREE.Mesh;
  private readonly tethers: THREE.Mesh[] = [];
  private readonly home: THREE.Vector3;
  private readonly velocity = new THREE.Vector3();
  private readonly aimPoint = new THREE.Vector3();
  private readonly aimDir = new THREE.Vector3();

  private stateTimer = 0;
  private time = Math.random() * 10;
  private orbitSign = Math.random() < 0.5 ? 1 : -1;
  private orbitAngle = Math.random() * Math.PI * 2;
  private cooldown = 1.5 + Math.random();
  private flashTimer = 0;
  private spin = new THREE.Vector3();
  private cloaking = 0;
  /** Seconds without line of sight while engaging: moves in closer and higher to find an angle. */
  private blindTime = 0;

  constructor(scene: THREE.Scene, position: THREE.Vector3, variant: DroneVariant = 'laser') {
    this.scene = scene;
    this.variant = variant;
    this.health = variant === 'cloak' ? 70 : 60;
    this.home = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.position.y = Math.max(position.y, 5);
    this.hull = new THREE.Group();
    this.group.add(this.hull);

    const glow = variant === 'cloak' ? 0x33aaff : 0xff2a14;
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(glow).multiplyScalar(4) });
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    this.beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(glow).multiplyScalar(6),
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.buildModel();

    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.beam.userData.ignoreRaycast = true;
    scene.add(this.beam);
    if (variant === 'cloak') {
      for (let i = 0; i < MAX_TETHERS; i++) {
        const t = new THREE.Mesh(beamGeo, this.beamMat);
        t.visible = false;
        t.frustumCulled = false;
        t.userData.ignoreRaycast = true;
        scene.add(t);
        this.tethers.push(t);
      }
    }

    this.state = variant === 'cloak' ? DroneState.SUPPORT : DroneState.PATROL;
    scene.add(this.group);
  }

  /* ------------------------------ Model ------------------------------- */

  private buildModel(): void {
    const shellMat = new THREE.MeshStandardMaterial({
      color: this.variant === 'cloak' ? 0x4a5866 : 0x5a5f66, metalness: 0.7, roughness: 0.32,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x16191d, metalness: 0.6, roughness: 0.5 });
    const accentMat = new THREE.MeshStandardMaterial({
      color: this.variant === 'cloak' ? 0x1e5f8c : 0xb8401c, metalness: 0.35, roughness: 0.45,
    });
    const rotorMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, metalness: 0.5, roughness: 0.6 });

    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      geo.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ));
      const list = parts.get(mat) ?? [];
      list.push(geo);
      parts.set(mat, list);
    };

    // Hull: armoured saucer over a dark sensor belly
    const top = new THREE.SphereGeometry(0.36, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    top.scale(1.15, 0.55, 1.3);
    add(shellMat, top);
    const belly = new THREE.SphereGeometry(0.33, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    belly.scale(1.1, 0.6, 1.25);
    add(darkMat, belly);
    add(accentMat, bevelBox(0.14, 0.06, 0.62, 0.02), 0, 0.17, 0);                 // dorsal spine
    add(darkMat, bevelBox(0.3, 0.1, 0.12, 0.03), 0, 0.02, 0.44);                   // sensor housing
    for (const sx of [-1, 1]) add(shellMat, bevelBox(0.1, 0.05, 0.3, 0.02), sx * 0.3, 0.1, -0.05, 0, 0, sx * 0.4);

    // Four arms out to ducted rotors
    const rotorPositions: THREE.Vector3[] = [];
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const p = new THREE.Vector3(sx * 0.62, 0.05, sz * 0.55);
      rotorPositions.push(p);
      const arm = bevelBox(0.62, 0.06, 0.1, 0.02);
      arm.rotateY(Math.atan2(-sz, sx));
      add(shellMat, arm, sx * 0.32, 0.03, sz * 0.28);
      const duct = new THREE.TorusGeometry(0.24, 0.035, 8, 24);
      duct.rotateX(Math.PI / 2);
      add(accentMat, duct, p.x, p.y, p.z);
      add(darkMat, new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), p.x, p.y - 0.02, p.z); // motor
    }

    if (this.variant === 'laser') {
      // Under-slung laser emitter
      add(darkMat, new THREE.CylinderGeometry(0.07, 0.09, 0.34, 12), 0, -0.2, 0.2, Math.PI / 2);
      add(shellMat, bevelBox(0.18, 0.12, 0.2, 0.03), 0, -0.16, 0.05);
      add(accentMat, new THREE.TorusGeometry(0.075, 0.015, 6, 16), 0, -0.2, 0.37);
      this.emitter.set(0, -0.2, 0.4);
    } else {
      // Cloak projector: antenna mast and an emitter ring under the belly
      add(darkMat, new THREE.CylinderGeometry(0.012, 0.018, 0.4, 6), 0.1, 0.35, -0.2, -0.3);
      add(darkMat, new THREE.CylinderGeometry(0.1, 0.14, 0.12, 14), 0, -0.24, 0);
      this.emitter.set(0, -0.3, 0);
    }

    for (const [mat, geos] of parts) {
      const mesh = new THREE.Mesh(mergeAndDispose(geos)!, mat);
      mesh.castShadow = true;
      this.hull.add(mesh);
    }

    // Spinning rotor blades (separate so they can rotate)
    for (const p of rotorPositions) {
      const rotor = new THREE.Group();
      rotor.position.copy(p);
      const blades = mergeAndDispose([
        bevelBox(0.42, 0.012, 0.05, 0.005),
        bevelBox(0.42, 0.012, 0.05, 0.005).rotateY(Math.PI / 2),
      ])!;
      rotor.add(new THREE.Mesh(blades, rotorMat));
      this.hull.add(rotor);
      this.rotors.push(rotor);
    }

    // Glowing parts: sensor eye; cloak drone gets a halo ring under the belly
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), this.eyeMat);
    eye.position.set(0, 0.02, 0.51);
    this.hull.add(eye);
    if (this.variant === 'cloak') {
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 6, 24), this.eyeMat);
      halo.rotation.x = Math.PI / 2;
      halo.position.y = -0.3;
      this.hull.add(halo);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), this.eyeMat);
      tip.position.set(0.16, 0.54, -0.26);
      this.hull.add(tip);
    }
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 8), this.flashMat);
    flash.scale.set(1.3, 0.6, 1.3);
    this.hull.add(flash);
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === DroneState.EXPLODED; }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.isDead()) return false;
    const c = this.group.position;
    const dx = (p.x - c.x) / 1.4;
    const dy = (p.y - c.y) / 0.7;
    const dz = (p.z - c.z) / 1.4;
    // Flattened ellipsoid covering hull and rotors
    return dx * dx + dy * dy + dz * dz < BODY_RADIUS * BODY_RADIUS * 1.2;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    if (this.isDead()) return;
    this.health = Math.max(0, this.health - amount);
    this.flashTimer = 0.08;
    if (this.state === DroneState.PATROL) this.setState(DroneState.ENGAGE);
    if (this.health <= 0) {
      this.hideBeams();
      this.setState(DroneState.FALLING);
      // Knocked away from the hit and spun out of control
      const push = hitPoint ? this.group.position.clone().sub(hitPoint).setY(0).normalize().multiplyScalar(3) : new THREE.Vector3();
      this.velocity.add(push).setY(Math.max(this.velocity.y, 1.5));
      this.spin.set((Math.random() - 0.5) * 6, 8 + Math.random() * 6, (Math.random() - 0.5) * 6);
      soundManager.playSound('explosion', 0.25);
    }
  }

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    this.stateTimer += dt;
    this.time += dt;
    const pos = this.group.position;
    const dist = pos.distanceTo(ctx.target);
    const hits: HostileHit[] = [];

    if (this.state === DroneState.FALLING) return this.updateFalling(ctx);
    if (this.state === DroneState.EXPLODED) return hits;

    const canSee = dist < DETECTION_RANGE * 1.2 && hasLineOfSight(pos, ctx.target, ctx.worldMeshes);
    const desired = new THREE.Vector3();

    if (this.variant === 'cloak') {
      this.updateSupport(ctx, desired, dist);
    } else {
      switch (this.state) {
        case DroneState.PATROL:
          this.orbitAngle += dt * 0.35 * this.orbitSign;
          desired.set(this.home.x + Math.cos(this.orbitAngle) * 6, this.home.y + 5, this.home.z + Math.sin(this.orbitAngle) * 6);
          // Spots the pilot by sight, or hears them nearby even through walls
          if ((canSee && dist < DETECTION_RANGE) || dist < HEARING_RANGE) this.setState(DroneState.ENGAGE);
          break;

        case DroneState.ENGAGE:
          this.blindTime = canSee ? 0 : this.blindTime + dt;
          this.standoffPoint(ctx, desired, dt);
          this.cooldown -= dt;
          if (this.cooldown <= 0 && canSee && dist < ATTACK_RANGE) {
            this.aimPoint.copy(ctx.target);
            this.setState(DroneState.CHARGE);
            soundManager.playSound('laser_charge', 0.3);
          }
          break;

        case DroneState.CHARGE: {
          // Hold position (drifting a little) while the targeting beam tracks the pilot
          desired.copy(pos);
          if (this.stateTimer < CHARGE_TIME - AIM_LOCK) {
            this.aimPoint.lerp(ctx.target, 1 - Math.exp(-dt * 3.5));
          }
          this.updateAim();
          this.showBeam(0.012 + (this.stateTimer / CHARGE_TIME) * 0.02, 0.35 + Math.sin(this.time * 40) * 0.15, ctx);
          if (this.stateTimer >= CHARGE_TIME) {
            hits.push(...this.fireLaser(ctx));
            this.setState(DroneState.FIRE);
          }
          break;
        }

        case DroneState.FIRE:
          desired.copy(pos);
          this.showBeam(0.07 * (1 - this.stateTimer / FIRE_TIME) + 0.02, 1, ctx);
          if (this.stateTimer >= FIRE_TIME) {
            this.hideBeams();
            this.cooldown = COOLDOWN_TIME;
            this.setState(DroneState.COOLDOWN);
          }
          break;

        case DroneState.COOLDOWN:
          this.standoffPoint(ctx, desired, dt);
          if (this.stateTimer >= 0.8) this.setState(DroneState.ENGAGE);
          break;
      }
    }

    this.fly(ctx, desired);
    this.animate(ctx);
    return hits;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.remove(this.beam);
    for (const t of this.tethers) this.scene.remove(t);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.beamMat.dispose();
  }

  /* ------------------------------ Brain ------------------------------- */

  private setState(state: DroneState): void {
    this.state = state;
    this.stateTimer = 0;
  }

  /** Circle the target at stand-off range, above head height. */
  private standoffPoint(ctx: HostileContext, out: THREE.Vector3, dt: number): void {
    const pos = this.group.position;
    const blind = this.blindTime > 2;
    const bearing = Math.atan2(pos.z - ctx.target.z, pos.x - ctx.target.x) + this.orbitSign * dt * (blind ? 0.6 : 0.25);
    const range = blind ? STANDOFF * 0.5 : STANDOFF;
    out.set(
      ctx.target.x + Math.cos(bearing) * range,
      ctx.target.y + HOVER_ABOVE_TARGET + (blind ? 4 : 0) + Math.sin(this.time * 0.7) * 0.8,
      ctx.target.z + Math.sin(bearing) * range,
    );
    if (Math.random() < dt * 0.1) this.orbitSign *= -1;
  }

  /** Cloak drone: shadow a ground unit, cloak everyone near it, keep away from the pilot. */
  private updateSupport(ctx: HostileContext, desired: THREE.Vector3, dist: number): void {
    const pos = this.group.position;
    let ward: Hostile | null = null;
    let best = Infinity;
    for (const h of ctx.hostiles) {
      if (h === this || h.isDead() || !h.refreshCloak) continue;
      const d = h.group.position.distanceTo(pos);
      if (d < best) { best = d; ward = h; }
    }

    if (ward) {
      // Hover above and slightly behind the ward, relative to the pilot
      const away = ward.group.position.clone().sub(ctx.target).setY(0);
      if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
      away.normalize();
      desired.copy(ward.group.position).addScaledVector(away, 2.5).setY(ward.group.position.y + 4.5 + Math.sin(this.time) * 0.4);
    } else {
      this.orbitAngle += ctx.delta * 0.3;
      desired.set(this.home.x + Math.cos(this.orbitAngle) * 5, 6, this.home.z + Math.sin(this.orbitAngle) * 5);
    }
    // Too close to the pilot: back off
    if (dist < 8) desired.add(pos.clone().sub(ctx.target).setY(0).normalize().multiplyScalar(6));

    // Cloak every ally in range and tether to them
    let n = 0;
    const origin = this.hull.localToWorld(this.emitter.clone());
    for (const h of ctx.hostiles) {
      if (h === this || h.isDead() || !h.refreshCloak) continue;
      if (h.group.position.distanceTo(pos) > CLOAK_RADIUS + 4) continue;
      h.refreshCloak();
      if (n < this.tethers.length) {
        const to = h.group.position.clone().setY(h.group.position.y + 1);
        this.placeBeam(this.tethers[n], origin, to, 0.01 + Math.sin(this.time * 6 + n) * 0.004);
        this.tethers[n].visible = true;
      }
      n++;
    }
    for (let i = n; i < this.tethers.length; i++) this.tethers[i].visible = false;
    if (n > 0 && this.cloaking === 0) soundManager.playSound('cloak', 0.3);
    this.cloaking = n;
    this.beamMat.opacity = 0.35;
  }

  /* ------------------------------ Laser ------------------------------- */

  private updateAim(): void {
    const origin = this.hull.localToWorld(this.emitter.clone());
    this.aimDir.copy(this.aimPoint).sub(origin).normalize();
  }

  /** Distance along the aim until level geometry blocks the beam. */
  private beamLength(ctx: HostileContext, origin: THREE.Vector3): number {
    const ray = new THREE.Raycaster(origin, this.aimDir, 0, LASER_RANGE);
    const hit = ray.intersectObjects(ctx.worldMeshes, false)[0];
    return hit ? hit.distance : LASER_RANGE;
  }

  private showBeam(radius: number, opacity: number, ctx: HostileContext): void {
    const origin = this.hull.localToWorld(this.emitter.clone());
    const end = origin.clone().addScaledVector(this.aimDir, this.beamLength(ctx, origin));
    this.placeBeam(this.beam, origin, end, radius);
    this.beamMat.opacity = opacity;
    this.beam.visible = true;
  }

  private placeBeam(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, radius: number): void {
    const dir = to.clone().sub(from);
    const len = dir.length();
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(Math.max(len, 1e-6)));
    mesh.scale.set(radius, len, radius);
  }

  private hideBeams(): void {
    this.beam.visible = false;
    for (const t of this.tethers) t.visible = false;
  }

  private fireLaser(ctx: HostileContext): HostileHit[] {
    this.updateAim();
    const origin = this.hull.localToWorld(this.emitter.clone());
    const length = this.beamLength(ctx, origin);
    const end = origin.clone().addScaledVector(this.aimDir, length);
    soundManager.playSound('laser_fire', 0.45);
    flashLight(origin, 0xff3322, 30, 8, 0.15);
    if (length < LASER_RANGE) {
      ctx.effects.spawnImpact(end, this.aimDir.clone().negate(), { ...PLAYER_IMPACT_CONFIG, flashColor: 0xff4422 });
    }
    if (segmentIntersectsSphere(origin, end, ctx.hitbox.center, ctx.hitbox.radius)) {
      return [{ damage: ctx.targetIsTitan ? LASER_DAMAGE_TITAN : LASER_DAMAGE, source: origin }];
    }
    return [];
  }

  /* ----------------------------- Flight ------------------------------- */

  private fly(ctx: HostileContext, desired: THREE.Vector3): void {
    const dt = ctx.delta;
    const pos = this.group.position;
    desired.y = THREE.MathUtils.clamp(desired.y, MIN_ALTITUDE, MAX_ALTITUDE);
    const want = desired.clone().sub(pos);
    const d = want.length();
    // Ease in to the goal: full speed far away, slowing as it arrives
    want.multiplyScalar(d > 1e-4 ? Math.min(SPEED, d * 1.2) / d : 0);
    this.velocity.lerp(want, Math.min(1, ACCEL * dt));

    const step = this.velocity.clone().multiplyScalar(dt);
    const len = step.length();
    if (len > 1e-5) {
      const ray = new THREE.Raycaster(pos, step.clone().divideScalar(len), 0, len + 0.9);
      if (ray.intersectObjects(ctx.worldMeshes, false).length > 0) {
        // Blocked: climb over it and bleed off horizontal speed
        this.velocity.x *= 0.5;
        this.velocity.z *= 0.5;
        this.velocity.y = Math.max(this.velocity.y, SPEED * 0.7);
        step.set(0, this.velocity.y * dt, 0);
        if (pos.y + step.y > MAX_ALTITUDE) step.y = 0;
      }
      pos.add(step);
    }
  }

  private updateFalling(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    const pos = this.group.position;
    this.velocity.y -= 14 * dt;
    const step = this.velocity.clone().multiplyScalar(dt);
    const len = step.length();
    let crashed = pos.y + step.y <= 0.3;
    if (len > 1e-5 && !crashed) {
      const ray = new THREE.Raycaster(pos, step.clone().divideScalar(len), 0, len + 0.4);
      crashed = ray.intersectObjects(ctx.worldMeshes, false).length > 0;
    }
    pos.add(step);
    this.hull.rotation.x += this.spin.x * dt;
    this.hull.rotation.y += this.spin.y * dt;
    this.hull.rotation.z += this.spin.z * dt;
    if (Math.random() < dt * 20) ctx.effects.spawnImpact(pos.clone(), new THREE.Vector3(0, 1, 0), PLAYER_IMPACT_CONFIG);
    for (const r of this.rotors) r.rotation.y += dt * 8;
    if (crashed || this.stateTimer > 4) return this.explode(ctx);
    return [];
  }

  private explode(ctx: HostileContext): HostileHit[] {
    const center = this.group.position.clone();
    ctx.effects.spawnExplosion(center, FRAG_EXPLOSION_CONFIG);
    flashLight(center, 0xff6622, 40, 10, 0.3);
    soundManager.playSound('explosion', 0.45);
    this.group.visible = false;
    this.setState(DroneState.EXPLODED);
    const hits: HostileHit[] = [];
    const d = splashDamage(20, Math.max(0, center.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius), 3);
    if (d > 0) hits.push({ damage: d, source: center });
    return hits;
  }

  /* ---------------------------- Animation ----------------------------- */

  private animate(ctx: HostileContext): void {
    const dt = ctx.delta;
    for (const r of this.rotors) r.rotation.y += dt * 40;
    // Bank into the direction of travel and face the target when fighting
    const pos = this.group.position;
    const look = this.variant === 'laser' && this.state !== DroneState.PATROL ? ctx.target : pos.clone().add(this.velocity);
    const yaw = Math.atan2(look.x - pos.x, look.z - pos.z);
    if (Math.hypot(look.x - pos.x, look.z - pos.z) > 0.1) {
      let diff = yaw - this.group.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.group.rotation.y += diff * Math.min(1, dt * 3);
    }
    const local = this.velocity.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.group.rotation.y);
    this.hull.rotation.x = THREE.MathUtils.lerp(this.hull.rotation.x, local.z * 0.08, Math.min(1, dt * 4));
    this.hull.rotation.z = THREE.MathUtils.lerp(this.hull.rotation.z, -local.x * 0.08, Math.min(1, dt * 4));
    this.hull.position.y = Math.sin(this.time * 2.2) * 0.06;

    // Eye brightens while charging
    const base = this.variant === 'cloak' ? 0x33aaff : 0xff2a14;
    const charge = this.state === DroneState.CHARGE ? 4 + (this.stateTimer / CHARGE_TIME) * 8 : 4;
    this.eyeMat.color.set(base).multiplyScalar(charge);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flashMat.opacity = this.flashTimer * 5;
  }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { bevelBox } from './geometryUtils';
import { disposeObject3D } from './collision';
import { buildTitanModel, poseTitanArms, poseTitanLegs, TitanRig } from './titanModel';
import { BallisticsSystem, Bullet } from './ballistics';
import { ImpactEffectsRenderer, TITAN_IMPACT_CONFIG } from './effects';
import { TITAN_WEAPON } from './weapons';
import { soundManager } from './sound';

type TitanBulletTarget = {
  checkBulletHit: (bulletPos: THREE.Vector3) => boolean;
  takeDamage: (amount: number, hitPoint: THREE.Vector3) => void;
};

type TitanBulletEnemy = {
  checkBulletHit: (bulletPos: THREE.Vector3) => boolean;
  takeDamage: (amount: number, hitPoint?: THREE.Vector3) => void;
};

export enum TitanState {
  INACTIVE = 'inactive',
  DROPPING = 'dropping',
  LANDING = 'landing',
  READY = 'ready',
  ENTERING = 'entering',
  PILOTING = 'piloting',
  EXITING = 'exiting',
  DESTROYED = 'destroyed'
}

export class Titan {
  scene: THREE.Scene;
  world: CANNON.World;
  state: TitanState = TitanState.INACTIVE;
  
  // Meshes
  group: THREE.Group;
  private rig: TitanRig;
  body: THREE.Group;
  torso!: THREE.Mesh;
  head!: THREE.Mesh;
  leftArm!: THREE.Group;
  rightArm!: THREE.Group;
  leftLeg!: THREE.Group;
  rightLeg!: THREE.Group;
  leftLegUpper!: THREE.Mesh;
  leftLegLower!: THREE.Mesh;
  rightLegUpper!: THREE.Mesh;
  rightLegLower!: THREE.Mesh;
  leftShoulder!: THREE.Mesh;
  rightShoulder!: THREE.Mesh;
  leftForearm!: THREE.Mesh;
  rightForearm!: THREE.Mesh;
  leftFist!: THREE.Mesh;
  rightFist!: THREE.Mesh;
  
  // Physics
  bodyBody?: CANNON.Body;
  
  // Animation properties
  dropHeight: number = 200;
  dropSpeed: number = 80;
  landingAnimation: number = 0;
  smokeParticles: THREE.Mesh[] = [];
  private impactRenderer!: ImpactEffectsRenderer;
  shakeIntensity: number = 0;
  
  // Titan stats
  health: number = 100;
  shield: number = 100;
  maxHealth: number = 100;
  maxShield: number = 100;
  coreAbility: number = 0;
  
  // Piloting controls
  private pilotEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private titanVelocity = new THREE.Vector3();
  private readonly TITAN_SPEED = 8;
  private dashMeter = 100;
  private readonly MAX_DASH_METER = 100;
  private readonly DASH_COST = 40;
  private readonly DASH_SPEED = 30;
  private readonly DASH_DURATION = 0.22;
  private readonly DASH_RECHARGE_DELAY = 1.0;
  private readonly DASH_RECHARGE_RATE = 30; // meter/sec
  private dashTimer = 0;
  private dashRechargeTimer = 0;
  private dashDirection = new THREE.Vector3(0, 0, -1);
  private dashInputPrev = false;
  private pilotCrouch = false;
  private titanBarrelIndex = 0;
  private cockpitWeapon: THREE.Group | null = null;
  private cockpitWeaponOffset = new THREE.Vector3();
  private cockpitWeaponRecoil = 0;
  private isFiring = false;
  private lastFireTime = 0;
  private readonly FIRE_COOLDOWN = 0.15; // seconds
  /** Hand-held cannon muzzles in weapon space (set from the model rig). */
  private TITAN_MUZZLE_OFFSETS: THREE.Vector3[] = [];
  private readonly COCKPIT_MUZZLE_OFFSETS = [
    new THREE.Vector3(0.11, -0.01, -1.02),
    new THREE.Vector3(-0.11, -0.01, -1.02),
  ];
  private readonly COCKPIT_WEAPON_HIP_OFFSET = new THREE.Vector3(0.54, -0.3, -0.82);
  private readonly COCKPIT_WEAPON_SIGHT_OFFSET = new THREE.Vector3(0.04, -0.08, -0.58);
  private readonly COCKPIT_WEAPON_HIP_ROT = new THREE.Euler(-0.05, -0.08, 0.015);
  private readonly COCKPIT_WEAPON_ADS_ROT = new THREE.Euler(-0.015, -0.02, 0);
  private walkBobTime = 0;
  private walkBobAmount = 0;
  private walkRollAmount = 0;
  private bullets: Bullet[] = [];
  private ballisticsSystem!: BallisticsSystem;
  
  constructor(scene: THREE.Scene, world: CANNON.World, position?: THREE.Vector3) {
    this.scene = scene;
    this.world = world;
    
    this.group = new THREE.Group();
    this.group.position.copy(position || new THREE.Vector3(0, 0, 0));
    
    // Build procedural Titan mesh
    this.body = new THREE.Group();
    this.group.add(this.body);
    
    this.rig = buildTitanModel(this.body, 8);
    this.torso = this.rig.torso;
    this.head = this.rig.visor;
    this.leftArm = this.rig.leftArm;
    this.rightArm = this.rig.rightArm;
    this.leftShoulder = this.rig.leftShoulder;
    this.rightShoulder = this.rig.rightShoulder;
    this.leftForearm = this.rig.leftForearm;
    this.rightForearm = this.rig.rightForearm;
    this.leftFist = this.rig.leftFist;
    this.rightFist = this.rig.rightFist;
    this.leftLeg = this.rig.leftLeg.hip;
    this.rightLeg = this.rig.rightLeg.hip;
    this.leftLegUpper = this.rig.leftLeg.thigh;
    this.leftLegLower = this.rig.leftLeg.shin;
    this.rightLegUpper = this.rig.rightLeg.thigh;
    this.rightLegLower = this.rig.rightLeg.shin;
    this.TITAN_MUZZLE_OFFSETS = this.rig.muzzleOffsets;
    
    // Create physics body for collision
    this.createPhysicsBody();
    this.ballisticsSystem = new BallisticsSystem(this.scene);
    this.impactRenderer = new ImpactEffectsRenderer(this.scene);

    this.group.visible = false;
  }

  private createPhysicsBody(): void {
    // Create a box shape for the titan's body
    const shape = new CANNON.Box(new CANNON.Vec3(2, 5, 2));
    this.bodyBody = new CANNON.Body({
      mass: 0, // Static body, doesn't move
      shape: shape,
      position: new CANNON.Vec3(
        this.group.position.x,
        this.group.position.y + 5, // Center of the titan
        this.group.position.z
      )
    });
    this.world.addBody(this.bodyBody);
  }
  
  updatePhysicsPosition(): void {
    if (this.bodyBody) {
      this.bodyBody.position.set(
        this.group.position.x,
        this.group.position.y + 5,
        this.group.position.z
      );
    }
  }


  private moveBlocked(moveX: number, moveZ: number, meshes: THREE.Mesh[]): { blocked: boolean; normal: THREE.Vector3 } {
    const move = new THREE.Vector3(moveX, 0, moveZ);
    const distance = move.length();
    if (distance < 1e-6) {
      return { blocked: false, normal: new THREE.Vector3(0, 0, 0) };
    }

    const dir = move.clone().normalize();
    const rayDistance = distance + 2.2;
    const sampleHeights = [1.0, 5.0, 8.5];
    const raycaster = new THREE.Raycaster();

    for (const y of sampleHeights) {
      const origin = new THREE.Vector3(this.group.position.x, this.group.position.y + y, this.group.position.z);
      raycaster.set(origin, dir);
      raycaster.near = 0;
      raycaster.far = rayDistance;
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length > 0 && hits[0].distance <= rayDistance) {
        const hit = hits[0];
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld)
          : new THREE.Vector3(-dir.x, 0, -dir.z);
        normal.y = 0;
        if (normal.lengthSq() > 1e-6) normal.normalize();
        return { blocked: true, normal };
      }
    }

    return { blocked: false, normal: new THREE.Vector3(0, 0, 0) };
  }
  
  call(position: THREE.Vector3): void {
    if (this.state !== TitanState.INACTIVE && this.state !== TitanState.DESTROYED) {
      return;
    }
    
    this.state = TitanState.DROPPING;
    this.group.visible = true;
    this.group.position.copy(position);
    this.group.position.y = this.dropHeight;
    
    // Reset body parts to default positions
    this.body.rotation.set(0, 0, 0);
    poseTitanArms(this.rig, 0);
    this.leftLeg.rotation.set(0, 0, 0);
    this.rightLeg.rotation.set(0, 0, 0);
    
    // Trail effect setup
    this.createDropTrail();
    
    this.scene.add(this.group);
  }
  
  private createDropTrail(): void {
    // Create a particle trail behind the falling Titan
    for (let i = 0; i < 5; i++) {
      const trailGeo = new THREE.CylinderGeometry(0.2, 1.5, 10, 8);
      const trailMat = new THREE.MeshBasicMaterial({ 
        color: 0xff6600,
        transparent: true,
        opacity: 0.3
      });
      const trail = new THREE.Mesh(trailGeo, trailMat);
      trail.position.y = -15 - i * 8;
      trail.rotation.x = Math.PI;
      this.group.add(trail);
      
      // Animate and remove later
      setTimeout(() => {
        this.group.remove(trail);
        trail.geometry.dispose();
        (trail.material as THREE.Material).dispose();
      }, 2000);
    }
  }
  
  update(delta: number, targets: TitanBulletTarget[] = [], enemies: TitanBulletEnemy[] = []): void {
    switch (this.state) {
      case TitanState.DROPPING:
        this.updateDropping(delta);
        break;
      case TitanState.LANDING:
        this.updateLanding(delta);
        break;
      case TitanState.ENTERING:
        this.updateEntering(delta);
        break;
      case TitanState.PILOTING:
        this.updatePiloting(delta, targets, enemies);
        break;
      case TitanState.EXITING:
        this.updateExiting(delta);
        break;
    }
    
    // Update smoke particles
    this.updateSmokeParticles(delta);
    this.impactRenderer.update(delta);
    this.updateDashMeter(delta);

    // Keep the feet planted whatever the body height (landing, piloting crouch, walk bob)
    if (this.group.visible) poseTitanLegs(this.rig, this.body.position.y);
  }

  private updateDashMeter(delta: number): void {
    if (this.state === TitanState.DESTROYED || this.state === TitanState.INACTIVE) return;
    if (this.dashTimer > 0) return;

    if (this.dashRechargeTimer > 0) {
      this.dashRechargeTimer = Math.max(0, this.dashRechargeTimer - delta);
      return;
    }

    this.dashMeter = Math.min(
      this.MAX_DASH_METER,
      this.dashMeter + this.DASH_RECHARGE_RATE * delta
    );
  }

  private tryDash(moveDir: THREE.Vector3): void {
    if (this.dashTimer > 0) return;
    if (this.dashMeter < this.DASH_COST) return;

    const dir = moveDir.clone();
    if (dir.lengthSq() < 1e-4) {
      dir.set(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.pilotEuler.y);
    }
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) return;
    dir.normalize();

    this.dashDirection.copy(dir);
    this.dashTimer = this.DASH_DURATION;
    this.dashRechargeTimer = this.DASH_RECHARGE_DELAY;
    this.dashMeter = Math.max(0, this.dashMeter - this.DASH_COST);
    this.shakeIntensity = Math.max(this.shakeIntensity, 0.25);
  }
  
  private updateDropping(delta: number): void {
    // Fall down
    this.group.position.y -= this.dropSpeed * delta;
    
    // Add slight rotation for dramatic effect
    this.group.rotation.y += delta * 0.5;
    
    // Check for ground impact
    if (this.group.position.y <= 0) {
      this.group.position.y = 0;
      this.state = TitanState.LANDING;
      this.landingAnimation = 0;
      this.shakeIntensity = 1;
      this.createLandingEffects();
    }
  }
  
  private createLandingEffects(): void {
    // Create impact dust/smoke
    for (let i = 0; i < 30; i++) {
      this.createSmokeParticle();
    }
    
    // Create shockwave ring
    const ringGeo = new THREE.RingGeometry(0.1, 0.5, 32);
    const ringMat = new THREE.MeshBasicMaterial({ 
      color: 0x888888,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    this.scene.add(ring);
    
    // Animate shockwave
    const expandRing = () => {
      ring.scale.multiplyScalar(1.15);
      ring.material.opacity -= 0.03;
      if (ring.material.opacity <= 0) {
        this.scene.remove(ring);
        ring.geometry.dispose();
        ring.material.dispose();
      } else {
        requestAnimationFrame(expandRing);
      }
    };
    expandRing();
    
    // Screen shake effect (would be applied to camera)
    // This would be handled by the game class
  }
  
  private createSmokeParticle(): void {
    const size = 0.5 + Math.random() * 1.5;
    const smokeGeo = new THREE.SphereGeometry(size, 8, 8);
    const smokeMat = new THREE.MeshBasicMaterial({ 
      color: 0x666666,
      transparent: true,
      opacity: 0.6
    });
    const smoke = new THREE.Mesh(smokeGeo, smokeMat);
    
    // Random position around the Titan
    const angle = Math.random() * Math.PI * 2;
    const radius = 2 + Math.random() * 4;
    smoke.position.set(
      this.group.position.x + Math.cos(angle) * radius,
      0.5 + Math.random() * 2,
      this.group.position.z + Math.sin(angle) * radius
    );
    
    // Random velocity
    const velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 3,
      1 + Math.random() * 3,
      (Math.random() - 0.5) * 3
    );
    
    this.scene.add(smoke);
    this.smokeParticles.push(smoke);
    
    // Store velocity in userData
    smoke.userData.velocity = velocity;
    smoke.userData.life = 1.0;
  }
  
  private updateSmokeParticles(delta: number): void {
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const particle = this.smokeParticles[i];
      const velocity = particle.userData.velocity;
      
      // Move particle
      particle.position.add(velocity.clone().multiplyScalar(delta));
      particle.userData.life -= delta * 0.5;
      particle.scale.multiplyScalar(1.01);
      
      // Fade out
      (particle.material as THREE.MeshBasicMaterial).opacity = particle.userData.life * 0.6;
      
      // Remove dead particles
      if (particle.userData.life <= 0) {
        this.scene.remove(particle);
        particle.geometry.dispose();
        (particle.material as THREE.Material).dispose();
        this.smokeParticles.splice(i, 1);
      }
    }
  }

  
  private readonly LANDING_CROUCH = 2.3;

  private updateLanding(delta: number): void {
    this.landingAnimation += delta * 1.2;

    let t = Math.min(this.landingAnimation, 1);
    let crouchAmount: number;
    if (t < 0.25) {
      crouchAmount = (t / 0.25) * this.LANDING_CROUCH;
    } else {
      const settle = (t - 0.25) / 0.75;
      const bounce = Math.sin(settle * Math.PI) * 0.3;
      crouchAmount = this.LANDING_CROUCH - bounce;
    }
    this.applyCrouchPose(crouchAmount);

    this.shakeIntensity *= 0.9;

    if (this.landingAnimation >= 1) {
      this.state = TitanState.READY;
      this.applyCrouchPose(this.LANDING_CROUCH);
    }
  }

  private applyCrouchPose(amount: number): void {
    // Lower the body; leg IK (see update) keeps the feet planted
    this.body.position.y = -amount;
    poseTitanLegs(this.rig, this.body.position.y);

    // Torso pitches forward, arms keep holding the cannon but dip with the crouch
    this.torso.rotation.x = amount * 0.06;
    poseTitanArms(this.rig, amount / this.LANDING_CROUCH);
  }

  private resetStandingPose(): void {
    this.body.position.y = 0;
    poseTitanLegs(this.rig, 0);
    this.torso.rotation.x = 0;
    poseTitanArms(this.rig, 0);
  }
  
  private enteringTimer = 0;
  private fadeOverlay: HTMLElement | null = null;
  private enteringPhase = 0; // 0=stand up, 1=fade to black, 2=fade in from cockpit
  private readonly STAND_DURATION = 1.0;
  private readonly FADE_OUT_DURATION = 0.4;
  private readonly FADE_IN_DURATION = 0.6;

  private ensureFadeOverlay(): HTMLElement {
    if (!this.fadeOverlay) {
      this.fadeOverlay = document.createElement('div');
      this.fadeOverlay.style.cssText =
        'position:fixed;inset:0;z-index:9999;background:black;opacity:0;pointer-events:none;';
      document.body.appendChild(this.fadeOverlay);
    }
    return this.fadeOverlay;
  }

  private enteringFadeStarted = false;

  private updateEntering(delta: number): void {
    this.enteringTimer += delta;
    const overlay = this.ensureFadeOverlay();

    if (this.enteringPhase === 0) {
      // Phase 0: Stand up + fade out overlapped
      const t = Math.min(this.enteringTimer / this.STAND_DURATION, 1);
      const ease = 1 - (1 - t) * (1 - t);
      const crouch = this.LANDING_CROUCH * (1 - ease);
      this.applyCrouchPose(crouch);

      // Start fade at 20% of stand so screen is black when stand finishes
      if (t >= 0.2 && !this.enteringFadeStarted) {
        this.enteringFadeStarted = true;
        overlay.style.transition = `opacity ${this.STAND_DURATION * 0.8}s ease-in`;
        overlay.style.opacity = '1';
      }

      if (t >= 1) {
        this.resetStandingPose();
        // Screen should be black now — switch to cockpit
        this.state = TitanState.PILOTING;
        this.body.visible = false;
        this.enteringPhase = 1;
        this.enteringTimer = 0;
        this.enteringFadeStarted = false;
        overlay.style.transition = `opacity ${this.FADE_IN_DURATION}s ease-out`;
        overlay.style.opacity = '0';
      }
    } else {
      // Phase 1: Fade in to cockpit view
      if (this.enteringTimer >= this.FADE_IN_DURATION) {
        this.enteringPhase = 0;
        this.enteringTimer = 0;
        overlay.style.opacity = '0';
      }
    }
  }
  
  // Set pilot input for movement
  setPilotInput(forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean, crouch: boolean): void {
    if (this.state !== TitanState.PILOTING) return;
    
    // Update look direction
    this.pilotEuler.y -= lookX * 0.03;
    this.pilotEuler.x -= lookY * 0.02;
    this.pilotEuler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pilotEuler.x));
    
    // Calculate movement direction based on titan's current rotation
    const moveDir = new THREE.Vector3(right, 0, -forward).normalize();
    moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.pilotEuler.y);

    if (dash && !this.dashInputPrev) {
      this.tryDash(moveDir);
    }
    this.dashInputPrev = dash;
    this.pilotCrouch = crouch;
    
    // Set velocity
    if (forward !== 0 || right !== 0) {
      this.titanVelocity.x = moveDir.x * this.TITAN_SPEED;
      this.titanVelocity.z = moveDir.z * this.TITAN_SPEED;
    } else {
      // Decelerate when no input
      this.titanVelocity.x *= 0.9;
      this.titanVelocity.z *= 0.9;
    }
    
    this.isFiring = fire;
  }
  
  // Get cockpit camera position and rotation
  getCockpitCamera(): { position: THREE.Vector3; rotation: THREE.Euler } {
    // Position is at the titan's torso cockpit/visor level (no head)
    const pos = this.group.position.clone();
    pos.y += 8.9 + this.body.position.y * 0.85 + this.walkBobAmount; // Cockpit tracks crouch + walk bob
    pos.add(new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.pilotEuler.y));

    const rot = this.pilotEuler.clone();
    rot.z += this.walkRollAmount; // Subtle side-to-side roll while walking

    return {
      position: pos,
      rotation: rot
    };
  }
  
  private updatePiloting(delta: number, targets: TitanBulletTarget[], enemies: TitanBulletEnemy[]): void {
    const targetCrouchOffset = this.pilotCrouch ? -2.8 : 0;
    this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, targetCrouchOffset, 1 - Math.exp(-delta * 10));

    // Update Titan position with world collision (walls/platforms).
    if (this.dashTimer > 0) {
      this.dashTimer = Math.max(0, this.dashTimer - delta);
    }
    const dashActive = this.dashTimer > 0;
    const desiredX = (dashActive ? this.dashDirection.x * this.DASH_SPEED : this.titanVelocity.x) * delta;
    const desiredZ = (dashActive ? this.dashDirection.z * this.DASH_SPEED : this.titanVelocity.z) * delta;
    const collisionMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    const primary = this.moveBlocked(desiredX, desiredZ, collisionMeshes);
    if (!primary.blocked) {
      this.group.position.x += desiredX;
      this.group.position.z += desiredZ;
    } else {
      if (dashActive) {
        this.dashTimer = 0;
        this.titanVelocity.x = 0;
        this.titanVelocity.z = 0;
      }
      const desired = new THREE.Vector3(desiredX, 0, desiredZ);
      const slide = desired.clone().sub(primary.normal.clone().multiplyScalar(desired.dot(primary.normal)));
      const secondary = this.moveBlocked(slide.x, slide.z, collisionMeshes);
      if (!dashActive && !secondary.blocked) {
        this.group.position.x += slide.x;
        this.group.position.z += slide.z;
      } else {
        this.titanVelocity.x = 0;
        this.titanVelocity.z = 0;
        if (dashActive) {
          this.dashTimer = 0;
        }
      }
    }
    
    // Rotate titan body to face look direction (model faces +Z, camera faces -Z)
    this.group.rotation.y = this.pilotEuler.y + Math.PI;
    
    // Handle weapon firing
    if (this.isFiring && performance.now() / 1000 - this.lastFireTime > this.FIRE_COOLDOWN) {
      this.fireWeapon();
      this.lastFireTime = performance.now() / 1000;
    }
    
    // Update bullets
    this.updateBullets(delta, targets, enemies);
    
    // Shake effect decays
    this.shakeIntensity *= 0.9;

    // Animate legs and drive walk bob
    const speed = this.titanVelocity.length();
    const isDashing = this.dashTimer > 0;
    if (speed > 0.5 || isDashing) {
      const bobFreq = isDashing ? 14 : 3.5;
      const bobIntensity = isDashing ? 0.06 : 0.18;
      const rollIntensity = isDashing ? 0.002 : 0.008;
      this.walkBobTime += delta * bobFreq;
      this.walkBobAmount = Math.sin(this.walkBobTime * 2) * bobIntensity;
      this.walkRollAmount = Math.sin(this.walkBobTime) * rollIntensity;
      this.leftLeg.rotation.x = Math.sin(this.walkBobTime) * 0.3;
      this.rightLeg.rotation.x = Math.sin(this.walkBobTime + Math.PI) * 0.3;
    } else {
      this.walkBobAmount *= 0.85;
      this.walkRollAmount *= 0.85;
      this.leftLeg.rotation.x *= 0.9;
      this.rightLeg.rotation.x *= 0.9;
    }

    const crouchBlend = Math.min(1, Math.abs(this.body.position.y) / 2.8);
    poseTitanArms(this.rig, crouchBlend * 0.6);
  }

  private createCockpitWeaponMesh(): THREE.Group {
    const gun = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x495464, roughness: 0.28, metalness: 0.75 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x232c38, roughness: 0.18, metalness: 0.82 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xff8844, emissive: 0xff6622, emissiveIntensity: 0.4, roughness: 0.22, metalness: 0.55 });

    const receiver = new THREE.Mesh(bevelBox(0.34, 0.26, 1.05), bodyMat);
    receiver.position.set(0, -0.03, -0.18);
    gun.add(receiver);

    const housing = new THREE.Mesh(bevelBox(0.42, 0.24, 0.42), darkMat);
    housing.position.set(0, -0.05, 0.28);
    gun.add(housing);

    const spine = new THREE.Mesh(bevelBox(0.14, 0.08, 0.76), darkMat);
    spine.position.set(0, 0.11, -0.06);
    gun.add(spine);

    const barrelLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.92, 10), darkMat);
    barrelLeft.rotation.x = Math.PI / 2;
    barrelLeft.position.set(0.11, -0.01, -0.52);
    gun.add(barrelLeft);

    const barrelRight = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.92, 10), darkMat);
    barrelRight.rotation.x = Math.PI / 2;
    barrelRight.position.set(-0.11, -0.01, -0.52);
    gun.add(barrelRight);

    const shroud = new THREE.Mesh(bevelBox(0.38, 0.18, 0.34), bodyMat);
    shroud.position.set(0, 0.01, -0.74);
    gun.add(shroud);

    const feed = new THREE.Mesh(bevelBox(0.22, 0.16, 0.32), accentMat);
    feed.position.set(0, -0.18, 0.1);
    gun.add(feed);

    const rearBlock = new THREE.Mesh(bevelBox(0.28, 0.22, 0.24), darkMat);
    rearBlock.position.set(0, -0.02, 0.62);
    gun.add(rearBlock);

    const sightBase = new THREE.Mesh(bevelBox(0.08, 0.05, 0.18), accentMat);
    sightBase.position.set(0, 0.16, -0.18);
    gun.add(sightBase);

    const frontSight = new THREE.Mesh(bevelBox(0.05, 0.06, 0.08), accentMat);
    frontSight.position.set(0, 0.15, -0.78);
    gun.add(frontSight);

    gun.userData.adsAnchor = new THREE.Vector3(0, 0.15, -0.26);
    gun.scale.setScalar(1.05);

    gun.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.userData.ignoreRaycast = true;
      child.renderOrder = 900;
      child.frustumCulled = false;
      child.castShadow = false;
      child.receiveShadow = false;
      const material = child.material as THREE.Material & {
        transparent?: boolean;
        opacity?: number;
        depthTest?: boolean;
        depthWrite?: boolean;
        fog?: boolean;
        toneMapped?: boolean;
      };
      material.transparent = false;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.fog = false;
      material.toneMapped = false;
    });

    return gun;
  }

  private ensureCockpitWeapon(): void {
    if (!this.cockpitWeapon) {
      this.cockpitWeapon = this.createCockpitWeaponMesh();
      this.cockpitWeaponOffset.copy(this.COCKPIT_WEAPON_HIP_OFFSET);
    }
    if (!this.cockpitWeapon.parent) {
      this.scene.add(this.cockpitWeapon);
    }
    this.cockpitWeapon.visible = true;
  }

  hideCockpitWeapon(): void {
    if (!this.cockpitWeapon) return;
    this.cockpitWeapon.visible = false;
  }

  syncCockpitWeapon(camera: THREE.Camera, isADS: boolean, delta: number): void {
    this.ensureCockpitWeapon();
    if (!this.cockpitWeapon) return;

    const adsAnchor = this.cockpitWeapon.userData.adsAnchor as THREE.Vector3 | undefined;
    const targetOffset = isADS && adsAnchor
      ? this.COCKPIT_WEAPON_SIGHT_OFFSET.clone().sub(adsAnchor)
      : this.COCKPIT_WEAPON_HIP_OFFSET.clone();
    const targetRot = isADS ? this.COCKPIT_WEAPON_ADS_ROT : this.COCKPIT_WEAPON_HIP_ROT;

    this.cockpitWeaponRecoil *= Math.max(0, 1 - delta * 10);
    targetOffset.z += this.cockpitWeaponRecoil * 0.18;
    targetOffset.y += this.cockpitWeaponRecoil * 0.03;

    this.cockpitWeaponOffset.lerp(targetOffset, 0.15);

    // Position in world space (same approach as pilot weapon)
    const offset = this.cockpitWeaponOffset.clone().applyQuaternion(camera.quaternion);
    this.cockpitWeapon.position.copy(camera.position).add(offset);
    this.cockpitWeapon.quaternion.copy(camera.quaternion).multiply(
      new THREE.Quaternion().setFromEuler(targetRot)
    );
  }

  private getTitanAimPoint(origin: THREE.Vector3, aimForward: THREE.Vector3): THREE.Vector3 {
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    const raycaster = new THREE.Raycaster(origin, aimForward.clone().normalize(), 0, TITAN_WEAPON.range);
    const intersections = raycaster.intersectObjects(worldMeshes, false);
    if (intersections.length > 0) return intersections[0].point.clone();
    return origin.clone().add(aimForward.clone().multiplyScalar(TITAN_WEAPON.range));
  }

  private getTitanShotDirection(aimForward: THREE.Vector3): THREE.Vector3 {
    const spreadRad = THREE.MathUtils.degToRad(TITAN_WEAPON.spread);
    if (spreadRad <= 0) return aimForward.clone();

    const right = new THREE.Vector3().crossVectors(aimForward, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    else right.normalize();
    const up = new THREE.Vector3().crossVectors(right, aimForward).normalize();
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spreadRad;
    return aimForward.clone()
      .add(right.multiplyScalar(Math.cos(angle) * radius))
      .add(up.multiplyScalar(Math.sin(angle) * radius))
      .normalize();
  }

  private getTitanMuzzlePosition(barrelIndex: number): THREE.Vector3 {
    if (this.cockpitWeapon?.visible) {
      this.cockpitWeapon.updateWorldMatrix(true, false);
      const localOffset = this.COCKPIT_MUZZLE_OFFSETS[barrelIndex % this.COCKPIT_MUZZLE_OFFSETS.length];
      return this.cockpitWeapon.localToWorld(localOffset.clone());
    }
    this.group.updateWorldMatrix(true, false);
    const localOffset = this.TITAN_MUZZLE_OFFSETS[barrelIndex % this.TITAN_MUZZLE_OFFSETS.length];
    return this.rig.weapon.localToWorld(localOffset.clone());
  }

  private getTitanProjectileVelocity(
    startPos: THREE.Vector3,
    cameraShotDir: THREE.Vector3,
    aimPoint: THREE.Vector3,
  ): THREE.Vector3 {
    const directToAim = aimPoint.clone().sub(startPos);
    if (directToAim.lengthSq() < 1e-6) {
      return cameraShotDir.clone().multiplyScalar(TITAN_WEAPON.bulletSpeed);
    }

    directToAim.normalize();
    const maxConvergeRad = THREE.MathUtils.degToRad(5);
    const angleToAim = cameraShotDir.angleTo(directToAim);
    let finalDir = directToAim;

    if (angleToAim > maxConvergeRad) {
      finalDir = cameraShotDir.clone()
        .lerp(directToAim, maxConvergeRad / angleToAim)
        .normalize();
    }

    return finalDir.multiplyScalar(TITAN_WEAPON.bulletSpeed);
  }
  
  private fireWeapon(): void {
    const cockpit = this.getCockpitCamera();
    const aimForward = new THREE.Vector3(0, 0, -1).applyEuler(cockpit.rotation).normalize();
    const shotDir = this.getTitanShotDirection(aimForward);
    const aimPoint = this.getTitanAimPoint(cockpit.position, shotDir);
    const barrelIndex = this.titanBarrelIndex++ % this.TITAN_MUZZLE_OFFSETS.length;
    const startPos = this.getTitanMuzzlePosition(barrelIndex);
    const velocity = this.getTitanProjectileVelocity(startPos, shotDir, aimPoint);

    const bullet = this.ballisticsSystem.createBullet(startPos, velocity, TITAN_WEAPON.bulletVisuals);
    this.bullets.push(bullet);
    this.cockpitWeaponRecoil = Math.min(1, this.cockpitWeaponRecoil + 0.35);
    this.impactRenderer.spawnMuzzleFlash(startPos, velocity.clone().normalize(), {
      color: 0xffaa55,
      radius: 0.22,
      life: 0.08,
    });
    soundManager.playSound('titan_fire', 0.55);
  }

  private updateBullets(delta: number, targets: TitanBulletTarget[], enemies: TitanBulletEnemy[]): void {
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prevPos = b.mesh.position.clone();
      this.ballisticsSystem.updateBullet(b, delta);
      const step = b.mesh.position.clone().sub(prevPos);

      let hit = false;
      const stepLen = step.length();
      if (stepLen > 1e-6) {
        const raycaster = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen);
        const wallHits = raycaster.intersectObjects(worldMeshes, false);
        if (wallHits.length > 0 && wallHits[0].distance <= stepLen) {
          const wallHit = wallHits[0];
          b.mesh.position.copy(wallHit.point);
          const hitNormal = wallHit.face
            ? wallHit.face.normal.clone().transformDirection((wallHit.object as THREE.Mesh).matrixWorld)
            : step.clone().normalize().negate();
          this.impactRenderer.spawnImpact(wallHit.point, hitNormal, TITAN_IMPACT_CONFIG);
          hit = true;
        }
      }

      if (hit) {
        this.ballisticsSystem.disposeBullet(b);
        this.bullets.splice(i, 1);
        continue;
      }

      for (const target of targets) {
        if (target.checkBulletHit(b.mesh.position)) {
          target.takeDamage(TITAN_WEAPON.damage, b.mesh.position);
          this.impactRenderer.spawnImpact(
            b.mesh.position.clone(),
            b.velocity.clone().normalize().negate(),
            TITAN_IMPACT_CONFIG,
          );
          hit = true;
          break;
        }
      }

      if (!hit) {
        for (const enemy of enemies) {
          if (enemy.checkBulletHit(b.mesh.position)) {
            enemy.takeDamage(TITAN_WEAPON.damage, b.mesh.position);
            this.impactRenderer.spawnImpact(
              b.mesh.position.clone(),
              b.velocity.clone().normalize().negate(),
              TITAN_IMPACT_CONFIG,
            );
            hit = true;
            break;
          }
        }
      }

      if (hit || b.time > b.maxLifetime) {
        this.ballisticsSystem.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }
  }
  
  private exitingTimer = 0;
  private exitingPhase = 0; // 0=fade out, 1=fade in, 2=crouch down
  private onExitFadedOut: (() => void) | null = null;
  private readonly CROUCH_DOWN_DURATION = 0.8;

  setExitFadedOutCallback(cb: () => void): void {
    this.onExitFadedOut = cb;
  }

  private updateExiting(delta: number): void {
    this.exitingTimer += delta;
    const overlay = this.ensureFadeOverlay();

    if (this.exitingPhase === 0) {
      // Phase 0: Fade cockpit to black
      if (this.exitingTimer === delta) {
        overlay.style.transition = `opacity ${this.FADE_OUT_DURATION}s ease-in`;
        overlay.style.opacity = '1';
      }
      if (this.exitingTimer >= this.FADE_OUT_DURATION) {
        // Screen is black — switch to 3rd person in standing pose
        this.body.visible = true;
        this.resetStandingPose();
        if (this.onExitFadedOut) this.onExitFadedOut();
        this.exitingPhase = 1;
        this.exitingTimer = 0;
        overlay.style.transition = `opacity ${this.FADE_IN_DURATION}s ease-out`;
        overlay.style.opacity = '0';
      }
    } else if (this.exitingPhase === 1) {
      // Phase 1: Fade in + crouch down simultaneously
      const t = Math.min(this.exitingTimer / this.CROUCH_DOWN_DURATION, 1);
      const ease = t * t; // ease-in for heavy settling
      this.applyCrouchPose(this.LANDING_CROUCH * ease);

      if (this.exitingTimer >= Math.max(this.CROUCH_DOWN_DURATION, this.FADE_IN_DURATION)) {
        this.applyCrouchPose(this.LANDING_CROUCH);
        this.state = TitanState.READY;
        this.exitingTimer = 0;
        this.exitingPhase = 0;
        overlay.style.opacity = '0';
      }
    }
  }
  
  enter(): void {
    if (this.state === TitanState.READY) {
      this.state = TitanState.ENTERING;
    }
  }
  
  exit(): void {
    if (this.state === TitanState.PILOTING) {
      this.state = TitanState.EXITING;
    }
  }
  
  takeDamage(amount: number): void {
    if (this.state !== TitanState.PILOTING && this.state !== TitanState.READY) {
      return;
    }
    
    if (this.shield > 0) {
      this.shield = Math.max(0, this.shield - amount);
    } else {
      this.health = Math.max(0, this.health - amount);
    }
    
    if (this.health <= 0) {
      this.destroy();
    }
  }
  
  private destroy(): void {
    this.state = TitanState.DESTROYED;
    this.isFiring = false;
    this.titanVelocity.set(0, 0, 0);
    this.dashTimer = 0;
    if (this.fadeOverlay) {
      this.fadeOverlay.style.transition = 'none';
      this.fadeOverlay.style.opacity = '0';
    }
    if (this.bodyBody) this.world.removeBody(this.bodyBody);
    
    // Create explosion effects
    for (let i = 0; i < 20; i++) {
      this.createSmokeParticle();
    }
    
    // Hide Titan
    this.group.visible = false;
    this.hideCockpitWeapon();
  }
  
  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }
  
  rechargeShield(amount: number): void {
    this.shield = Math.min(this.maxShield, this.shield + amount);
  }
  
  getShakeIntensity(): number {
    return this.shakeIntensity;
  }

  getDashMeter(): number {
    return this.dashMeter;
  }

  getHealth(): number {
    return this.health;
  }

  getShield(): number {
    return this.shield;
  }
  
  dispose(): void {
    if (this.bodyBody) {
      this.world.removeBody(this.bodyBody);
      this.bodyBody = undefined;
    }
    this.fadeOverlay?.remove();
    this.fadeOverlay = null;

    if (this.cockpitWeapon) {
      this.cockpitWeapon.visible = false;
      if (this.cockpitWeapon.parent) this.cockpitWeapon.parent.remove(this.cockpitWeapon);
      this.cockpitWeapon.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      });
      this.cockpitWeapon = null;
    }

    disposeObject3D(this.group);
    
    this.scene.remove(this.group);
    
    // Clean up smoke particles
    this.smokeParticles.forEach(particle => {
      this.scene.remove(particle);
      particle.geometry.dispose();
      (particle.material as THREE.Material).dispose();
    });
    this.smokeParticles = [];

    this.impactRenderer.disposeAll();

    // Dispose in-flight bullets
    for (const b of this.bullets) {
      this.ballisticsSystem.disposeBullet(b);
    }
    this.bullets = [];
  }
}

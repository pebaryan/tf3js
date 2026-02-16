import * as THREE from 'three';
import * as CANNON from 'cannon-es';

type TitanBulletTarget = {
  checkBulletHit: (bulletPos: THREE.Vector3) => boolean;
  takeDamage: (amount: number, hitPoint: THREE.Vector3) => void;
};

type TitanBulletEnemy = {
  checkBulletHit: (bulletPos: THREE.Vector3) => boolean;
  takeDamage: (amount: number, hitPoint?: THREE.Vector3) => void;
};

interface ImpactParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface ImpactFlash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

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
  impactParticles: ImpactParticle[] = [];
  impactFlashes: ImpactFlash[] = [];
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
  private isFiring = false;
  private lastFireTime = 0;
  private readonly FIRE_COOLDOWN = 0.15; // seconds
  private bullets: { mesh: THREE.Mesh; velocity: THREE.Vector3; time: number }[] = [];
  
  constructor(scene: THREE.Scene, world: CANNON.World, position?: THREE.Vector3) {
    this.scene = scene;
    this.world = world;
    
    this.group = new THREE.Group();
    this.group.position.copy(position || new THREE.Vector3(0, 0, 0));
    
    // Build procedural Titan mesh
    this.body = new THREE.Group();
    this.group.add(this.body);
    
    this.buildTorso();
    this.buildHead();
    this.buildArms();
    this.buildLegs();
    this.buildDetails();
    
    // Create physics body for collision
    this.createPhysicsBody();
    
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

  private isTitanPart(obj: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (current === this.group) return true;
      current = current.parent;
    }
    return false;
  }

  private getWorldCollisionMeshes(): THREE.Mesh[] {
    return this.scene.children.filter((o) => {
      if (!(o instanceof THREE.Mesh)) return false;
      if (this.isTitanPart(o)) return false;
      if (this.bullets.some((b) => b.mesh === o)) return false;
      const mat = o.material;
      if (Array.isArray(mat)) {
        if (mat.some((m) => (m as THREE.Material).transparent)) return false;
      } else if ((mat as THREE.Material).transparent) {
        return false;
      }
      return true;
    }) as THREE.Mesh[];
  }

  private moveBlocked(moveX: number, moveZ: number, meshes: THREE.Mesh[]): { blocked: boolean; normal: THREE.Vector3 } {
    const move = new THREE.Vector3(moveX, 0, moveZ);
    const distance = move.length();
    if (distance < 1e-6) {
      return { blocked: false, normal: new THREE.Vector3(0, 0, 0) };
    }

    const dir = move.clone().normalize();
    const rayDistance = distance + 2.2;
    const sampleHeights = [1.0, 3.5, 6.5];
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
  
  private buildTorso(): void {
    // Main chest block
    const chestGeo = new THREE.BoxGeometry(3, 2.5, 2);
    const armorMat = new THREE.MeshStandardMaterial({ 
      color: 0x4a5568,
      roughness: 0.3,
      metalness: 0.7
    });
    this.torso = new THREE.Mesh(chestGeo, armorMat);
    this.torso.position.y = 4;
    this.torso.castShadow = true;
    this.torso.receiveShadow = true;
    this.body.add(this.torso);
    
    // Chest armor plate
    const chestPlateGeo = new THREE.BoxGeometry(2.2, 1.5, 0.3);
    const chestPlateMat = new THREE.MeshStandardMaterial({ 
      color: 0x2d3748,
      roughness: 0.2,
      metalness: 0.8
    });
    const chestPlate = new THREE.Mesh(chestPlateGeo, chestPlateMat);
    chestPlate.position.set(0, 0, 1.15);
    this.torso.add(chestPlate);
    
    // Abdomen
    const abdomenGeo = new THREE.BoxGeometry(2, 1.5, 1.5);
    const abdomen = new THREE.Mesh(abdomenGeo, armorMat);
    abdomen.position.y = -2;
    this.torso.add(abdomen);
    
    // Back thrusters
    const thrusterGeo = new THREE.CylinderGeometry(0.3, 0.4, 1, 8);
    const thrusterMat = new THREE.MeshStandardMaterial({ 
      color: 0x1a202c,
      emissive: 0xff6600,
      emissiveIntensity: 0.5
    });
    
    const leftThruster = new THREE.Mesh(thrusterGeo, thrusterMat);
    leftThruster.position.set(-0.8, 0, -1.2);
    leftThruster.rotation.x = Math.PI / 4;
    this.torso.add(leftThruster);
    
    const rightThruster = new THREE.Mesh(thrusterGeo, thrusterMat);
    rightThruster.position.set(0.8, 0, -1.2);
    rightThruster.rotation.x = Math.PI / 4;
    this.torso.add(rightThruster);
    
    // Lower back vent
    const ventGeo = new THREE.BoxGeometry(1.5, 0.8, 0.5);
    const vent = new THREE.Mesh(ventGeo, chestPlateMat);
    vent.position.set(0, -1.5, -0.9);
    this.torso.add(vent);
  }
  
  private buildHead(): void {
    // Main helmet
    const helmetGeo = new THREE.BoxGeometry(1.2, 1, 1.3);
    const armorMat = new THREE.MeshStandardMaterial({ 
      color: 0x4a5568,
      roughness: 0.3,
      metalness: 0.7
    });
    this.head = new THREE.Mesh(helmetGeo, armorMat);
    this.head.position.y = 1.8;
    this.head.castShadow = true;
    this.torso.add(this.head);
    
    // Visor
    const visorGeo = new THREE.BoxGeometry(0.9, 0.3, 0.1);
    const visorMat = new THREE.MeshStandardMaterial({ 
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.9
    });
    const visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0, 0.65);
    this.head.add(visor);
    
    // Helmet crest
    const crestGeo = new THREE.BoxGeometry(0.3, 0.6, 1);
    const darkArmorMat = new THREE.MeshStandardMaterial({ 
      color: 0x2d3748,
      roughness: 0.2,
      metalness: 0.8
    });
    const crest = new THREE.Mesh(crestGeo, darkArmorMat);
    crest.position.set(0, 0.5, 0);
    this.head.add(crest);
    
    // Side sensors
    const sensorGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.4, 8);
    const sensorMat = new THREE.MeshStandardMaterial({ 
      color: 0xff0000,
      emissive: 0xff0000,
      emissiveIntensity: 0.6
    });
    
    const leftSensor = new THREE.Mesh(sensorGeo, sensorMat);
    leftSensor.rotation.z = Math.PI / 2;
    leftSensor.position.set(-0.65, 0, 0);
    this.head.add(leftSensor);
    
    const rightSensor = new THREE.Mesh(sensorGeo, sensorMat);
    rightSensor.rotation.z = Math.PI / 2;
    rightSensor.position.set(0.65, 0, 0);
    this.head.add(rightSensor);
  }
  
  private buildArms(): void {
    const armorMat = new THREE.MeshStandardMaterial({ 
      color: 0x4a5568,
      roughness: 0.3,
      metalness: 0.7
    });
    const darkArmorMat = new THREE.MeshStandardMaterial({ 
      color: 0x2d3748,
      roughness: 0.2,
      metalness: 0.8
    });
    
    // Left arm
    this.leftArm = new THREE.Group();
    this.leftArm.position.set(-2, 0.8, 0);
    this.torso.add(this.leftArm);
    
    // Left shoulder
    const shoulderGeo = new THREE.SphereGeometry(0.9, 16, 12);
    this.leftShoulder = new THREE.Mesh(shoulderGeo, armorMat);
    this.leftShoulder.castShadow = true;
    this.leftArm.add(this.leftShoulder);
    
    // Left upper arm
    const upperArmGeo = new THREE.CylinderGeometry(0.5, 0.6, 1.8, 12);
    const leftUpperArm = new THREE.Mesh(upperArmGeo, armorMat);
    leftUpperArm.position.y = -1.2;
    leftUpperArm.castShadow = true;
    this.leftArm.add(leftUpperArm);
    
    // Left elbow joint
    const elbowGeo = new THREE.SphereGeometry(0.45, 12, 8);
    const leftElbow = new THREE.Mesh(elbowGeo, darkArmorMat);
    leftElbow.position.y = -2.2;
    this.leftArm.add(leftElbow);
    
    // Left forearm
    const forearmGeo = new THREE.BoxGeometry(0.9, 1.6, 1);
    this.leftForearm = new THREE.Mesh(forearmGeo, armorMat);
    this.leftForearm.position.y = -3.2;
    this.leftForearm.castShadow = true;
    this.leftArm.add(this.leftForearm);
    
    // Left fist
    const fistGeo = new THREE.BoxGeometry(0.8, 0.9, 0.9);
    this.leftFist = new THREE.Mesh(fistGeo, darkArmorMat);
    this.leftFist.position.y = -4.4;
    this.leftFist.castShadow = true;
    this.leftArm.add(this.leftFist);
    
    // Left arm armor plates
    const plateGeo = new THREE.BoxGeometry(1, 0.3, 1.2);
    const leftPlate = new THREE.Mesh(plateGeo, darkArmorMat);
    leftPlate.position.set(0, -1.2, 0.4);
    this.leftArm.add(leftPlate);
    
    // Right arm
    this.rightArm = new THREE.Group();
    this.rightArm.position.set(2, 0.8, 0);
    this.torso.add(this.rightArm);
    
    // Right shoulder
    this.rightShoulder = new THREE.Mesh(shoulderGeo, armorMat);
    this.rightShoulder.castShadow = true;
    this.rightArm.add(this.rightShoulder);
    
    // Right upper arm
    const rightUpperArm = new THREE.Mesh(upperArmGeo, armorMat);
    rightUpperArm.position.y = -1.2;
    rightUpperArm.castShadow = true;
    this.rightArm.add(rightUpperArm);
    
    // Right elbow joint
    const rightElbow = new THREE.Mesh(elbowGeo, darkArmorMat);
    rightElbow.position.y = -2.2;
    this.rightArm.add(rightElbow);
    
    // Right forearm
    this.rightForearm = new THREE.Mesh(forearmGeo, armorMat);
    this.rightForearm.position.y = -3.2;
    this.rightForearm.castShadow = true;
    this.rightArm.add(this.rightForearm);
    
    // Right fist
    this.rightFist = new THREE.Mesh(fistGeo, darkArmorMat);
    this.rightFist.position.y = -4.4;
    this.rightFist.castShadow = true;
    this.rightArm.add(this.rightFist);
    
    // Right arm armor plates
    const rightPlate = new THREE.Mesh(plateGeo, darkArmorMat);
    rightPlate.position.set(0, -1.2, 0.4);
    this.rightArm.add(rightPlate);
  }
  
  private buildLegs(): void {
    const armorMat = new THREE.MeshStandardMaterial({ 
      color: 0x4a5568,
      roughness: 0.3,
      metalness: 0.7
    });
    const darkArmorMat = new THREE.MeshStandardMaterial({ 
      color: 0x2d3748,
      roughness: 0.2,
      metalness: 0.8
    });
    
    // Left leg
    this.leftLeg = new THREE.Group();
    this.leftLeg.position.set(-1, -5.5, 0);
    this.body.add(this.leftLeg);
    
    // Left hip joint
    const hipGeo = new THREE.SphereGeometry(0.7, 12, 8);
    const leftHip = new THREE.Mesh(hipGeo, darkArmorMat);
    this.leftLeg.add(leftHip);
    
    // Left thigh
    const thighGeo = new THREE.CylinderGeometry(0.7, 0.6, 2.2, 12);
    this.leftLegUpper = new THREE.Mesh(thighGeo, armorMat);
    this.leftLegUpper.position.y = -1.5;
    this.leftLegUpper.castShadow = true;
    this.leftLeg.add(this.leftLegUpper);
    
    // Left knee
    const kneeGeo = new THREE.SphereGeometry(0.55, 12, 8);
    const leftKnee = new THREE.Mesh(kneeGeo, darkArmorMat);
    leftKnee.position.y = -2.9;
    this.leftLeg.add(leftKnee);
    
    // Left shin
    const shinGeo = new THREE.BoxGeometry(1.2, 2.2, 1.4);
    this.leftLegLower = new THREE.Mesh(shinGeo, armorMat);
    this.leftLegLower.position.y = -4.2;
    this.leftLegLower.castShadow = true;
    this.leftLeg.add(this.leftLegLower);
    
    // Left foot
    const footGeo = new THREE.BoxGeometry(1.4, 0.6, 2.2);
    const leftFoot = new THREE.Mesh(footGeo, darkArmorMat);
    leftFoot.position.set(0, -5.5, 0.3);
    leftFoot.castShadow = true;
    this.leftLeg.add(leftFoot);
    
    // Left knee armor
    const kneeArmorGeo = new THREE.BoxGeometry(0.8, 0.6, 0.8);
    const leftKneeArmor = new THREE.Mesh(kneeArmorGeo, darkArmorMat);
    leftKneeArmor.position.set(0, -2.9, 0.5);
    this.leftLeg.add(leftKneeArmor);
    
    // Right leg
    this.rightLeg = new THREE.Group();
    this.rightLeg.position.set(1, -5.5, 0);
    this.body.add(this.rightLeg);
    
    // Right hip joint
    const rightHip = new THREE.Mesh(hipGeo, darkArmorMat);
    this.rightLeg.add(rightHip);
    
    // Right thigh
    this.rightLegUpper = new THREE.Mesh(thighGeo, armorMat);
    this.rightLegUpper.position.y = -1.5;
    this.rightLegUpper.castShadow = true;
    this.rightLeg.add(this.rightLegUpper);
    
    // Right knee
    const rightKnee = new THREE.Mesh(kneeGeo, darkArmorMat);
    rightKnee.position.y = -2.9;
    this.rightLeg.add(rightKnee);
    
    // Right shin
    this.rightLegLower = new THREE.Mesh(shinGeo, armorMat);
    this.rightLegLower.position.y = -4.2;
    this.rightLegLower.castShadow = true;
    this.rightLeg.add(this.rightLegLower);
    
    // Right foot
    const rightFoot = new THREE.Mesh(footGeo, darkArmorMat);
    rightFoot.position.set(0, -5.5, 0.3);
    rightFoot.castShadow = true;
    this.rightLeg.add(rightFoot);
    
    // Right knee armor
    const rightKneeArmor = new THREE.Mesh(kneeArmorGeo, darkArmorMat);
    rightKneeArmor.position.set(0, -2.9, 0.5);
    this.rightLeg.add(rightKneeArmor);
  }
  
  private buildDetails(): void {
    const glowMat = new THREE.MeshStandardMaterial({ 
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.6
    });
    
    // Torso lights
    const lightGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.1, 8);
    
    const leftChestLight = new THREE.Mesh(lightGeo, glowMat);
    leftChestLight.rotation.z = Math.PI / 2;
    leftChestLight.position.set(-0.8, 0.5, 1.35);
    this.torso.add(leftChestLight);
    
    const rightChestLight = new THREE.Mesh(lightGeo, glowMat);
    rightChestLight.rotation.z = Math.PI / 2;
    rightChestLight.position.set(0.8, 0.5, 1.35);
    this.torso.add(rightChestLight);
    
    // Shoulder lights
    const shoulderLightGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.1, 8);
    
    const leftShoulderLight = new THREE.Mesh(shoulderLightGeo, glowMat);
    leftShoulderLight.rotation.x = Math.PI / 2;
    leftShoulderLight.position.set(0, 0.6, 0);
    this.leftShoulder.add(leftShoulderLight);
    
    const rightShoulderLight = new THREE.Mesh(shoulderLightGeo, glowMat);
    rightShoulderLight.rotation.x = Math.PI / 2;
    rightShoulderLight.position.set(0, 0.6, 0);
    this.rightShoulder.add(rightShoulderLight);
    
    // Knee lights
    const kneeLightGeo = new THREE.SphereGeometry(0.12, 8, 6);
    
    const leftKneeLight = new THREE.Mesh(kneeLightGeo, glowMat);
    leftKneeLight.position.set(0, -2.9, -0.3);
    this.leftLeg.add(leftKneeLight);
    
    const rightKneeLight = new THREE.Mesh(kneeLightGeo, glowMat);
    rightKneeLight.position.set(0, -2.9, -0.3);
    this.rightLeg.add(rightKneeLight);
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
    this.leftArm.rotation.set(0, 0, 0.2);
    this.rightArm.rotation.set(0, 0, -0.2);
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
    this.updateImpactEffects(delta);
    this.updateDashMeter(delta);
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

  private createBulletImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    const n = normal.lengthSq() > 1e-6 ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);

    const flashGeo = new THREE.RingGeometry(0.08, 0.3, 20);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffaa66,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(point).add(n.clone().multiplyScalar(0.03));
    flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.scene.add(flash);
    this.impactFlashes.push({
      mesh: flash,
      life: 0.12,
      maxLife: 0.12
    });

    const sparkCount = 10 + Math.floor(Math.random() * 5);
    for (let i = 0; i < sparkCount; i++) {
      const size = 0.03 + Math.random() * 0.04;
      const sparkGeo = new THREE.SphereGeometry(size, 4, 4);
      const sparkMat = new THREE.MeshBasicMaterial({
        color: 0xff9922,
        transparent: true,
        opacity: 1,
        depthWrite: false
      });
      const spark = new THREE.Mesh(sparkGeo, sparkMat);
      spark.position.copy(point);

      const rand = new THREE.Vector3(
        (Math.random() - 0.5) * 1.6,
        Math.random() * 1.2,
        (Math.random() - 0.5) * 1.6
      );
      const dir = n.clone().multiplyScalar(0.9).add(rand).normalize();
      const speed = 8 + Math.random() * 14;

      this.scene.add(spark);
      this.impactParticles.push({
        mesh: spark,
        velocity: dir.multiplyScalar(speed),
        life: 0.2 + Math.random() * 0.25,
        maxLife: 0.45
      });
    }
  }

  private updateImpactEffects(delta: number): void {
    for (let i = this.impactParticles.length - 1; i >= 0; i--) {
      const p = this.impactParticles[i];
      p.life -= delta;
      p.velocity.y -= 18 * delta;
      p.mesh.position.add(p.velocity.clone().multiplyScalar(delta));
      p.mesh.scale.multiplyScalar(0.98);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, p.life / p.maxLife);

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        this.impactParticles.splice(i, 1);
      }
    }

    for (let i = this.impactFlashes.length - 1; i >= 0; i--) {
      const f = this.impactFlashes[i];
      f.life -= delta;
      f.mesh.scale.multiplyScalar(1 + 8 * delta);
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, f.life / f.maxLife);

      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        (f.mesh.material as THREE.Material).dispose();
        this.impactFlashes.splice(i, 1);
      }
    }
  }
  
  private updateLanding(delta: number): void {
    this.landingAnimation += delta * 2;
    
    // Crouch animation
    const crouchAmount = Math.sin(this.landingAnimation * Math.PI) * 0.8;
    this.body.position.y = -crouchAmount;
    
    // Arms go out for balance
    this.leftArm.rotation.z = 0.2 + crouchAmount * 0.3;
    this.rightArm.rotation.z = -0.2 - crouchAmount * 0.3;
    
    // Shake effect decays
    this.shakeIntensity *= 0.9;
    
    if (this.landingAnimation >= 1) {
      this.state = TitanState.READY;
      this.body.position.y = 0;
      this.leftArm.rotation.z = 0;
      this.rightArm.rotation.z = 0;
      
      // Arms to ready position
      this.leftArm.rotation.z = 0.1;
      this.rightArm.rotation.z = -0.1;
    }
  }
  
  private enteringTimer = 0;
  
  private updateEntering(delta: number): void {
    // Animation for pilot entering the Titan
    this.enteringTimer += delta;
    
    // Entry animation: hatch opens, camera moves into position
    if (this.enteringTimer < 1.0) {
      // Torso tilts back to open hatch
      this.torso.rotation.x = -0.5 * (this.enteringTimer / 1.0);
    } else {
      // Entry complete, transition to PILOTING
      this.torso.rotation.x = 0;
      this.enteringTimer = 0;
      this.state = TitanState.PILOTING;
    }
  }
  
  // Set pilot input for movement
  setPilotInput(forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean): void {
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
    // Position is at the titan's head/cockpit level
    const pos = this.group.position.clone();
    pos.y += 7; // Cockpit height
    pos.add(new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.pilotEuler.y));
    
    return {
      position: pos,
      rotation: this.pilotEuler.clone()
    };
  }
  
  private updatePiloting(delta: number, targets: TitanBulletTarget[], enemies: TitanBulletEnemy[]): void {
    // Update Titan position with world collision (walls/platforms).
    if (this.dashTimer > 0) {
      this.dashTimer = Math.max(0, this.dashTimer - delta);
    }
    const dashActive = this.dashTimer > 0;
    const desiredX = (dashActive ? this.dashDirection.x * this.DASH_SPEED : this.titanVelocity.x) * delta;
    const desiredZ = (dashActive ? this.dashDirection.z * this.DASH_SPEED : this.titanVelocity.z) * delta;
    const collisionMeshes = this.getWorldCollisionMeshes();
    const primary = this.moveBlocked(desiredX, desiredZ, collisionMeshes);
    if (!primary.blocked) {
      this.group.position.x += desiredX;
      this.group.position.z += desiredZ;
    } else {
      const desired = new THREE.Vector3(desiredX, 0, desiredZ);
      const slide = desired.clone().sub(primary.normal.clone().multiplyScalar(desired.dot(primary.normal)));
      const secondary = this.moveBlocked(slide.x, slide.z, collisionMeshes);
      if (!secondary.blocked) {
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
    
    // Rotate titan body to face look direction
    this.group.rotation.y = this.pilotEuler.y;
    
    // Handle weapon firing
    if (this.isFiring && performance.now() / 1000 - this.lastFireTime > this.FIRE_COOLDOWN) {
      this.fireWeapon();
      this.lastFireTime = performance.now() / 1000;
    }
    
    // Update bullets
    this.updateBullets(delta, targets, enemies);
    
    // Animate legs while walking
    if (this.titanVelocity.length() > 0.5) {
      const walkCycle = performance.now() / 1000 * 5;
      this.leftLeg.rotation.x = Math.sin(walkCycle) * 0.3;
      this.rightLeg.rotation.x = Math.sin(walkCycle + Math.PI) * 0.3;
    } else {
      // Reset legs when stopped
      this.leftLeg.rotation.x *= 0.9;
      this.rightLeg.rotation.x *= 0.9;
    }
  }
  
  private fireWeapon(): void {
    // Create bullet from right arm position
    const bulletGeo = new THREE.SphereGeometry(0.2, 8, 8);
    const bulletMat = new THREE.MeshBasicMaterial({ color: 0xff6600 });
    const bullet = new THREE.Mesh(bulletGeo, bulletMat);

    // Find crosshair aim point from cockpit camera ray.
    const cockpit = this.getCockpitCamera();
    const aimForward = new THREE.Vector3(0, 0, -1).applyEuler(cockpit.rotation).normalize();
    const raycaster = new THREE.Raycaster(cockpit.position, aimForward, 0, 500);
    const intersections = raycaster.intersectObjects(this.getWorldCollisionMeshes(), false);
    const aimPoint = intersections.length > 0
      ? intersections[0].point
      : cockpit.position.clone().add(aimForward.clone().multiplyScalar(200));

    // Spawn from muzzle/hand so visuals are weapon-origin.
    const startPos = new THREE.Vector3();
    this.rightFist.getWorldPosition(startPos);
    bullet.position.copy(startPos);
    const shotDir = aimPoint.sub(startPos).normalize();
    const velocity = shotDir.multiplyScalar(150);
    
    this.scene.add(bullet);
    this.bullets.push({
      mesh: bullet,
      velocity: velocity,
      time: 0
    });
  }
  
  private updateBullets(delta: number, targets: TitanBulletTarget[], enemies: TitanBulletEnemy[]): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.time += delta;
      
      const prevPos = b.mesh.position.clone();
      const step = b.velocity.clone().multiplyScalar(delta);
      const nextPos = prevPos.clone().add(step);
      b.mesh.position.copy(nextPos);

      let hit = false;
      const stepLen = step.length();
      if (stepLen > 1e-6) {
        const raycaster = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen);
        const wallHits = raycaster.intersectObjects(this.getWorldCollisionMeshes(), false);
        if (wallHits.length > 0 && wallHits[0].distance <= stepLen) {
          const wallHit = wallHits[0];
          b.mesh.position.copy(wallHit.point);
          const hitNormal = wallHit.face
            ? wallHit.face.normal.clone().transformDirection((wallHit.object as THREE.Mesh).matrixWorld)
            : step.clone().normalize().negate();
          this.createBulletImpact(wallHit.point, hitNormal);
          hit = true;
        }
      }

      if (hit) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.bullets.splice(i, 1);
        continue;
      }

      for (const target of targets) {
        if (target.checkBulletHit(b.mesh.position)) {
          target.takeDamage(35, b.mesh.position);
          hit = true;
          break;
        }
      }

      if (!hit) {
        for (const enemy of enemies) {
          if (enemy.checkBulletHit(b.mesh.position)) {
            enemy.takeDamage(35, b.mesh.position);
            hit = true;
            break;
          }
        }
      }
      
      // Remove on hit or after lifetime.
      if (hit || b.time > 3) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.bullets.splice(i, 1);
      }
    }
  }
  
  private exitingTimer = 0;
  
  private updateExiting(delta: number): void {
    // Animation for pilot exiting the Titan
    this.exitingTimer += delta;
    
    // Play exit animation
    if (this.exitingTimer < 0.5) {
      // Eject animation - Titan opens hatch
      this.torso.rotation.x = -0.3 * (this.exitingTimer / 0.5);
    } else if (this.exitingTimer < 1.0) {
      // Pilot ejecting
      this.torso.rotation.x = -0.3;
    } else {
      // Reset and transition to READY state
      this.torso.rotation.x = 0;
      this.state = TitanState.READY;
      this.exitingTimer = 0;
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
    
    // Create explosion effects
    for (let i = 0; i < 20; i++) {
      this.createSmokeParticle();
    }
    
    // Hide Titan
    this.group.visible = false;
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
  
  dispose(): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    
    this.scene.remove(this.group);
    
    // Clean up smoke particles
    this.smokeParticles.forEach(particle => {
      this.scene.remove(particle);
      particle.geometry.dispose();
      (particle.material as THREE.Material).dispose();
    });
    this.smokeParticles = [];

    this.impactParticles.forEach((particle) => {
      this.scene.remove(particle.mesh);
      particle.mesh.geometry.dispose();
      (particle.mesh.material as THREE.Material).dispose();
    });
    this.impactParticles = [];

    this.impactFlashes.forEach((flash) => {
      this.scene.remove(flash.mesh);
      flash.mesh.geometry.dispose();
      (flash.mesh.material as THREE.Material).dispose();
    });
    this.impactFlashes = [];
  }
}

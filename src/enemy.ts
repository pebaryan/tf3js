import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BallisticsSystem, Bullet } from './ballistics';
import { soundManager } from './sound';

// --- AI State Machine ---

enum EnemyState {
  IDLE,
  PATROL,
  CHASE,
  ATTACK,
  STRAFE,
  RETREAT,
  FLANK,
  SEEK_COVER,
}

interface DamageNumber {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

// Red/orange enemy bullet visuals
const ENEMY_BULLET_VISUALS = {
  meshType: 'sphere' as const,
  color: 0xff4422,
  radius: 0.04,
  length: 0,
  hasTrail: true,
  trailColor: 0xff6633,
  trailLength: 12,
  gravity: -10,
  maxLifetime: 3,
  explosive: false,
  splashRadius: 0,
};

export class Enemy {
  scene: THREE.Scene;
  world: CANNON.World;
  mesh: THREE.Group; // now a group (humanoid)
  group: THREE.Group; // alias for compatibility
  body?: CANNON.Body;

  private maxHealth = 50;
  health = 50;
  speed: number;
  aggressive: boolean;
  attackTimer = 0;
  attackCooldown: number;

  // --- AI ---
  private state = EnemyState.PATROL;
  private stateTimer = 0;
  private patrolWaypoints: THREE.Vector3[] = [];
  private patrolIndex = 0;
  private strafeDir = 1; // 1 = right, -1 = left
  private strafeTimer = 0;
  private hasLOS = false;
  private spawnPos: THREE.Vector3;
  private lastKnownPlayerPos: THREE.Vector3 | null = null;
  private reactionTimer = 0; // delay before first shot after spotting player
  private reactionTime: number; // how long to wait (difficulty-scaled)
  private flankSide = 1; // 1 or -1

  // --- Shooting ---
  private ballisticsSystem: BallisticsSystem;
  bullets: Bullet[] = [];
  private fireTimer = 0;
  private fireInterval: number; // seconds between shots (varies per enemy)
  private burstCount = 0; // shots remaining in current burst
  private burstSize: number; // shots per burst
  private burstCooldown = 0; // delay between bursts
  private readonly BULLET_SPEED = 60;
  private baseAccuracy: number; // degrees spread (lower = better)

  // --- Detection ---
  private readonly DETECTION_RANGE = 25;
  private readonly CHASE_DISENGAGE = 30;
  private readonly ATTACK_RANGE = 15;
  private readonly RETREAT_THRESHOLD = 0.3; // 30% health

  // --- Movement speeds ---
  private readonly CHASE_SPEED = 4;
  private readonly STRAFE_SPEED = 3;
  private readonly PATROL_SPEED = 1.5;
  private readonly FLANK_SPEED = 3.5;

  // --- Difficulty ---
  private difficulty: number; // 0-1, affects accuracy, reaction, aggression

  // --- Visuals ---
  private damageNumbers: DamageNumber[] = [];
  private isFlashing = false;
  private flashTimer = 0;
  private flashMeshes: THREE.Mesh[] = [];
  private readonly DAMAGE_NUMBER_LIFE = 1.0;

  // --- Animation ---
  private headMesh: THREE.Mesh | null = null;
  private leftLegMesh: THREE.Mesh | null = null;
  private rightLegMesh: THREE.Mesh | null = null;
  private walkPhase = 0;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    position: THREE.Vector3,
    options?: {
      health?: number;
      speed?: number;
      aggressive?: boolean;
      attackCooldown?: number;
      difficulty?: number;
    },
  ) {
    this.scene = scene;
    this.world = world;
    this.spawnPos = position.clone();

    this.difficulty = Math.max(0, Math.min(1, options?.difficulty ?? 0.5));
    this.maxHealth = options?.health ?? 50;
    this.health = this.maxHealth;
    this.speed = options?.speed ?? 1.5;
    this.aggressive = options?.aggressive ?? true;
    this.attackCooldown = options?.attackCooldown ?? 2;

    // Difficulty-scaled shooting: harder enemies fire faster, more accurately, in longer bursts
    this.fireInterval = 0.15 + (1 - this.difficulty) * 0.15; // 0.15-0.3s between shots in burst
    this.burstSize = 2 + Math.floor(this.difficulty * 4); // 2-6 shots per burst
    this.baseAccuracy = 6 - this.difficulty * 4; // 6° to 2° spread
    this.reactionTime = 0.5 + (1 - this.difficulty) * 0.8; // 0.5-1.3s reaction
    this.flankSide = Math.random() > 0.5 ? 1 : -1;

    // Build humanoid mesh
    this.mesh = new THREE.Group();
    this.group = this.mesh;
    this.buildHumanoidMesh();
    this.mesh.position.copy(position);
    scene.add(this.mesh);

    // Ballistics
    this.ballisticsSystem = new BallisticsSystem(scene);

    // Generate patrol waypoints
    this.generatePatrolWaypoints();

    // Start in patrol or idle
    this.state = this.aggressive ? EnemyState.PATROL : EnemyState.IDLE;
  }

  private buildHumanoidMesh(): void {
    const bodyColor = 0xcc2222;
    const darkColor = 0x881111;
    const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor });
    const darkMat = new THREE.MeshStandardMaterial({ color: darkColor });

    // Torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.25), bodyMat);
    torso.position.y = 1.1;
    torso.castShadow = true;
    this.mesh.add(torso);

    // Head
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), bodyMat);
    head.position.y = 1.7;
    head.castShadow = true;
    this.mesh.add(head);
    this.headMesh = head;

    // Visor (dark slit)
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.06, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x220000 }),
    );
    visor.position.set(0, 1.72, 0.13);
    this.mesh.add(visor);

    // Left leg
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.15), darkMat);
    leftLeg.position.set(-0.1, 0.35, 0);
    leftLeg.castShadow = true;
    this.mesh.add(leftLeg);
    this.leftLegMesh = leftLeg;

    // Right leg
    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.15), darkMat);
    rightLeg.position.set(0.1, 0.35, 0);
    rightLeg.castShadow = true;
    this.mesh.add(rightLeg);
    this.rightLegMesh = rightLeg;

    // Weapon (small box extending forward from right hand)
    const weapon = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x444444 }),
    );
    weapon.position.set(0.25, 1.0, 0.2);
    weapon.castShadow = true;
    this.mesh.add(weapon);

    // Flash overlays on torso and head
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    const torsoFlash = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.82, 0.27), flashMat);
    torsoFlash.position.copy(torso.position);
    this.mesh.add(torsoFlash);
    this.flashMeshes.push(torsoFlash);

    const headFlash = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.27, 0.27), flashMat.clone());
    headFlash.position.copy(head.position);
    this.mesh.add(headFlash);
    this.flashMeshes.push(headFlash);
  }

  private generatePatrolWaypoints(): void {
    const count = 2 + Math.floor(Math.random() * 2); // 2-3 waypoints
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const radius = 4 + Math.random() * 4; // 4-8m from spawn
      this.patrolWaypoints.push(
        new THREE.Vector3(
          this.spawnPos.x + Math.cos(angle) * radius,
          this.spawnPos.y,
          this.spawnPos.z + Math.sin(angle) * radius,
        ),
      );
    }
  }

  updatePosition(position: THREE.Vector3): void {
    this.mesh.position.copy(position);
  }

  getPosition(): THREE.Vector3 {
    return this.mesh.position;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    this.health = Math.max(0, this.health - amount);

    // Flash white
    this.isFlashing = true;
    this.flashTimer = 0.1;
    for (const fm of this.flashMeshes) {
      (fm.material as THREE.MeshBasicMaterial).opacity = 0.5;
    }

    // Spawn damage number
    const spawnPoint = hitPoint || this.mesh.position.clone().add(new THREE.Vector3(0, 1, 0));
    this.spawnDamageNumber(amount, spawnPoint);

    // Taking damage = instant aggro, skip reaction time
    this.reactionTimer = this.reactionTime;
    if (this.state === EnemyState.IDLE || this.state === EnemyState.PATROL) {
      this.state = EnemyState.CHASE;
      this.stateTimer = 0;
    }
  }

  private spawnDamageNumber(damage: number, position: THREE.Vector3): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 128, 128);
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = '#ff0000';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = Math.round(damage).toString();
    ctx.strokeText(text, 64, 64);
    ctx.fillText(text, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, 0.5, 0));
    mesh.lookAt(this.scene.position);
    this.scene.add(mesh);

    this.damageNumbers.push({
      mesh,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        1 + Math.random() * 0.5,
        (Math.random() - 0.5) * 0.5,
      ),
      life: this.DAMAGE_NUMBER_LIFE,
      maxLife: this.DAMAGE_NUMBER_LIFE,
    });
  }

  // --- Line of Sight ---

  hasLineOfSight(playerPos: THREE.Vector3, worldMeshes: THREE.Mesh[]): boolean {
    const eyePos = this.mesh.position.clone();
    eyePos.y += 1.6; // eye level
    const dir = playerPos.clone().sub(eyePos);
    const dist = dir.length();
    if (dist < 0.1) return true;
    dir.normalize();

    const rc = new THREE.Raycaster(eyePos, dir, 0, dist);
    const hits = rc.intersectObjects(worldMeshes, false);
    return hits.length === 0;
  }

  // --- Face Player (Y-axis only) ---

  private facePlayer(playerPos: THREE.Vector3): void {
    const dx = playerPos.x - this.mesh.position.x;
    const dz = playerPos.z - this.mesh.position.z;
    this.mesh.rotation.y = Math.atan2(dx, dz);
  }

  // --- Shooting ---

  private shootAt(playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    const eyePos = this.mesh.position.clone();
    eyePos.y += 1.0; // weapon height

    // Aim lead: predict where player will be based on bullet travel time
    let aimTarget = playerPos.clone();
    if (playerVel && playerVel.length() > 1) {
      const dist = eyePos.distanceTo(playerPos);
      const travelTime = dist / this.BULLET_SPEED;
      // Partial lead scaled by difficulty (harder enemies lead better)
      const leadFactor = 0.3 + this.difficulty * 0.5;
      aimTarget.add(playerVel.clone().multiplyScalar(travelTime * leadFactor));
    }

    const aimDir = aimTarget.sub(eyePos).normalize();

    // Apply inaccuracy spread (scaled by difficulty)
    const spreadRad = (this.baseAccuracy * Math.PI) / 180;
    const right = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, aimDir).normalize();
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spreadRad;
    aimDir.add(right.multiplyScalar(Math.cos(angle) * radius));
    aimDir.add(up.multiplyScalar(Math.sin(angle) * radius));
    aimDir.normalize();

    const velocity = aimDir.multiplyScalar(this.BULLET_SPEED);
    const bullet = this.ballisticsSystem.createBullet(eyePos, velocity, ENEMY_BULLET_VISUALS);
    this.bullets.push(bullet);
    soundManager.playSound('enemy_fire', 0.3);
  }

  // --- Main AI Update ---

  update(delta: number, cameraPos: THREE.Vector3, playerPos: THREE.Vector3, worldMeshes: THREE.Mesh[], playerVel?: THREE.Vector3): void {
    this.stateTimer += delta;
    this.fireTimer += delta;
    if (this.burstCooldown > 0) this.burstCooldown -= delta;

    // Distance to player
    const toPlayer = playerPos.clone().sub(this.mesh.position);
    const dist = toPlayer.length();

    // Check line of sight
    this.hasLOS = this.hasLineOfSight(playerPos, worldMeshes);

    // Track last known player position when we have LOS
    if (this.hasLOS && dist < this.DETECTION_RANGE) {
      this.lastKnownPlayerPos = playerPos.clone();
    }

    // Reaction timer: delays first engagement after spotting
    if (this.hasLOS && dist < this.DETECTION_RANGE && this.reactionTimer < this.reactionTime) {
      this.reactionTimer += delta;
    }

    // --- State transitions ---
    this.updateStateMachine(dist, delta);

    // --- Execute current state behavior ---
    this.executeBehavior(delta, playerPos, playerVel);

    // --- Animate legs ---
    this.animateLegs(delta);

    // --- Head tracking ---
    this.trackHead(playerPos);

    // --- Update bullets ---
    this.updateBullets(delta);

    // --- Update flash ---
    if (this.isFlashing) {
      this.flashTimer -= delta;
      const opacity = Math.max(0, this.flashTimer * 5);
      for (const fm of this.flashMeshes) {
        (fm.material as THREE.MeshBasicMaterial).opacity = opacity;
      }
      if (this.flashTimer <= 0) {
        this.isFlashing = false;
      }
    }

    // --- Update damage numbers ---
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.life -= delta;
      dn.mesh.position.add(dn.velocity.clone().multiplyScalar(delta));
      dn.mesh.lookAt(cameraPos);
      (dn.mesh.material as THREE.MeshBasicMaterial).opacity = dn.life / dn.maxLife;
      if (dn.life <= 0) {
        this.scene.remove(dn.mesh);
        dn.mesh.geometry.dispose();
        const mat = dn.mesh.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
        this.damageNumbers.splice(i, 1);
      }
    }
  }

  private updateStateMachine(dist: number, delta: number): void {
    const healthPct = this.health / this.maxHealth;

    switch (this.state) {
      case EnemyState.IDLE:
        if (this.hasLOS && dist < this.DETECTION_RANGE) {
          this.state = EnemyState.CHASE;
          this.stateTimer = 0;
          this.reactionTimer = 0;
        }
        break;

      case EnemyState.PATROL:
        if (this.hasLOS && dist < this.DETECTION_RANGE) {
          this.state = EnemyState.CHASE;
          this.stateTimer = 0;
          this.reactionTimer = 0;
        }
        break;

      case EnemyState.CHASE:
        if (dist < this.ATTACK_RANGE && this.hasLOS) {
          this.state = EnemyState.ATTACK;
          this.stateTimer = 0;
        } else if (dist > this.CHASE_DISENGAGE && !this.hasLOS) {
          this.state = EnemyState.PATROL;
          this.stateTimer = 0;
          this.reactionTimer = 0;
        }
        break;

      case EnemyState.ATTACK:
        if (healthPct < this.RETREAT_THRESHOLD) {
          this.state = EnemyState.SEEK_COVER;
          this.stateTimer = 0;
        } else if (!this.hasLOS && this.stateTimer > 0.5) {
          // Lost LOS — flank instead of just chasing
          this.state = EnemyState.FLANK;
          this.stateTimer = 0;
        } else if (dist > this.ATTACK_RANGE * 1.3) {
          this.state = EnemyState.CHASE;
          this.stateTimer = 0;
        } else if (this.stateTimer > 1.5 + Math.random() * 1.0) {
          // After shooting for a bit, strafe or flank
          if (Math.random() < 0.3 + this.difficulty * 0.3) {
            this.state = EnemyState.FLANK;
            this.stateTimer = 0;
          } else {
            this.state = EnemyState.STRAFE;
            this.stateTimer = 0;
            this.strafeDir = Math.random() > 0.5 ? 1 : -1;
          }
        }
        break;

      case EnemyState.STRAFE:
        if (healthPct < this.RETREAT_THRESHOLD) {
          this.state = EnemyState.SEEK_COVER;
          this.stateTimer = 0;
        } else if (this.stateTimer > 1.0 + Math.random() * 1.0) {
          this.state = EnemyState.ATTACK;
          this.stateTimer = 0;
        } else if (dist > this.ATTACK_RANGE * 1.5) {
          this.state = EnemyState.CHASE;
          this.stateTimer = 0;
        }
        // Random direction switch during strafe
        this.strafeTimer += delta;
        if (this.strafeTimer > 1 + Math.random()) {
          this.strafeDir *= -1;
          this.strafeTimer = 0;
        }
        break;

      case EnemyState.FLANK:
        // Flank: move to the side of the player, then re-engage
        if (this.stateTimer > 2.0 + Math.random()) {
          this.state = this.hasLOS ? EnemyState.ATTACK : EnemyState.CHASE;
          this.stateTimer = 0;
        } else if (dist < this.ATTACK_RANGE * 0.6 && this.hasLOS) {
          // Close enough after flanking — attack
          this.state = EnemyState.ATTACK;
          this.stateTimer = 0;
        }
        break;

      case EnemyState.SEEK_COVER:
        // Move away, then if health recovered or enough distance, re-engage
        if (this.stateTimer > 2.5) {
          this.state = healthPct > this.RETREAT_THRESHOLD ? EnemyState.ATTACK : EnemyState.RETREAT;
          this.stateTimer = 0;
        }
        break;

      case EnemyState.RETREAT:
        if (dist > this.ATTACK_RANGE * 1.5) {
          this.state = EnemyState.SEEK_COVER;
          this.stateTimer = 0;
        }
        if (dist > this.ATTACK_RANGE && healthPct >= this.RETREAT_THRESHOLD) {
          this.state = EnemyState.ATTACK;
          this.stateTimer = 0;
        }
        break;
    }
  }

  private executeBehavior(delta: number, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    const canShoot = this.hasLOS && this.reactionTimer >= this.reactionTime;

    switch (this.state) {
      case EnemyState.IDLE:
        this.mesh.rotation.y += 0.3 * delta;
        break;

      case EnemyState.PATROL:
        this.doPatrol(delta);
        break;

      case EnemyState.CHASE:
        this.facePlayer(playerPos);
        this.moveToward(this.lastKnownPlayerPos ?? playerPos, this.CHASE_SPEED * delta);
        break;

      case EnemyState.ATTACK:
        this.facePlayer(playerPos);
        this.doBurstFire(playerPos, canShoot, playerVel);
        break;

      case EnemyState.STRAFE:
        this.facePlayer(playerPos);
        this.doStrafe(delta, playerPos);
        this.doBurstFire(playerPos, canShoot, playerVel);
        break;

      case EnemyState.FLANK:
        // Move to the side of the player while approaching
        this.facePlayer(playerPos);
        this.doFlank(delta, playerPos);
        // Opportunistic shots while flanking
        if (canShoot && this.fireTimer >= this.fireInterval * 2) {
          this.shootAt(playerPos, playerVel);
          this.fireTimer = 0;
        }
        break;

      case EnemyState.SEEK_COVER:
        // Move perpendicular to player direction (find cover by going sideways + away)
        this.facePlayer(playerPos);
        this.doSeekCover(delta, playerPos);
        break;

      case EnemyState.RETREAT:
        this.facePlayer(playerPos);
        this.moveAwayFrom(playerPos, this.CHASE_SPEED * delta);
        // Suppressive fire while retreating (inaccurate)
        if (canShoot && this.fireTimer >= this.fireInterval * 2) {
          this.shootAt(playerPos);
          this.fireTimer = 0;
        }
        break;
    }
  }

  private doBurstFire(playerPos: THREE.Vector3, canShoot: boolean, playerVel?: THREE.Vector3): void {
    if (!canShoot) return;

    // Burst system: fire N shots quickly, then pause
    if (this.burstCount > 0 && this.fireTimer >= this.fireInterval) {
      this.shootAt(playerPos, playerVel);
      this.fireTimer = 0;
      this.burstCount--;
      if (this.burstCount === 0) {
        // Pause between bursts (longer for easier enemies)
        this.burstCooldown = 0.8 + (1 - this.difficulty) * 1.2;
      }
    } else if (this.burstCount === 0 && this.burstCooldown <= 0) {
      // Start new burst
      this.burstCount = this.burstSize;
    }
  }

  private doFlank(delta: number, playerPos: THREE.Vector3): void {
    const toPlayer = playerPos.clone().sub(this.mesh.position);
    toPlayer.y = 0;
    if (toPlayer.length() < 0.1) return;
    toPlayer.normalize();

    // Move sideways relative to player + slightly toward
    const right = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x);
    const moveDir = right.multiplyScalar(this.flankSide * 0.7).add(toPlayer.multiplyScalar(0.3));
    moveDir.normalize();
    this.mesh.position.x += moveDir.x * this.FLANK_SPEED * delta;
    this.mesh.position.z += moveDir.z * this.FLANK_SPEED * delta;
  }

  private doSeekCover(delta: number, playerPos: THREE.Vector3): void {
    const toPlayer = playerPos.clone().sub(this.mesh.position);
    toPlayer.y = 0;
    if (toPlayer.length() < 0.1) return;
    toPlayer.normalize();

    // Move perpendicular + away from player
    const right = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x);
    const moveDir = right.multiplyScalar(this.flankSide * 0.5).add(toPlayer.multiplyScalar(-0.5));
    moveDir.normalize();
    this.mesh.position.x += moveDir.x * this.CHASE_SPEED * delta;
    this.mesh.position.z += moveDir.z * this.CHASE_SPEED * delta;
  }

  private doPatrol(delta: number): void {
    if (this.patrolWaypoints.length === 0) return;
    const target = this.patrolWaypoints[this.patrolIndex];
    const toTarget = target.clone().sub(this.mesh.position);
    toTarget.y = 0;
    const dist = toTarget.length();

    if (dist < 1.0) {
      // Reached waypoint, go to next
      this.patrolIndex = (this.patrolIndex + 1) % this.patrolWaypoints.length;
      return;
    }

    // Face waypoint
    const dx = target.x - this.mesh.position.x;
    const dz = target.z - this.mesh.position.z;
    this.mesh.rotation.y = Math.atan2(dx, dz);

    // Move toward waypoint
    toTarget.normalize();
    this.mesh.position.x += toTarget.x * this.PATROL_SPEED * delta;
    this.mesh.position.z += toTarget.z * this.PATROL_SPEED * delta;
  }

  private moveToward(target: THREE.Vector3, amount: number): void {
    const dir = target.clone().sub(this.mesh.position);
    dir.y = 0;
    if (dir.length() > 0.5) {
      dir.normalize();
      this.mesh.position.x += dir.x * amount;
      this.mesh.position.z += dir.z * amount;
    }
  }

  private moveAwayFrom(target: THREE.Vector3, amount: number): void {
    const dir = this.mesh.position.clone().sub(target);
    dir.y = 0;
    if (dir.length() > 0.1) {
      dir.normalize();
      this.mesh.position.x += dir.x * amount;
      this.mesh.position.z += dir.z * amount;
    }
  }

  private doStrafe(delta: number, playerPos: THREE.Vector3): void {
    // Perpendicular to player direction
    const toPlayer = playerPos.clone().sub(this.mesh.position);
    toPlayer.y = 0;
    if (toPlayer.length() < 0.1) return;
    toPlayer.normalize();

    // Right vector (perpendicular)
    const right = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x);
    this.mesh.position.x += right.x * this.STRAFE_SPEED * this.strafeDir * delta;
    this.mesh.position.z += right.z * this.STRAFE_SPEED * this.strafeDir * delta;
  }

  private animateLegs(delta: number): void {
    // Only animate if moving
    const isMoving = this.state === EnemyState.PATROL || this.state === EnemyState.CHASE
      || this.state === EnemyState.STRAFE || this.state === EnemyState.FLANK
      || this.state === EnemyState.RETREAT || this.state === EnemyState.SEEK_COVER;

    if (isMoving) {
      const speed = this.state === EnemyState.PATROL ? this.PATROL_SPEED : this.CHASE_SPEED;
      this.walkPhase += delta * speed * 4;
      const swing = Math.sin(this.walkPhase) * 0.4;
      if (this.leftLegMesh) this.leftLegMesh.rotation.x = swing;
      if (this.rightLegMesh) this.rightLegMesh.rotation.x = -swing;
    } else {
      // Ease back to standing
      if (this.leftLegMesh) this.leftLegMesh.rotation.x *= 0.9;
      if (this.rightLegMesh) this.rightLegMesh.rotation.x *= 0.9;
    }
  }

  private trackHead(playerPos: THREE.Vector3): void {
    if (!this.headMesh) return;
    // Only track when aware of player
    if (this.state === EnemyState.IDLE || this.state === EnemyState.PATROL) {
      this.headMesh.rotation.y *= 0.9; // ease back to center
      return;
    }
    // Local-space angle to player
    const dx = playerPos.x - this.mesh.position.x;
    const dz = playerPos.z - this.mesh.position.z;
    const worldAngle = Math.atan2(dx, dz);
    const localAngle = worldAngle - this.mesh.rotation.y;
    // Clamp head turn to ±45°
    const clamped = Math.max(-0.8, Math.min(0.8, localAngle));
    this.headMesh.rotation.y += (clamped - this.headMesh.rotation.y) * 0.1;
  }

  private updateBullets(delta: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      this.ballisticsSystem.updateBullet(b, delta);

      if (b.time > b.maxLifetime || b.mesh.position.y < -5) {
        this.ballisticsSystem.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }
  }

  checkBulletHit(bulletPos: THREE.Vector3): boolean {
    const targetPos = this.mesh.position;
    const dx = bulletPos.x - targetPos.x;
    const dz = bulletPos.z - targetPos.z;
    const dy = bulletPos.y - (targetPos.y + 0.9); // center mass
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq < 1.2 * 1.2;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });

    // Dispose bullets
    for (const b of this.bullets) {
      this.ballisticsSystem.disposeBullet(b);
    }
    this.bullets = [];

    // Clean up damage numbers
    this.damageNumbers.forEach((dn) => {
      this.scene.remove(dn.mesh);
      dn.mesh.geometry.dispose();
      const mat = dn.mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    });
    this.damageNumbers = [];
  }
}

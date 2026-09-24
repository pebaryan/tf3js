import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { BallisticsSystem, Bullet } from './ballistics';
import { soundManager } from './sound';
import { segmentIntersectsSphere } from './collision';
import { bevelBox, mergeAndDispose } from './geometryUtils';

/** Sphere approximating the player's body for enemy-bullet hit tests. */
export interface PlayerHitbox {
  center: THREE.Vector3;
  radius: number;
}

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
  private isFlashing = false;
  private flashTimer = 0;
  private flashMeshes: THREE.Mesh[] = [];

  // --- Environment (refreshed every update) ---
  private worldMeshes: THREE.Mesh[] = [];
  private readonly moveRaycaster = new THREE.Raycaster();
  private readonly ENEMY_RADIUS = 0.4;

  // --- Animation ---
  private headMesh: THREE.Object3D | null = null;
  private leftLegMesh: THREE.Object3D | null = null;
  private rightLegMesh: THREE.Object3D | null = null;
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

  /**
   * Build the soldier model. Static parts are merged per material so each
   * soldier costs about a dozen draw calls; legs and head stay separate
   * because they animate.
   */
  private buildHumanoidMesh(): void {
    const armorMat = new THREE.MeshStandardMaterial({ color: 0xb8322a, metalness: 0.35, roughness: 0.45 });
    const suitMat = new THREE.MeshStandardMaterial({ color: 0x1d2129, metalness: 0.2, roughness: 0.75 });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.8, roughness: 0.3 });
    // HDR colour so the visor and jump-kit nozzles pick up bloom
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3a1a).multiplyScalar(3) });

    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const add = (target: Map<THREE.Material, THREE.BufferGeometry[]>, mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      geo.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ));
      const list = target.get(mat) ?? [];
      list.push(geo);
      target.set(mat, list);
    };
    /** Capsule limb segment running from `a` to `b`. */
    const limb = (target: Map<THREE.Material, THREE.BufferGeometry[]>, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
      const dir = b.clone().sub(a);
      const length = dir.length();
      const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 3, 8);
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
      const mid = a.clone().add(b).multiplyScalar(0.5);
      geo.translate(mid.x, mid.y, mid.z);
      const list = target.get(mat) ?? [];
      list.push(geo);
      target.set(mat, list);
    };
    const flush = (target: Map<THREE.Material, THREE.BufferGeometry[]>, parent: THREE.Object3D) => {
      for (const [mat, geos] of target) {
        const merged = mergeAndDispose(geos);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = !(mat instanceof THREE.MeshBasicMaterial);
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      target.clear();
    };
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // --- Torso ---
    add(parts, suitMat, bevelBox(0.34, 0.17, 0.22), 0, 0.95, 0);                 // pelvis
    add(parts, suitMat, bevelBox(0.3, 0.2, 0.2), 0, 1.1, 0);                     // abdomen
    add(parts, armorMat, bevelBox(0.44, 0.34, 0.27, 0.05), 0, 1.33, 0);          // chest rig
    add(parts, armorMat, bevelBox(0.3, 0.2, 0.05, 0.02), 0, 1.3, 0.145, -0.08);  // chest plate
    add(parts, gunMat, bevelBox(0.36, 0.05, 0.24), 0, 1.03, 0);                  // belt
    for (const sx of [-1, 1]) add(parts, suitMat, bevelBox(0.08, 0.1, 0.06), sx * 0.12, 1.02, 0.13); // pouches
    add(parts, suitMat, new THREE.CylinderGeometry(0.055, 0.065, 0.1, 10), 0, 1.54, 0); // neck

    // --- Jump kit ---
    add(parts, gunMat, bevelBox(0.32, 0.38, 0.13, 0.03), 0, 1.3, -0.2);
    for (const sx of [-1, 1]) {
      add(parts, gunMat, new THREE.CylinderGeometry(0.045, 0.06, 0.16, 12), sx * 0.09, 1.08, -0.24);
      add(parts, glowMat, new THREE.CylinderGeometry(0.035, 0.035, 0.02, 12), sx * 0.09, 0.995, -0.24);
    }

    // --- Shoulders ---
    for (const sx of [-1, 1]) add(parts, armorMat, bevelBox(0.15, 0.1, 0.17, 0.04), sx * 0.27, 1.47, 0, 0, 0, sx * -0.25);

    // --- Arms, holding the rifle at the ready ---
    const rShoulder = v(0.25, 1.44, 0), rElbow = v(0.24, 1.2, 0.06), rHand = v(0.08, 1.13, 0.27);
    const lShoulder = v(-0.25, 1.44, 0), lElbow = v(-0.24, 1.22, 0.16), lHand = v(0.0, 1.17, 0.5);
    limb(parts, suitMat, rShoulder, rElbow, 0.055);
    limb(parts, armorMat, rElbow, rHand, 0.05);
    limb(parts, suitMat, lShoulder, lElbow, 0.055);
    limb(parts, armorMat, lElbow, lHand, 0.05);
    add(parts, suitMat, bevelBox(0.07, 0.08, 0.09), rHand.x, rHand.y, rHand.z);  // gloves
    add(parts, suitMat, bevelBox(0.07, 0.08, 0.09), lHand.x, lHand.y, lHand.z);

    // --- Rifle ---
    add(parts, gunMat, bevelBox(0.06, 0.1, 0.42, 0.015), 0.05, 1.18, 0.36);      // receiver
    add(parts, gunMat, new THREE.CylinderGeometry(0.014, 0.016, 0.28, 10), 0.05, 1.2, 0.7, Math.PI / 2); // barrel
    add(parts, gunMat, bevelBox(0.04, 0.13, 0.07, 0.01), 0.05, 1.08, 0.4, -0.25); // magazine
    add(parts, gunMat, bevelBox(0.045, 0.09, 0.18, 0.012), 0.05, 1.15, 0.08);    // stock
    add(parts, gunMat, bevelBox(0.04, 0.045, 0.1, 0.01), 0.05, 1.255, 0.36);     // optic
    add(parts, glowMat, bevelBox(0.062, 0.012, 0.16, 0.004), 0.05, 1.215, 0.42); // accent strip

    flush(parts, this.mesh);

    // --- Head (tracks the player) ---
    const head = new THREE.Group();
    head.position.set(0, 1.66, 0);
    const helmet = new THREE.SphereGeometry(0.13, 16, 12);
    helmet.scale(1, 1.05, 1.12);
    add(parts, armorMat, helmet, 0, 0, 0);
    add(parts, suitMat, bevelBox(0.2, 0.09, 0.12, 0.03), 0, -0.08, 0.05);          // jaw guard
    add(parts, glowMat, bevelBox(0.19, 0.045, 0.05, 0.015), 0, 0.01, 0.125);       // visor
    add(parts, gunMat, new THREE.CylinderGeometry(0.006, 0.006, 0.18, 6), 0.09, 0.13, -0.06, 0.2); // antenna
    flush(parts, head);
    this.mesh.add(head);
    this.headMesh = head;

    // --- Legs, pivoting at the hip ---
    const buildLeg = (side: number): THREE.Group => {
      const leg = new THREE.Group();
      leg.position.set(side * 0.11, 0.92, 0);
      limb(parts, suitMat, v(0, -0.02, 0), v(0, -0.44, 0.02), 0.075);             // thigh
      add(parts, armorMat, bevelBox(0.1, 0.12, 0.08, 0.025), 0, -0.44, 0.07);     // knee pad
      limb(parts, suitMat, v(0, -0.46, 0.02), v(0, -0.84, -0.01), 0.062);         // shin
      add(parts, armorMat, bevelBox(0.1, 0.22, 0.06, 0.02), 0, -0.64, 0.05);      // shin guard
      add(parts, gunMat, bevelBox(0.12, 0.09, 0.25, 0.03), 0, -0.875, 0.04);      // boot
      flush(parts, leg);
      this.mesh.add(leg);
      return leg;
    };
    this.leftLegMesh = buildLeg(-1);
    this.rightLegMesh = buildLeg(1);

    // Flash overlays on torso and head
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const torsoFlash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.66, 0.34), flashMat);
    torsoFlash.position.set(0, 1.22, -0.02);
    this.mesh.add(torsoFlash);
    this.flashMeshes.push(torsoFlash);

    const headFlash = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), flashMat.clone());
    head.add(headFlash);
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

  takeDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);

    // Flash white
    this.isFlashing = true;
    this.flashTimer = 0.1;
    for (const fm of this.flashMeshes) {
      (fm.material as THREE.MeshBasicMaterial).opacity = 0.5;
    }

    // Taking damage = instant aggro, skip reaction time
    this.reactionTimer = this.reactionTime;
    if (this.state === EnemyState.IDLE || this.state === EnemyState.PATROL) {
      this.state = EnemyState.CHASE;
      this.stateTimer = 0;
    }
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
    // Fire from the rifle's muzzle
    this.mesh.updateMatrixWorld();
    const eyePos = this.mesh.localToWorld(new THREE.Vector3(0.05, 1.2, 0.86));

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

  /**
   * Advance AI, movement and bullets by `delta` seconds.
   * Returns the positions of any enemy bullets that struck the player this frame.
   */
  update(delta: number, playerPos: THREE.Vector3, worldMeshes: THREE.Mesh[], playerHitbox: PlayerHitbox, playerVel?: THREE.Vector3): THREE.Vector3[] {
    this.worldMeshes = worldMeshes;
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
    const playerHits = this.updateBullets(delta, playerHitbox);

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

    return playerHits;
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
    this.tryMove(moveDir.x * this.FLANK_SPEED * delta, moveDir.z * this.FLANK_SPEED * delta);
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
    this.tryMove(moveDir.x * this.CHASE_SPEED * delta, moveDir.z * this.CHASE_SPEED * delta);
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
    if (!this.tryMove(toTarget.x * this.PATROL_SPEED * delta, toTarget.z * this.PATROL_SPEED * delta)) {
      // Waypoint is behind a wall — skip to the next one instead of walking into it forever
      this.patrolIndex = (this.patrolIndex + 1) % this.patrolWaypoints.length;
    }
  }

  private moveToward(target: THREE.Vector3, amount: number): void {
    const dir = target.clone().sub(this.mesh.position);
    dir.y = 0;
    if (dir.length() > 0.5) {
      dir.normalize();
      this.tryMove(dir.x * amount, dir.z * amount);
    }
  }

  private moveAwayFrom(target: THREE.Vector3, amount: number): void {
    const dir = this.mesh.position.clone().sub(target);
    dir.y = 0;
    if (dir.length() > 0.1) {
      dir.normalize();
      this.tryMove(dir.x * amount, dir.z * amount);
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
    if (!this.tryMove(right.x * this.STRAFE_SPEED * this.strafeDir * delta, right.z * this.STRAFE_SPEED * this.strafeDir * delta)) {
      this.strafeDir *= -1; // bumped into cover — strafe the other way
    }
  }

  /**
   * Move horizontally unless a wall is in the way (checked at knee and chest height).
   * Returns false if the move was blocked.
   */
  private tryMove(dx: number, dz: number): boolean {
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return true;
    const dir = new THREE.Vector3(dx / distance, 0, dz / distance);
    for (const height of [0.4, 1.2]) {
      const origin = this.mesh.position.clone();
      origin.y += height;
      this.moveRaycaster.set(origin, dir);
      this.moveRaycaster.far = distance + this.ENEMY_RADIUS;
      if (this.moveRaycaster.intersectObjects(this.worldMeshes, false).length > 0) return false;
    }
    this.mesh.position.x += dx;
    this.mesh.position.z += dz;
    return true;
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

  private updateBullets(delta: number, playerHitbox: PlayerHitbox): THREE.Vector3[] {
    const playerHits: THREE.Vector3[] = [];
    const raycaster = new THREE.Raycaster();
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prevPos = b.mesh.position.clone();
      this.ballisticsSystem.updateBullet(b, delta);

      // Clip this frame's travel against level geometry so bullets can't pass through walls
      let segmentEnd = b.mesh.position;
      let hitWall = false;
      const step = b.mesh.position.clone().sub(prevPos);
      const stepLen = step.length();
      if (stepLen > 1e-6) {
        raycaster.set(prevPos, step.divideScalar(stepLen));
        raycaster.far = stepLen;
        const wallHit = raycaster.intersectObjects(this.worldMeshes, false)[0];
        if (wallHit) {
          segmentEnd = wallHit.point;
          hitWall = true;
        }
      }

      const hitPlayer = segmentIntersectsSphere(prevPos, segmentEnd, playerHitbox.center, playerHitbox.radius);
      if (hitPlayer) playerHits.push(prevPos.clone());

      if (hitPlayer || hitWall || b.time > b.maxLifetime || b.mesh.position.y < -5) {
        this.ballisticsSystem.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }
    return playerHits;
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

  }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export interface MovementInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  /** Edge trigger: true only on the frame the jump key was pressed. */
  jumpJustPressed: boolean;
  sprint: boolean;
  crouch: boolean;
  /** Edge trigger: true only on the frame the crouch key was pressed. */
  crouchJustPressed: boolean;
  gamepadMove: THREE.Vector2;
  gamepadSprint: boolean;
  gamepadCrouch: boolean;
  /** Camera yaw (euler.y) used for wish-direction projection. */
  yaw: number;
}

/**
 * Self-contained Titanfall 2 movement system.
 *
 * Owns all movement state and physics constants. Call update() each frame
 * with current input, then applyToBody() to flush velocity into the cannon
 * body. After world.step(), sync the Three.js group from body.position
 * (done in Player.applyVelocity).
 *
 * States: GROUNDED | SLIDING | AIRBORNE | WALLRUN | MANTLE
 */
export class MovementSystem {
  // ---- public state (readable by Player for UI / sound triggers) ----
  vel = new THREE.Vector3();
  isGrounded = false;
  isWallRunning = false;
  isSliding = false;
  isMantling = false;
  jumpCount = 0;

  // ---- private state ----
  private slideTimer = 0;
  private wallNormal = new THREE.Vector3();
  private wallRunTimer = 0;
  private mantleTimer = 0;
  private mantleTarget = new THREE.Vector3();
  private wallJumpCooldown = 0;
  private wallRunExitGraceTimer = 0;
  private slideEndCooldown = 0;
  private needsCrouchRelease = false;
  private wasGrounded = false;
  private edgeBoostCooldown = 0;
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;

  // Snapshot of the current frame's input, set at the top of update().
  private input: MovementInput = {
    forward: false, backward: false, left: false, right: false,
    jumpJustPressed: false, sprint: false, crouch: false, crouchJustPressed: false,
    gamepadMove: new THREE.Vector2(), gamepadSprint: false, gamepadCrouch: false, yaw: 0,
  };

  // ---- tuning ----
  private readonly SLIDE_STOP_DELAY = 0.15;
  private readonly COYOTE_TIME = 0.12;
  private readonly JUMP_BUFFER_TIME = 0.12;
  private readonly GROUND_SPEED = 6;
  private readonly CROUCH_SPEED = 3;
  private readonly SPRINT_SPEED = 10;
  private readonly SLIDE_SPEED = 22;
  private readonly JUMP_FORCE = 11;
  private readonly DOUBLE_JUMP = 10;
  private readonly GRAVITY = -28;
  private readonly AIR_ACCEL = 60;
  private readonly AIR_SPEED_CAP = 6;
  private readonly WALL_RUN_SPEED = 16;
  private readonly WALL_RUN_MAX_TIME = 2.5;
  private readonly WALL_RUN_EXIT_GRACE = 0.12;
  private readonly WALL_JUMP_UP = 10;
  private readonly WALL_JUMP_OUT = 8;
  private readonly GROUND_ACCEL = 80;
  private readonly MANTLE_UP_SPEED = 12;
  private readonly MANTLE_FWD_SPEED = 6;
  private readonly MANTLE_DURATION = 0.25;
  private readonly MANTLE_BOOST = 8;
  private readonly MANTLE_MAX_HEIGHT = 2.5;
  private readonly MANTLE_MIN_HEIGHT = 0.3;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly body: CANNON.Body,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  update(dt: number, input: MovementInput): void {
    this.input = input;

    if (input.jumpJustPressed) {
      this.jumpBufferTimer = this.JUMP_BUFFER_TIME;
    }
    if (input.crouchJustPressed) {
      this.tryCrouch();
    }

    this.move(dt);
  }

  /** Write vel into cannon body and handle respawn. Call after world.step(). */
  applyToBody(): void {
    this.body.velocity.set(this.vel.x, this.vel.y, this.vel.z);

    if (this.body.position.y < -10) {
      this.body.position.set(0, 5, 0);
      this.vel.set(0, 0, 0);
      this.body.velocity.set(0, 0, 0);
    }
  }

  hSpeed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private wishDir(): THREE.Vector3 {
    const { forward, backward, left, right, gamepadMove, yaw } = this.input;
    const d = new THREE.Vector3();
    if (forward)  d.z -= 1;
    if (backward) d.z += 1;
    if (left)     d.x -= 1;
    if (right)    d.x += 1;
    if (gamepadMove.length() > 0.1) {
      d.x += gamepadMove.x;
      d.z += gamepadMove.y;
    }
    if (d.length() > 0) {
      d.normalize();
      d.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    }
    return d;
  }

  private isSprinting(): boolean {
    return this.input.sprint || this.input.gamepadSprint;
  }

  private isCrouching(): boolean {
    return this.input.crouch || this.input.gamepadCrouch;
  }

  /* ------------------------------------------------------------------ */
  /*  Raycasts                                                           */
  /* ------------------------------------------------------------------ */

  private getMeshes(): THREE.Mesh[] {
    return this.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  }

  private checkGrounded(): boolean {
    const from = new THREE.Vector3(
      this.body.position.x, this.body.position.y, this.body.position.z,
    );
    return new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0), 0, 0.55)
      .intersectObjects(this.getMeshes()).length > 0;
  }

  private checkGroundedWithSurface(): {
    grounded: boolean;
    normal: THREE.Vector3;
    material?: THREE.Material;
    steepness: number;
  } {
    const from = new THREE.Vector3(
      this.body.position.x, this.body.position.y, this.body.position.z,
    );
    const hits = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0), 0, 0.55)
      .intersectObjects(this.getMeshes());

    if (hits.length === 0) {
      return { grounded: false, normal: new THREE.Vector3(0, 1, 0), steepness: 0 };
    }

    const hit = hits[0];
    const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
    normal.transformDirection(hit.object.matrixWorld);
    const steepness = 1 - Math.abs(normal.dot(new THREE.Vector3(0, 1, 0)));
    const material = (hit.object as THREE.Mesh).material as THREE.Material;
    return { grounded: true, normal, material, steepness };
  }

  private checkWall(): { hit: boolean; normal: THREE.Vector3; side: number } {
    const from = new THREE.Vector3(
      this.body.position.x, this.body.position.y + 0.2, this.body.position.z,
    );
    const meshes = this.getMeshes();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const dirs = [
      new THREE.Vector3(1, 0, 0).applyAxisAngle(yAxis, this.input.yaw),
      new THREE.Vector3(-1, 0, 0).applyAxisAngle(yAxis, this.input.yaw),
    ];
    for (let i = 0; i < dirs.length; i++) {
      const hits = new THREE.Raycaster(from, dirs[i], 0, 1.0).intersectObjects(meshes);
      if (hits.length > 0 && hits[0].distance < 0.8) {
        const n = hits[0].face?.normal.clone() ?? new THREE.Vector3();
        n.transformDirection(hits[0].object.matrixWorld);
        return { hit: true, normal: n, side: i === 0 ? 1 : -1 };
      }
    }
    return { hit: false, normal: new THREE.Vector3(), side: 0 };
  }

  /**
   * Mantle check: cast forward at chest height. If blocked, cast down from
   * above to find the ledge top. Returns whether we can mantle and at what Y.
   */
  private checkMantle(): { can: boolean; ledgeY: number } {
    const meshes = this.getMeshes();
    const pos = new THREE.Vector3(
      this.body.position.x, this.body.position.y, this.body.position.z,
    );
    const fwd = new THREE.Vector3(0, 0, -1)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.input.yaw);
    fwd.y = 0;
    fwd.normalize();

    // 1. Forward at chest – is there a wall?
    const fwdHits = new THREE.Raycaster(
      pos.clone().add(new THREE.Vector3(0, 0.3, 0)), fwd, 0, 1.0,
    ).intersectObjects(meshes);
    if (fwdHits.length === 0) return { can: false, ledgeY: 0 };

    // 2. Forward at head – must be clear (wall too tall otherwise)
    const headHits = new THREE.Raycaster(
      pos.clone().add(new THREE.Vector3(0, this.MANTLE_MAX_HEIGHT, 0)), fwd, 0, 1.0,
    ).intersectObjects(meshes);
    if (headHits.length > 0 && headHits[0].distance < fwdHits[0].distance + 0.2) {
      return { can: false, ledgeY: 0 };
    }

    // 3. Down from above to find the ledge surface
    const aboveOrigin = pos.clone().add(fwd.clone().multiplyScalar(fwdHits[0].distance + 0.3));
    aboveOrigin.y = pos.y + this.MANTLE_MAX_HEIGHT + 0.5;
    const downHits = new THREE.Raycaster(
      aboveOrigin, new THREE.Vector3(0, -1, 0), 0, this.MANTLE_MAX_HEIGHT + 1,
    ).intersectObjects(meshes);
    if (downHits.length === 0) return { can: false, ledgeY: 0 };

    const ledgeY = downHits[0].point.y;
    const heightDiff = ledgeY - pos.y;
    if (heightDiff < this.MANTLE_MIN_HEIGHT || heightDiff > this.MANTLE_MAX_HEIGHT) {
      return { can: false, ledgeY: 0 };
    }

    return { can: true, ledgeY: ledgeY + 0.6 }; // +0.6 so player stands on top
  }

  /* ------------------------------------------------------------------ */
  /*  Slide                                                              */
  /* ------------------------------------------------------------------ */

  private tryCrouch(): void {
    if (this.isSliding) return;
    this.startSlide();
  }

  private startSlide(): void {
    if (this.isSliding || !this.isGrounded) return;

    const currentSpeed = this.hSpeed();
    const minSlideSpeed = 4;
    if (currentSpeed < minSlideSpeed && !this.isSprinting()) return;

    this.isSliding = true;
    this.slideTimer = 0;

    const entrySpeed = Math.max(currentSpeed, this.isSprinting() ? 14 : 8);
    const boostedSpeed = Math.min(entrySpeed * 1.1, this.SLIDE_SPEED);
    const dir = currentSpeed > 1
      ? new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize()
      : this.wishDir();

    if (dir.length() > 0) {
      this.vel.x = dir.x * boostedSpeed;
      this.vel.z = dir.z * boostedSpeed;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Jump                                                               */
  /* ------------------------------------------------------------------ */

  private tryJump(): void {
    // Slide hop – preserves momentum
    if (this.isSliding) {
      this.isSliding = false;
      this.vel.y = this.JUMP_FORCE;
      this.vel.x *= 0.85;
      this.vel.z *= 0.85;
      const wish = this.wishDir();
      if (wish.length() > 0.1) {
        this.vel.x += wish.x * 3;
        this.vel.z += wish.z * 3;
      }
      this.jumpCount = 1;
      this.jumpBufferTimer = 0;
      return;
    }

    // Wall jump with angle-based bounce
    if (this.isWallRunning) {
      const moveDir = new THREE.Vector3(this.vel.x, 0, this.vel.z);
      const currentSpeed = moveDir.length();
      if (currentSpeed > 0.1) {
        moveDir.normalize();
        const bounceMultiplier = 1 + Math.abs(moveDir.dot(this.wallNormal)) * 0.8;
        const finalDir = new THREE.Vector3()
          .addScaledVector(moveDir.clone().reflect(this.wallNormal).normalize(), 0.7)
          .addScaledVector(this.wallNormal, 0.3)
          .normalize();
        const jumpSpeed = this.WALL_JUMP_OUT * bounceMultiplier;
        this.vel.x = finalDir.x * jumpSpeed;
        this.vel.z = finalDir.z * jumpSpeed;
      } else {
        const n = this.wallNormal.clone();
        n.y = 0;
        n.normalize();
        this.vel.x = n.x * this.WALL_JUMP_OUT;
        this.vel.z = n.z * this.WALL_JUMP_OUT;
      }
      this.vel.y = this.WALL_JUMP_UP;
      this.isWallRunning = false;
      this.wallJumpCooldown = 0.2;
      this.jumpCount = 1;
      this.jumpBufferTimer = 0;
      return;
    }

    // Ground / coyote jump
    if (this.isGrounded || this.coyoteTimer > 0) {
      this.vel.y = this.JUMP_FORCE;
      this.isSliding = false;
      this.jumpCount = 1;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      return;
    }

    // Double jump (max 2 total)
    if (this.jumpCount === 1) {
      this.vel.y = this.DOUBLE_JUMP;
      this.jumpCount = 2;
      this.jumpBufferTimer = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Wall run exit                                                      */
  /* ------------------------------------------------------------------ */

  private exitWallRun(cooldown: number): void {
    // Preserve tangent velocity (strip component into/away from wall)
    const tangent = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    tangent.addScaledVector(this.wallNormal, -tangent.dot(this.wallNormal));

    if (tangent.lengthSq() > 1e-4) {
      const speed = Math.max(tangent.length(), this.WALL_RUN_SPEED * 0.75);
      tangent.normalize().multiplyScalar(speed);
      this.vel.x = tangent.x;
      this.vel.z = tangent.z;
    }

    this.isWallRunning = false;
    this.wallJumpCooldown = cooldown;
    this.wallRunExitGraceTimer = this.WALL_RUN_EXIT_GRACE;
  }

  /* ------------------------------------------------------------------ */
  /*  Main move – called AFTER world.step()                             */
  /* ------------------------------------------------------------------ */

  private move(dt: number): void {
    if (this.needsCrouchRelease && !this.isCrouching()) {
      this.needsCrouchRelease = false;
    }

    this.wasGrounded = this.isGrounded;
    this.isGrounded = this.checkGrounded();
    const justLanded = !this.wasGrounded && this.isGrounded;

    // Bunny hop: jump buffer consumed on landing frame
    if (justLanded && this.jumpBufferTimer > 0) {
      this.vel.y = this.JUMP_FORCE;
      this.isSliding = false;
      this.jumpBufferTimer = 0;
    }

    if (this.isGrounded) {
      this.coyoteTimer = this.COYOTE_TIME;
      if (justLanded) {
        this.jumpCount = 0;
        this.isWallRunning = false;
        if (this.isCrouching()) this.startSlide();
      }
    } else {
      this.coyoteTimer -= dt;
    }

    // Cooldown timers
    if (this.wallJumpCooldown > 0)      this.wallJumpCooldown -= dt;
    if (this.wallRunExitGraceTimer > 0) this.wallRunExitGraceTimer -= dt;
    if (this.slideEndCooldown > 0)      this.slideEndCooldown -= dt;
    if (this.edgeBoostCooldown > 0)     this.edgeBoostCooldown -= dt;

    // Wall run detection
    const wall = this.checkWall();
    if (!this.isGrounded && !this.isMantling && wall.hit &&
        this.hSpeed() > 3 && !this.isWallRunning && this.wallJumpCooldown <= 0) {
      this.isWallRunning = true;
      this.wallNormal = wall.normal;
      this.wallRunTimer = 0;
    }

    if (this.isWallRunning) {
      this.wallRunTimer += dt;
      if (!wall.hit) {
        this.exitWallRun(0.1);
      } else {
        this.wallNormal.copy(wall.normal);
      }
      if (this.isCrouching())                      this.exitWallRun(0.2);
      if (this.wallRunTimer > this.WALL_RUN_MAX_TIME) this.exitWallRun(0.3);
    }

    // Jump buffer consumption
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer -= dt;
      this.tryJump();
    }

    // Mantle detection (airborne, not already mantling/wallrunning)
    const canMantle = !this.isGrounded && !this.isMantling && !this.isWallRunning &&
                      this.wallJumpCooldown < 0.1 && this.vel.y <= 2;
    if (canMantle && this.wishDir().length() > 0.1) {
      const mantle = this.checkMantle();
      if (mantle.can) {
        this.isMantling = true;
        this.mantleTimer = this.MANTLE_DURATION;
        this.mantleTarget.set(this.body.position.x, mantle.ledgeY, this.body.position.z);
        const fwd = new THREE.Vector3(0, 0, -1)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.input.yaw);
        fwd.y = 0;
        fwd.normalize();
        this.mantleTarget.add(fwd.multiplyScalar(0.5));
      }
    }

    // ---- State-based velocity ----
    const wishMove = this.wishDir();

    if (this.isMantling) {
      // ---- MANTLE ----
      this.mantleTimer -= dt;
      const bodyPos = new THREE.Vector3(
        this.body.position.x, this.body.position.y, this.body.position.z,
      );
      const diff = this.mantleTarget.clone().sub(bodyPos);
      const upNeeded  = diff.y;
      const fwdNeeded = Math.sqrt(diff.x * diff.x + diff.z * diff.z);

      this.vel.y = Math.max(upNeeded / Math.max(this.mantleTimer, 0.05), this.MANTLE_UP_SPEED);
      if (fwdNeeded > 0.1) {
        const fwdDir = new THREE.Vector3(diff.x, 0, diff.z).normalize();
        this.vel.x = fwdDir.x * this.MANTLE_FWD_SPEED;
        this.vel.z = fwdDir.z * this.MANTLE_FWD_SPEED;
      }

      if (this.mantleTimer <= 0 || upNeeded < 0.1) {
        this.isMantling = false;
        const fwd = new THREE.Vector3(0, 0, -1)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.input.yaw);
        fwd.y = 0;
        fwd.normalize();
        this.vel.x = fwd.x * this.MANTLE_BOOST;
        this.vel.z = fwd.z * this.MANTLE_BOOST;
        this.vel.y = 1;
        this.jumpCount = 0;
      }

    } else if (this.isSliding) {
      // ---- SLIDE ----
      this.slideTimer += dt;

      if (!this.isCrouching()) {
        this.isSliding = false;
        this.vel.x *= 0.5;
        this.vel.z *= 0.5;
        this.slideEndCooldown = this.SLIDE_STOP_DELAY;
        return;
      }

      const surface = this.checkGroundedWithSurface();

      // Edge boost: sliding off a ledge
      const justLeftLedge = this.wasGrounded && !surface.grounded && this.vel.y <= 0.1;
      if (justLeftLedge && this.hSpeed() > 6) {
        const dir = new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize();
        this.vel.x += dir.x * 8;
        this.vel.z += dir.z * 8;
        this.vel.y = 3;
      }

      if (!surface.grounded) {
        this.vel.y += this.GRAVITY * dt;
      }

      // Material-based friction
      let frictionMult = 1.0;
      if (surface.grounded && surface.material) {
        const name = (surface.material as any).name ?? '';
        if (name.includes('floor') || name.includes('Floor'))       frictionMult = 0.7;
        else if (name.includes('wall') || name.includes('Wall'))    frictionMult = 1.5;
        else if (name.includes('ramp') || name.includes('Ramp'))    frictionMult = 0.5;
      }

      // Project velocity onto surface plane on slopes
      if (surface.grounded && surface.steepness > 0.05) {
        const v = new THREE.Vector3(this.vel.x, 0, this.vel.z);
        v.addScaledVector(surface.normal, -v.dot(surface.normal));
        this.vel.x = v.x;
        this.vel.z = v.z;
      }

      // Exponential friction decay
      const speed = this.hSpeed();
      const newSpeed = Math.max(speed * Math.pow(Math.pow(0.985, frictionMult), dt * 60), 1);
      if (speed > 0.1) {
        const ratio = newSpeed / speed;
        this.vel.x *= ratio;
        this.vel.z *= ratio;
      } else {
        this.isSliding = false;
      }

    } else if (this.isWallRunning) {
      // ---- WALL RUN ----
      let dir: THREE.Vector3;
      const wish = this.wishDir();
      if (wish.length() > 0) {
        dir = wish.clone();
      } else {
        dir = new THREE.Vector3(0, 0, -1)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.input.yaw);
        dir.y = 0;
        dir.normalize();
      }
      dir.addScaledVector(this.wallNormal, -dir.dot(this.wallNormal));
      if (dir.length() > 0.01) dir.normalize();

      this.vel.x = dir.x * this.WALL_RUN_SPEED;
      this.vel.z = dir.z * this.WALL_RUN_SPEED;
      // Small push into wall to maintain contact
      this.vel.x -= this.wallNormal.x * 3;
      this.vel.z -= this.wallNormal.z * 3;
      this.vel.y = 0;

    } else if (this.isGrounded) {
      // ---- GROUND ----
      if (this.vel.y > 0) {
        // Just jumped – preserve horizontal momentum
      } else if (this.slideEndCooldown > 0) {
        this.vel.x = 0;
        this.vel.z = 0;
      } else if (this.isCrouching()) {
        const target = this.CROUCH_SPEED;
        if (wishMove.length() > 0) {
          const proj = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(wishMove);
          const add  = target - proj;
          if (add > 0) {
            const accel = Math.min(this.GROUND_ACCEL * dt, add);
            this.vel.x += wishMove.x * accel;
            this.vel.z += wishMove.z * accel;
          }
          const hs = this.hSpeed();
          if (hs > target) { this.vel.x *= target / hs; this.vel.z *= target / hs; }
        }
      } else {
        const target = this.isSprinting() ? this.SPRINT_SPEED : this.GROUND_SPEED;
        if (wishMove.length() > 0) {
          const proj = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(wishMove);
          const add  = target - proj;
          if (add > 0) {
            const accel = Math.min(this.GROUND_ACCEL * dt, add);
            this.vel.x += wishMove.x * accel;
            this.vel.z += wishMove.z * accel;
          }
          const hs = this.hSpeed();
          if (hs > target) { this.vel.x *= target / hs; this.vel.z *= target / hs; }
        } else {
          this.vel.x = 0;
          this.vel.z = 0;
        }
      }
      if (this.vel.y < 0) this.vel.y = 0;

    } else {
      // ---- AIRBORNE ----
      // Edge boost when walking off a ledge at speed
      if (this.edgeBoostCooldown <= 0 && this.wasGrounded && this.vel.y <= 0.1 && this.hSpeed() > 8) {
        const dir = new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize();
        this.vel.x += dir.x * 8;
        this.vel.z += dir.z * 8;
        this.edgeBoostCooldown = 0.5;
      }

      if (this.wallRunExitGraceTimer <= 0 && wishMove.length() > 0) {
        // Quake-style air acceleration
        const proj = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(wishMove);
        const add  = this.AIR_SPEED_CAP - proj;
        if (add > 0) {
          const accel = Math.min(this.AIR_ACCEL * dt, add);
          this.vel.x += wishMove.x * accel;
          this.vel.z += wishMove.z * accel;
        }
      }
      this.vel.y += this.GRAVITY * dt;
    }
  }
}

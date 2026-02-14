import * as THREE from 'three';
import * as CANNON from 'cannon-es';

interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  fire: boolean;
}

/**
 * Titanfall 2 movement implementation.
 * 
 * cannon-es is used ONLY for collision resolution (keeping the player
 * out of walls/floor). We disable cannon's gravity on the player body
 * and set its velocity ourselves every frame *after* world.step() so
 * cannon never has the chance to dampen it.
 * 
 * Movement states:
 *   GROUNDED  – full control, sprint, can initiate slide
 *   SLIDING   – initial boost, slow friction decay, stays grounded
 *   AIRBORNE  – Quake-style air-strafe, gravity applied manually
 *   WALLRUN   – auto-detected, run forward along wall, slow fall
 */
export class Player {
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  group: THREE.Group;

  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private keys: KeyState = {
    forward: false, backward: false, left: false, right: false,
    jump: false, sprint: false, crouch: false, fire: false,
  };

  // --- movement velocity we control (not cannon) ---
  private vel = new THREE.Vector3();

  // --- state ---
  private isGrounded = false;
  private jumpCount = 0;
  private isWallRunning = false;
  private isSliding = false;
  private slideTimer = 0;
  private wallNormal = new THREE.Vector3();
  private wallRunTimer = 0;
  private isMantling = false;
  private mantleTimer = 0;
  private mantleTarget = new THREE.Vector3();

  private coyoteTime = 0.12;
  private coyoteTimer = 0;
  private jumpBufferTime = 0.12;
  private jumpBufferTimer = 0;

  // --- tuning ---
  private readonly GROUND_SPEED  = 12;
  private readonly SPRINT_SPEED  = 18;
  private readonly SLIDE_SPEED   = 22;
  private readonly SLIDE_DECAY   = 8;   // units/s speed loss
  private readonly SLIDE_DURATION = 1.2;
  private readonly JUMP_FORCE    = 11;
  private readonly DOUBLE_JUMP   = 10;
  private readonly GRAVITY       = -28;
  private readonly AIR_ACCEL     = 60;
  private readonly AIR_SPEED_CAP = 3;   // Quake-style wish-speed
  private readonly WALL_RUN_SPEED = 16;
  private readonly WALL_RUN_GRAVITY = -3;
  private readonly WALL_RUN_MAX_TIME = 1.5;
  private readonly WALL_JUMP_UP  = 10;
  private readonly WALL_JUMP_OUT = 8;
  private readonly GROUND_ACCEL  = 80;
  private readonly MANTLE_UP_SPEED = 12;
  private readonly MANTLE_FWD_SPEED = 6;
  private readonly MANTLE_DURATION = 0.25;
  private readonly MANTLE_BOOST = 8;   // extra forward kick after mantle
  private readonly MANTLE_MAX_HEIGHT = 2.5; // how high we can mantle
  private readonly MANTLE_MIN_HEIGHT = 0.3; // ignore tiny lips

  // --- gamepad ---
  private gamepadIndex: number | null = null;
  private gamepadMove = new THREE.Vector2();
  private gamepadLook = new THREE.Vector2();
  private gamepadJumpPrev = false;
  private gamepadCrouchPrev = false;
  private gamepadSprint = false;
  private gamepadCrouch = false;
  private gamepadFire = false;
  private gamepadADS = false;

  // --- combat ---
  private health = 100;
  private titanMeter = 0;
  private lastShotTime = 0;
  private bullets: { mesh: THREE.Mesh; velocity: THREE.Vector3; time: number }[] = [];

  // cannon body (collision only)
  body: CANNON.Body;

  constructor(camera: THREE.PerspectiveCamera, scene: THREE.Scene, world: CANNON.World) {
    this.camera = camera;
    this.scene = scene;
    this.group = new THREE.Group();

    // Capsule approximated as sphere – good enough for prototype
    const shape = new CANNON.Sphere(0.4);
    this.body = new CANNON.Body({
      mass: 1,
      shape,
      position: new CANNON.Vec3(0, 2, 0),
      fixedRotation: true,
      linearDamping: 0,
      angularDamping: 1,
    });
    // Disable cannon's gravity on this body – we apply our own
    this.body.type = CANNON.Body.DYNAMIC;
    world.addBody(this.body);

    this.setupControls();
    this.createWeapon();
  }

  /* ------------------------------------------------------------------ */
  /*  Input                                                              */
  /* ------------------------------------------------------------------ */

  private createWeapon() {
    const g = new THREE.BoxGeometry(0.08, 0.08, 0.35);
    const m = new THREE.MeshStandardMaterial({ color: 0x444444 });
    const gun = new THREE.Mesh(g, m);
    gun.position.set(0.2, -0.15, -0.3);
    this.group.add(gun);
  }

  private setupControls() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mousedown', (e) => { if (e.button === 0) this.keys.fire = true; });
    document.addEventListener('mouseup',   (e) => { if (e.button === 0) this.keys.fire = false; });
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  private onKeyDown(e: KeyboardEvent) {
    switch (e.code) {
      case 'KeyW': this.keys.forward = true; break;
      case 'KeyS': this.keys.backward = true; break;
      case 'KeyA': this.keys.left = true; break;
      case 'KeyD': this.keys.right = true; break;
      case 'Space':
        this.keys.jump = true;
        this.jumpBufferTimer = this.jumpBufferTime;
        break;
      case 'ShiftLeft': case 'ShiftRight':
        this.keys.sprint = true; break;
      case 'ControlLeft': case 'ControlRight':
        this.keys.crouch = true;
        this.tryCrouch();
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    switch (e.code) {
      case 'KeyW': this.keys.forward = false; break;
      case 'KeyS': this.keys.backward = false; break;
      case 'KeyA': this.keys.left = false; break;
      case 'KeyD': this.keys.right = false; break;
      case 'Space': this.keys.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': this.keys.sprint = false; break;
      case 'ControlLeft': case 'ControlRight': this.keys.crouch = false; break;
    }
  }

  private onMouseMove(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    this.euler.y -= e.movementX * 0.002;
    this.euler.x -= e.movementY * 0.0012;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
  }

  lockPointer() { document.body.requestPointerLock(); }

  private pollGamepad() {
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;

    const dz = 0.15;
    const ax = (i: number) => Math.abs(gp.axes[i]) > dz ? gp.axes[i] : 0;
    this.gamepadMove.set(ax(0), ax(1));   // left stick  = move
    this.gamepadLook.set(ax(2), ax(3));   // right stick = look

    // Ninja layout: LB=jump, RB=crouch, LT=ADS, RT=fire
    const lb = gp.buttons[4]?.pressed ?? false;
    const rb = gp.buttons[5]?.pressed ?? false;
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;

    if (lb && !this.gamepadJumpPrev) { this.jumpBufferTimer = this.jumpBufferTime; }
    this.gamepadJumpPrev = lb;

    if (rb && !this.gamepadCrouchPrev) { this.tryCrouch(); }
    this.gamepadCrouchPrev = rb;
    this.gamepadCrouch = rb;

    // Auto-sprint: full stick deflection
    this.gamepadSprint = this.gamepadMove.length() > 0.85;
    // RT = fire, LT = ADS
    this.gamepadFire = rt > 0.5;
    this.gamepadADS = lt > 0.3;

    if (this.gamepadLook.length() > dz) {
      this.euler.y -= this.gamepadLook.x * 0.04;
      this.euler.x -= this.gamepadLook.y * 0.025;
      this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private hSpeed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }

  private wishDir(): THREE.Vector3 {
    const d = new THREE.Vector3();
    if (this.keys.forward)  d.z -= 1;
    if (this.keys.backward) d.z += 1;
    if (this.keys.left)     d.x -= 1;
    if (this.keys.right)    d.x += 1;
    if (this.gamepadMove.length() > 0.1) {
      d.x += this.gamepadMove.x;
      d.z += this.gamepadMove.y;
    }
    if (d.length() > 0) {
      d.normalize();
      d.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.euler.y);
    }
    return d;
  }

  private isSprinting(): boolean {
    return this.keys.sprint || this.gamepadSprint;
  }

  private isCrouching(): boolean {
    return this.keys.crouch || this.gamepadCrouch;
  }

  /* ------------------------------------------------------------------ */
  /*  Raycasts (Three.js – independent of cannon)                       */
  /* ------------------------------------------------------------------ */

  private getMeshes(): THREE.Mesh[] {
    return this.scene.children.filter(o => o instanceof THREE.Mesh) as THREE.Mesh[];
  }

  private checkGrounded(): boolean {
    const from = new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z);
    const rc = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0), 0, 0.55);
    return rc.intersectObjects(this.getMeshes()).length > 0;
  }

  private checkWall(): { hit: boolean; normal: THREE.Vector3; side: number } {
    const from = new THREE.Vector3(this.body.position.x, this.body.position.y + 0.2, this.body.position.z);
    const meshes = this.getMeshes();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const dirs = [
      new THREE.Vector3( 1, 0, 0).applyAxisAngle(yAxis, this.euler.y),
      new THREE.Vector3(-1, 0, 0).applyAxisAngle(yAxis, this.euler.y),
    ];
    for (let i = 0; i < dirs.length; i++) {
      const rc = new THREE.Raycaster(from, dirs[i], 0, 1.0);
      const hits = rc.intersectObjects(meshes);
      if (hits.length > 0 && hits[0].distance < 0.8) {
        const n = hits[0].face?.normal.clone() ?? new THREE.Vector3();
        n.transformDirection(hits[0].object.matrixWorld);
        return { hit: true, normal: n, side: i === 0 ? 1 : -1 };
      }
    }
    return { hit: false, normal: new THREE.Vector3(), side: 0 };
  }

  /**
   * Mantle check: cast forward at chest height. If blocked, cast down
   * from above to find the ledge top. If the ledge is within mantle
   * range and there's open space above it, we can mantle.
   */
  private checkMantle(): { can: boolean; ledgeY: number } {
    const meshes = this.getMeshes();
    const pos = new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z);
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.euler.y);
    fwd.y = 0; fwd.normalize();

    // 1. Forward ray at chest height – is there a wall in front?
    const chestOrigin = pos.clone().add(new THREE.Vector3(0, 0.3, 0));
    const fwdRay = new THREE.Raycaster(chestOrigin, fwd, 0, 1.0);
    const fwdHits = fwdRay.intersectObjects(meshes);
    if (fwdHits.length === 0) return { can: false, ledgeY: 0 };

    // 2. Forward ray at head height – must be clear (otherwise wall is too tall)
    const headOrigin = pos.clone().add(new THREE.Vector3(0, this.MANTLE_MAX_HEIGHT, 0));
    const headRay = new THREE.Raycaster(headOrigin, fwd, 0, 1.0);
    const headHits = headRay.intersectObjects(meshes);
    if (headHits.length > 0 && headHits[0].distance < fwdHits[0].distance + 0.2) {
      return { can: false, ledgeY: 0 }; // wall extends above mantle height
    }

    // 3. Cast down from above the wall to find the ledge surface
    const aboveOrigin = pos.clone().add(fwd.clone().multiplyScalar(fwdHits[0].distance + 0.3));
    aboveOrigin.y = pos.y + this.MANTLE_MAX_HEIGHT + 0.5;
    const downRay = new THREE.Raycaster(aboveOrigin, new THREE.Vector3(0, -1, 0), 0, this.MANTLE_MAX_HEIGHT + 1);
    const downHits = downRay.intersectObjects(meshes);
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

  private tryCrouch() {
    if (this.isSliding) return;
    if (!this.isGrounded) {
      // Buffer crouch so slide triggers on landing
      this.wantSlide = true;
      return;
    }
    this.startSlide();
  }

  private wantSlide = false;

  private startSlide() {
    if (this.isSliding) return;
    // Need some speed to slide – either sprinting or already moving
    if (this.isSprinting() || this.hSpeed() > 6) {
      this.isSliding = true;
      this.wantSlide = false;
      this.slideTimer = this.SLIDE_DURATION;
      // Boost in current movement direction
      const speed = Math.max(this.hSpeed(), this.SLIDE_SPEED);
      const dir = this.hSpeed() > 1
        ? new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize()
        : this.wishDir();
      if (dir.length() > 0) {
        this.vel.x = dir.x * speed;
        this.vel.z = dir.z * speed;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Jump                                                               */
  /* ------------------------------------------------------------------ */

  private tryJump() {
    // Wall jump
    if (this.isWallRunning) {
      const n = this.wallNormal.clone();
      n.y = 0; n.normalize();
      this.vel.x = n.x * this.WALL_JUMP_OUT;
      this.vel.z = n.z * this.WALL_JUMP_OUT;
      this.vel.y = this.WALL_JUMP_UP;
      this.isWallRunning = false;
      this.jumpCount = 1;
      this.jumpBufferTimer = 0;
      return;
    }

    // Ground jump
    if (this.isGrounded || this.coyoteTimer > 0) {
      this.vel.y = this.JUMP_FORCE;
      this.isSliding = false;
      this.jumpCount = 1;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      return;
    }

    // Double jump
    if (this.jumpCount < 2) {
      this.vel.y = this.DOUBLE_JUMP;
      this.jumpCount = 2;
      this.jumpBufferTimer = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Main update – called AFTER world.step()                            */
  /* ------------------------------------------------------------------ */

  update(delta: number) {
    this.pollGamepad();
    this.move(delta);
    this.applyVelocity();
    this.handleShooting(delta);
    this.syncCamera();
    this.updateUI();
  }

  private move(dt: number) {
    const wasGrounded = this.isGrounded;
    this.isGrounded = this.checkGrounded();

    // Read back position cannon solved (collision pushed us out of walls)
    // but ignore cannon's velocity – we manage our own.

    // --- Grounded transitions ---
    if (this.isGrounded) {
      this.coyoteTimer = this.coyoteTime;
      if (!wasGrounded) {
        // just landed
        this.jumpCount = 0;
        this.isWallRunning = false;
        // Buffered slide: crouch was held during air, trigger slide on land
        if (this.wantSlide && this.isCrouching()) {
          this.startSlide();
        }
        this.wantSlide = false;
      }
    } else {
      this.coyoteTimer -= dt;
    }

    // --- Jump buffer ---
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer -= dt;
      this.tryJump();
    }

    // --- Mantle detection (airborne, moving forward, hitting a ledge) ---
    if (!this.isGrounded && !this.isMantling && !this.isWallRunning && this.vel.y <= 2) {
      const wish = this.wishDir();
      if (wish.length() > 0.1) {
        const mantle = this.checkMantle();
        if (mantle.can) {
          this.isMantling = true;
          this.mantleTimer = this.MANTLE_DURATION;
          this.mantleTarget.set(this.body.position.x, mantle.ledgeY, this.body.position.z);
          // Move target slightly forward onto the ledge
          const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.euler.y);
          fwd.y = 0; fwd.normalize();
          this.mantleTarget.add(fwd.multiplyScalar(0.5));
        }
      }
    }

    // --- Wall run detection ---
    const wall = this.checkWall();
    if (!this.isGrounded && !this.isMantling && wall.hit && this.hSpeed() > 5 && !this.isWallRunning) {
      this.isWallRunning = true;
      this.wallNormal = wall.normal;
      this.wallRunTimer = 0;
    }
    if (this.isWallRunning && (this.isGrounded || !wall.hit || this.wallRunTimer > this.WALL_RUN_MAX_TIME)) {
      this.isWallRunning = false;
    }

    // --- Build velocity based on state ---
    const wishMove = this.wishDir();

    if (this.isMantling) {
      // ---- MANTLE ----
      this.mantleTimer -= dt;
      // Lerp toward ledge top
      const diff = this.mantleTarget.clone().sub(
        new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z)
      );
      const upNeeded = diff.y;
      const fwdNeeded = Math.sqrt(diff.x * diff.x + diff.z * diff.z);

      this.vel.y = Math.max(upNeeded / Math.max(this.mantleTimer, 0.05), this.MANTLE_UP_SPEED);
      if (fwdNeeded > 0.1) {
        const fwdDir = new THREE.Vector3(diff.x, 0, diff.z).normalize();
        this.vel.x = fwdDir.x * this.MANTLE_FWD_SPEED;
        this.vel.z = fwdDir.z * this.MANTLE_FWD_SPEED;
      }

      if (this.mantleTimer <= 0 || upNeeded < 0.1) {
        // Mantle complete – apply boost
        this.isMantling = false;
        const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.euler.y);
        fwd.y = 0; fwd.normalize();
        this.vel.x = fwd.x * this.MANTLE_BOOST;
        this.vel.z = fwd.z * this.MANTLE_BOOST;
        this.vel.y = 1; // small upward pop
        this.jumpCount = 0; // reset jumps after mantle
      }

    } else if (this.isSliding) {
      // ---- SLIDE ----
      this.slideTimer -= dt;
      if (this.slideTimer <= 0 || !this.isCrouching()) {
        this.isSliding = false;
      }
      // Gentle speed decay
      const speed = this.hSpeed();
      const newSpeed = Math.max(speed - this.SLIDE_DECAY * dt, 0);
      if (speed > 0.1) {
        const ratio = newSpeed / speed;
        this.vel.x *= ratio;
        this.vel.z *= ratio;
      }
      // Keep grounded
      if (this.vel.y < 0) this.vel.y = 0;

    } else if (this.isWallRunning) {
      // ---- WALL RUN ----
      this.wallRunTimer += dt;
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.euler.y);
      fwd.y = 0; fwd.normalize();
      this.vel.x = fwd.x * this.WALL_RUN_SPEED;
      this.vel.z = fwd.z * this.WALL_RUN_SPEED;
      this.vel.y = this.WALL_RUN_GRAVITY * this.wallRunTimer; // gradual sag

    } else if (this.isGrounded) {
      // ---- GROUND ----
      const target = this.isSprinting() ? this.SPRINT_SPEED : this.GROUND_SPEED;
      if (wishMove.length() > 0) {
        // Accelerate toward wish direction
        const currentSpeed = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(wishMove);
        const addSpeed = target - currentSpeed;
        if (addSpeed > 0) {
          const accel = Math.min(this.GROUND_ACCEL * dt, addSpeed);
          this.vel.x += wishMove.x * accel;
          this.vel.z += wishMove.z * accel;
        }
        // Clamp to target
        const hs = this.hSpeed();
        if (hs > target) {
          const s = target / hs;
          this.vel.x *= s;
          this.vel.z *= s;
        }
      } else {
        // No input – stop immediately
        this.vel.x = 0;
        this.vel.z = 0;
      }
      // Clamp downward velocity on ground
      if (this.vel.y < 0) this.vel.y = 0;

    } else {
      // ---- AIRBORNE ----
      if (wishMove.length() > 0) {
        // Quake-style air acceleration
        const currentSpeed = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(wishMove);
        const addSpeed = this.AIR_SPEED_CAP - currentSpeed;
        if (addSpeed > 0) {
          const accel = Math.min(this.AIR_ACCEL * dt, addSpeed);
          this.vel.x += wishMove.x * accel;
          this.vel.z += wishMove.z * accel;
        }
      }
      this.vel.y += this.GRAVITY * dt;
    }
  }

  /** Write our velocity into cannon body so collision resolution uses it. */
  private applyVelocity() {
    this.body.velocity.set(this.vel.x, this.vel.y, this.vel.z);
    // Sync Three.js group from cannon position
    this.group.position.set(this.body.position.x, this.body.position.y, this.body.position.z);

    // Respawn if fallen
    if (this.body.position.y < -10) {
      this.body.position.set(0, 5, 0);
      this.vel.set(0, 0, 0);
      this.body.velocity.set(0, 0, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Shooting                                                           */
  /* ------------------------------------------------------------------ */

  private handleShooting(delta: number) {
    if (this.keys.fire || this.gamepadFire) {
      const now = performance.now();
      if (now - this.lastShotTime > 100) {
        this.shoot();
        this.lastShotTime = now;
      }
    }
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.time += delta;
      b.mesh.position.add(b.velocity.clone().multiplyScalar(delta));
      if (b.time > 3) { this.scene.remove(b.mesh); this.bullets.splice(i, 1); }
    }
  }

  private shoot() {
    const geo = new THREE.SphereGeometry(0.04, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc });
    const bullet = new THREE.Mesh(geo, mat);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    bullet.position.copy(this.group.position).add(fwd.clone().multiplyScalar(0.5));
    this.scene.add(bullet);
    this.bullets.push({ mesh: bullet, velocity: fwd.multiplyScalar(80), time: 0 });
    this.titanMeter = Math.min(100, this.titanMeter + 0.5);
  }

  /* ------------------------------------------------------------------ */
  /*  Camera & UI                                                        */
  /* ------------------------------------------------------------------ */

  private baseFOV = 75;
  private adsFOV = 45;
  private currentFOV = 75;

  private syncCamera() {
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.position.copy(this.group.position);
    this.camera.position.y += 0.5;

    // ADS zoom
    const targetFOV = this.gamepadADS ? this.adsFOV : this.baseFOV;
    this.currentFOV += (targetFOV - this.currentFOV) * 0.15;
    this.camera.fov = this.currentFOV;
    this.camera.updateProjectionMatrix();
  }

  private updateUI() {
    const hb = document.getElementById('health-bar') as HTMLElement;
    const tb = document.getElementById('titan-bar') as HTMLElement;
    if (hb) hb.style.width = `${this.health}%`;
    if (tb) tb.style.width = `${this.titanMeter}%`;

    let el = document.getElementById('debug-speed');
    if (!el) {
      el = document.createElement('div');
      el.id = 'debug-speed';
      el.style.cssText = 'position:fixed;top:20px;left:20px;color:#0f0;font:14px monospace;z-index:100;background:rgba(0,0,0,0.7);padding:8px;line-height:1.5;';
      document.body.appendChild(el);
    }
    const hs = this.hSpeed();
    const state = this.isMantling ? 'MANTLE' : this.isSliding ? 'SLIDE' : this.isWallRunning ? 'WALLRUN' : this.isGrounded ? 'GROUND' : 'AIR';
    el.innerHTML =
      `Speed: ${hs.toFixed(1)}<br>` +
      `State: ${state}<br>` +
      `Vel: ${this.vel.x.toFixed(1)}, ${this.vel.y.toFixed(1)}, ${this.vel.z.toFixed(1)}<br>` +
      `Jumps: ${this.jumpCount}<br>` +
      `Sprint: ${this.isSprinting()} Crouch: ${this.isCrouching()}`;
  }
}

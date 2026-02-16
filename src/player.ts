import * as THREE from "three";
import * as CANNON from "cannon-es";
import { getBindings } from "./keybindings";

interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  fire: boolean;
  embark: boolean;
}

interface BulletImpactParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface BulletImpactFlash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
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

  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private keys: KeyState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    fire: false,
    embark: false,
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
  private wallJumpCooldown = 0;
  private wallRunExitGraceTimer = 0;
  private slideEndCooldown = 0;
  private readonly SLIDE_STOP_DELAY = 0.15;
  private needsCrouchRelease = false;
  private wasGrounded = false;
  private edgeBoostCooldown = 0;

  private wasJumping = false;
  private wasSliding = false;
  private wasWallRunning = false;
  private wasMantling = false;

  private coyoteTime = 0.12;
  private coyoteTimer = 0;
  private jumpBufferTime = 0.12;
  private jumpBufferTimer = 0;

  // --- tuning ---
  private readonly GROUND_SPEED = 6;
  private readonly CROUCH_SPEED = 3;
  private readonly SPRINT_SPEED = 10;
  private readonly SLIDE_SPEED = 22; // Max slide speed cap
  private readonly JUMP_FORCE = 11;
  private readonly DOUBLE_JUMP = 10;
  private readonly GRAVITY = -28;
  private readonly AIR_ACCEL = 60;
  private readonly AIR_SPEED_CAP = 6; // Quake-style wish-speed - increased for slide hop chains
  private readonly WALL_RUN_SPEED = 16;
  private readonly WALL_RUN_MAX_TIME = 2.5;
  private readonly WALL_RUN_EXIT_GRACE = 0.12;
  private readonly WALL_JUMP_UP = 10;
  private readonly WALL_JUMP_OUT = 8;
  private readonly GROUND_ACCEL = 80;
  private readonly MANTLE_UP_SPEED = 12;
  private readonly MANTLE_FWD_SPEED = 6;
  private readonly MANTLE_DURATION = 0.25;
  private readonly MANTLE_BOOST = 8; // extra forward kick after mantle
  private readonly MANTLE_MAX_HEIGHT = 2.5; // how high we can mantle
  private readonly MANTLE_MIN_HEIGHT = 0.3; // ignore tiny lips

  // --- gamepad ---
  private gamepadIndex: number | null = null;
  private gamepadMove = new THREE.Vector2();
  private gamepadLook = new THREE.Vector2();
  private titanMouseLook = new THREE.Vector2();
  private gamepadJumpPrev = false;
  private gamepadCrouchPrev = false;
  private gamepadSprint = false;
  private gamepadCrouch = false;
  private gamepadFire = false;
  private gamepadADS = false;
  private gamepadTitanDash = false;

  // --- combat ---
  health = 100;
  titanMeter = 0;
  private lastShotTime = 0;
  private bullets: {
    mesh: THREE.Mesh;
    trail: THREE.Line;
    trailPositions: THREE.Vector3[];
    maxTrailLength: number;
    velocity: THREE.Vector3;
    time: number;
  }[] = [];
  private impactParticles: BulletImpactParticle[] = [];
  private impactFlashes: BulletImpactFlash[] = [];
  private readonly BULLET_GRAVITY = -35;

  // cannon body (collision only)
  body: CANNON.Body;

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    world: CANNON.World,
  ) {
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
    document.addEventListener("keydown", (e) => this.onKeyDown(e));
    document.addEventListener("keyup", (e) => this.onKeyUp(e));
    document.addEventListener("mousemove", (e) => this.onMouseMove(e));
    document.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.keys.fire = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.keys.fire = false;
    });
    window.addEventListener("gamepadconnected", (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.gamepadIndex = null;
    });

    // Check for already connected gamepads
    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        this.gamepadIndex = i;
        break;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    const b = getBindings();
    if (e.code === b.forward)        { this.keys.forward = true; }
    else if (e.code === b.backward)  { this.keys.backward = true; }
    else if (e.code === b.left)      { this.keys.left = true; }
    else if (e.code === b.right)     { this.keys.right = true; }
    else if (e.code === b.jump)      { this.keys.jump = true; this.jumpBufferTimer = this.jumpBufferTime; }
    else if (e.code === b.sprint)    { this.keys.sprint = true; }
    else if (e.code === b.crouch)    { this.keys.crouch = true; this.tryCrouch(); }
    else if (e.code === b.embark)    { 
      this.keys.embark = true;
      // Start tracking hold time
      this.keyboardEmbarkStartTime = performance.now();
      this.hasTriggeredEmbark = false;
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    const b = getBindings();
    if (e.code === b.forward)        { this.keys.forward = false; }
    else if (e.code === b.backward)  { this.keys.backward = false; }
    else if (e.code === b.left)      { this.keys.left = false; }
    else if (e.code === b.right)     { this.keys.right = false; }
    else if (e.code === b.jump)      { this.keys.jump = false; }
    else if (e.code === b.sprint)    { this.keys.sprint = false; }
    else if (e.code === b.crouch)    { this.keys.crouch = false; }
    else if (e.code === b.embark)    { 
      this.keys.embark = false;
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      
      // Short press = embark (if not already triggered and hold was short)
      if (!this.hasTriggeredEmbark && holdDuration < this.DISENGAGE_HOLD_TIME && this.onEmbarkTitan) {
        this.lastEmbarkTime = performance.now();
        this.onEmbarkTitan();
      }
    }
  }

  // --- look sensitivity ---
  private readonly LOOK_SENS_X = 0.002;
  private readonly LOOK_SENS_Y = 0.0012;
  private readonly ADS_SENS_MULT = 0.4; // 40% speed when ADS
  private readonly TITAN_LOOK_X_FROM_MOUSE = this.LOOK_SENS_X / 0.03;
  private readonly TITAN_LOOK_Y_FROM_MOUSE = this.LOOK_SENS_Y / 0.02;

  private onMouseMove(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    const sensMult = this.gamepadADS ? this.ADS_SENS_MULT : 1.0;
    if (this.isPilotingTitan) {
      // Titan look expects normalized stick-like deltas; convert mouse motion accordingly.
      this.titanMouseLook.x += e.movementX * this.TITAN_LOOK_X_FROM_MOUSE * sensMult;
      this.titanMouseLook.y += e.movementY * this.TITAN_LOOK_Y_FROM_MOUSE * sensMult;
    }
    this.euler.y -= e.movementX * this.LOOK_SENS_X * sensMult;
    this.euler.x -= e.movementY * this.LOOK_SENS_Y * sensMult;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
  }

  lockPointer() {
    document.body.requestPointerLock();
  }

  private onTitanMeterChange?: (meter: number) => void;
  private onCallTitan?: () => void;
  private onEmbarkTitan?: () => void;
  private onDisembarkTitan?: () => void;
  private onPause?: () => void;
  private onTitanControl?: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean) => void;
  private isPilotingTitan = false;
  private gamepadButtonXHoldTime = 0;
  private gamepadButtonXPrev = false;
  private gamepadMenuPrev = false;
  private keyboardEmbarkStartTime = 0;
  private hasTriggeredEmbark = false;
  private readonly DISENGAGE_HOLD_TIME = 1.0; // seconds
  private readonly EMBARK_COOLDOWN = 2.0; // seconds - prevent immediate disembark after embark
  private lastEmbarkTime = 0;
  private isDisembarking = false;
  private gamepadDpadDownPrev = false;

  setTitanMeterCallback(callback: (meter: number) => void): void {
    this.onTitanMeterChange = callback;
  }

  setCallTitanCallback(callback: () => void): void {
    this.onCallTitan = callback;
  }

  setEmbarkTitanCallback(callback: () => void): void {
    this.onEmbarkTitan = callback;
  }

  setDisembarkTitanCallback(callback: () => void): void {
    this.onDisembarkTitan = callback;
  }

  setPauseCallback(callback: () => void): void {
    this.onPause = callback;
  }

  setTitanControlCallback(callback: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean) => void): void {
    this.onTitanControl = callback;
  }

  setPilotingState(piloting: boolean): void {
    this.isPilotingTitan = piloting;
    if (!piloting) {
      this.titanMouseLook.set(0, 0);
    }
  }

  // Call this when piloting to pass controls to titan
  private updateTitanControls(): void {
    if (!this.onTitanControl || !this.isPilotingTitan) return;
    
    // Use local input axes for Titan controls (not world-rotated player wish dir).
    // This avoids inverted/rotated movement when player yaw diverges from Titan yaw.
    let localX = 0;
    let localZ = 0;
    if (this.keys.forward) localZ -= 1;
    if (this.keys.backward) localZ += 1;
    if (this.keys.left) localX -= 1;
    if (this.keys.right) localX += 1;
    if (this.gamepadMove.length() > 0.1) {
      localX += this.gamepadMove.x;
      localZ += this.gamepadMove.y;
    }
    const mag = Math.hypot(localX, localZ);
    if (mag > 1) {
      localX /= mag;
      localZ /= mag;
    }
    const forward = -localZ; // positive forward for Titan API
    const right = localX;
    
    // Get look input from mouse/gamepad
    const lookX = (this.gamepadLook.x || 0) + this.titanMouseLook.x;
    const lookY = (this.gamepadLook.y || 0) + this.titanMouseLook.y;
    this.titanMouseLook.set(0, 0);
    
    // Fire with RT or mouse
    const fire = this.keys.fire || this.gamepadFire;
    const dash = this.keys.sprint || this.gamepadTitanDash;

    this.onTitanControl(forward, right, lookX, lookY, fire, dash);
  }

  syncToTitan(position: THREE.Vector3, yaw: number): void {
    this.body.position.set(position.x, position.y + 1, position.z);
    this.body.velocity.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.group.position.set(position.x, position.y + 1, position.z);
    this.euler.y = yaw;
  }

  resetTitanMeter(): void {
    this.titanMeter = 0;
    if (this.onTitanMeterChange) {
      this.onTitanMeterChange(0);
    }
  }

  setVelocity(x: number, y: number, z: number): void {
    this.vel.set(x, y, z);
  }

  private pollGamepad() {
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;

    const dz = 0.15;
    // Reduced sensitivity for movement stick (left stick)
    const moveSens = 0.6;
    const lookSens = 1.0;
    const ax = (i: number, sens: number) => {
      const v = gp.axes[i];
      return Math.abs(v) > dz ? v * sens : 0;
    };
    this.gamepadMove.set(ax(0, moveSens), ax(1, moveSens)); // left stick  = move
    this.gamepadLook.set(ax(2, lookSens), ax(3, lookSens)); // right stick = look

    // Ninja layout: LB=jump, RB=crouch, LT=ADS, RT=fire
    const lb = gp.buttons[4]?.pressed ?? false;
    const rb = gp.buttons[5]?.pressed ?? false;
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;
    // Ninja layout: Button 2 (X) = embark Titan, D-pad down = call Titan, Menu = pause
    const buttonX = gp.buttons[2]?.pressed ?? false;
    const dpadDown = gp.buttons[13]?.pressed ?? false;
    const menuBtn = gp.buttons[8]?.pressed ?? false; // Back/Select button
    const buttonA = gp.buttons[0]?.pressed ?? false; // A / Cross (Titan dash)
    
    // Debug: Log button X state changes
    if (buttonX !== this.gamepadButtonXPrev) {
      console.log('Button X state changed:', buttonX, 'Buttons available:', gp.buttons.length);
    }

    if (lb && !this.gamepadJumpPrev) {
      this.jumpBufferTimer = this.jumpBufferTime;
    }
    this.gamepadJumpPrev = lb;

    if (rb && !this.gamepadCrouchPrev) {
      this.tryCrouch();
    }
    this.gamepadCrouchPrev = rb;
    this.gamepadCrouch = rb;

    // Button X: Short press = embark, Hold = disembark
    if (buttonX) {
      // Only increment hold time if we haven't triggered disembark yet
      if (!this.isDisembarking) {
        this.gamepadButtonXHoldTime += 0.016; // Approximate delta for 60fps
        
        // Check for long hold to disembark (but not within cooldown period after embark)
        const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
        if (this.gamepadButtonXHoldTime >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) {
          if (timeSinceEmbark < this.EMBARK_COOLDOWN) {
            console.log('Controller: Disembark blocked - in embark cooldown (' + timeSinceEmbark.toFixed(2) + 's / ' + this.EMBARK_COOLDOWN + 's)');
          } else {
            this.isDisembarking = true;
            console.log('Controller: Disembark triggered');
            this.onDisembarkTitan();
          }
        }
      }
    } else {
      // Button released
      if (this.gamepadButtonXHoldTime > 0 && this.gamepadButtonXHoldTime < this.DISENGAGE_HOLD_TIME && this.onEmbarkTitan) {
        // Short press - embark
        console.log('Controller: Embark triggered, hold time:', this.gamepadButtonXHoldTime);
        this.lastEmbarkTime = performance.now();
        this.onEmbarkTitan();
      } else if (this.gamepadButtonXHoldTime >= this.DISENGAGE_HOLD_TIME) {
        console.log('Controller: Button released after long hold, no action');
      }
      this.gamepadButtonXHoldTime = 0;
      this.isDisembarking = false;
    }
    this.gamepadButtonXPrev = buttonX;

    // D-pad down to call Titan
    if (dpadDown && !this.gamepadDpadDownPrev && this.onCallTitan) {
      this.onCallTitan();
    }
    this.gamepadDpadDownPrev = dpadDown;

    // Menu button to pause
    if (menuBtn && !this.gamepadMenuPrev && this.onPause) {
      console.log('Controller: Pause button pressed');
      this.onPause();
    }
    this.gamepadMenuPrev = menuBtn;
    this.gamepadTitanDash = buttonA;

    // Auto-sprint: full stick deflection (check raw axes before sensitivity scaling)
    const rawX = gp.axes[0] ?? 0;
    const rawY = gp.axes[1] ?? 0;
    this.gamepadSprint = Math.sqrt(rawX * rawX + rawY * rawY) > 0.9;
    // RT = fire, LT = ADS
    this.gamepadFire = rt > 0.5;
    this.gamepadADS = lt > 0.3;

    if (this.gamepadLook.length() > dz) {
      const adsMult = this.gamepadADS ? this.ADS_SENS_MULT : 1.0;
      this.euler.y -= this.gamepadLook.x * 0.04 * adsMult;
      this.euler.x -= this.gamepadLook.y * 0.025 * adsMult;
      this.euler.x = Math.max(
        -Math.PI / 2,
        Math.min(Math.PI / 2, this.euler.x),
      );
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
    if (this.keys.forward) d.z -= 1;
    if (this.keys.backward) d.z += 1;
    if (this.keys.left) d.x -= 1;
    if (this.keys.right) d.x += 1;
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
    return this.scene.children.filter(
      (o) => o instanceof THREE.Mesh,
    ) as THREE.Mesh[];
  }

  private isPlayerPart(obj: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (current === this.group) return true;
      current = current.parent;
    }
    return false;
  }

  private getBulletCollisionMeshes(): THREE.Mesh[] {
    return this.scene.children.filter((o) => {
      if (!(o instanceof THREE.Mesh)) return false;
      if (this.isPlayerPart(o)) return false;
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

  private createBulletImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    const n = normal.lengthSq() > 1e-6 ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);

    const flashGeo = new THREE.RingGeometry(0.04, 0.16, 16);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0x66ddff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(point).add(n.clone().multiplyScalar(0.02));
    flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.scene.add(flash);
    this.impactFlashes.push({ mesh: flash, life: 0.1, maxLife: 0.1 });

    const sparkCount = 8 + Math.floor(Math.random() * 5);
    for (let i = 0; i < sparkCount; i++) {
      const size = 0.012 + Math.random() * 0.018;
      const sparkGeo = new THREE.SphereGeometry(size, 4, 4);
      const sparkMat = new THREE.MeshBasicMaterial({
        color: 0x88eeff,
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
      const speed = 5 + Math.random() * 10;

      this.scene.add(spark);
      this.impactParticles.push({
        mesh: spark,
        velocity: dir.multiplyScalar(speed),
        life: 0.15 + Math.random() * 0.2,
        maxLife: 0.35,
      });
    }
  }

  private updateBulletImpactEffects(delta: number): void {
    for (let i = this.impactParticles.length - 1; i >= 0; i--) {
      const p = this.impactParticles[i];
      p.life -= delta;
      p.velocity.y -= 16 * delta;
      p.mesh.position.add(p.velocity.clone().multiplyScalar(delta));
      p.mesh.scale.multiplyScalar(0.98);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(
        0,
        p.life / p.maxLife,
      );

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
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(
        0,
        f.life / f.maxLife,
      );

      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        (f.mesh.material as THREE.Material).dispose();
        this.impactFlashes.splice(i, 1);
      }
    }
  }

  private checkGrounded(): boolean {
    const from = new THREE.Vector3(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z,
    );
    const rc = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0), 0, 0.55);
    return rc.intersectObjects(this.getMeshes()).length > 0;
  }

  /**
   * Check grounded with surface info - returns surface normal and material for slide physics
   */
  private checkGroundedWithSurface(): { 
    grounded: boolean; 
    normal: THREE.Vector3; 
    material?: THREE.Material;
    steepness: number;
  } {
    const from = new THREE.Vector3(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z,
    );
    const rc = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0), 0, 0.55);
    const hits = rc.intersectObjects(this.getMeshes());
    
    if (hits.length === 0) {
      return { grounded: false, normal: new THREE.Vector3(0, 1, 0), steepness: 0 };
    }
    
    const hit = hits[0];
    const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
    normal.transformDirection(hit.object.matrixWorld);
    
    // Steepness = 0 for flat (normal pointing up), approaches 1 as it gets steeper
    const steepness = 1 - Math.abs(normal.dot(new THREE.Vector3(0, 1, 0)));
    
    const material = (hit.object as THREE.Mesh).material as THREE.Material;
    
    return { grounded: true, normal, material, steepness };
  }

  private checkWall(): { hit: boolean; normal: THREE.Vector3; side: number } {
    const from = new THREE.Vector3(
      this.body.position.x,
      this.body.position.y + 0.2,
      this.body.position.z,
    );
    const meshes = this.getMeshes();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const dirs = [
      new THREE.Vector3(1, 0, 0).applyAxisAngle(yAxis, this.euler.y),
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
    const pos = new THREE.Vector3(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z,
    );
    const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.euler.y,
    );
    fwd.y = 0;
    fwd.normalize();

    // 1. Forward ray at chest height – is there a wall in front?
    const chestOrigin = pos.clone().add(new THREE.Vector3(0, 0.3, 0));
    const fwdRay = new THREE.Raycaster(chestOrigin, fwd, 0, 1.0);
    const fwdHits = fwdRay.intersectObjects(meshes);
    if (fwdHits.length === 0) return { can: false, ledgeY: 0 };

    // 2. Forward ray at head height – must be clear (otherwise wall is too tall)
    const headOrigin = pos
      .clone()
      .add(new THREE.Vector3(0, this.MANTLE_MAX_HEIGHT, 0));
    const headRay = new THREE.Raycaster(headOrigin, fwd, 0, 1.0);
    const headHits = headRay.intersectObjects(meshes);
    if (
      headHits.length > 0 &&
      headHits[0].distance < fwdHits[0].distance + 0.2
    ) {
      return { can: false, ledgeY: 0 }; // wall extends above mantle height
    }

    // 3. Cast down from above the wall to find the ledge surface
    const aboveOrigin = pos
      .clone()
      .add(fwd.clone().multiplyScalar(fwdHits[0].distance + 0.3));
    aboveOrigin.y = pos.y + this.MANTLE_MAX_HEIGHT + 0.5;
    const downRay = new THREE.Raycaster(
      aboveOrigin,
      new THREE.Vector3(0, -1, 0),
      0,
      this.MANTLE_MAX_HEIGHT + 1,
    );
    const downHits = downRay.intersectObjects(meshes);
    if (downHits.length === 0) return { can: false, ledgeY: 0 };

    const ledgeY = downHits[0].point.y;
    const heightDiff = ledgeY - pos.y;

    if (
      heightDiff < this.MANTLE_MIN_HEIGHT ||
      heightDiff > this.MANTLE_MAX_HEIGHT
    ) {
      return { can: false, ledgeY: 0 };
    }

    return { can: true, ledgeY: ledgeY + 0.6 }; // +0.6 so player stands on top
  }

  /* ------------------------------------------------------------------ */
  /*  Slide                                                              */
  /* ------------------------------------------------------------------ */

  private tryCrouch() {
    if (this.isSliding) return;
    // Can slide anytime while grounded with sufficient speed
    this.startSlide();
  }

  private startSlide() {
    if (this.isSliding) return;
    
    // Can slide while grounded
    if (!this.isGrounded) return;
    
    // Minimum speed to slide
    const minSlideSpeed = 4;
    const currentSpeed = this.hSpeed();
    
    // Allow slide at any angle as long as grounded and moving fast enough
    if (currentSpeed < minSlideSpeed && !this.isSprinting()) return;
    
    this.isSliding = true;
    this.slideTimer = 0; // Track elapsed time, not duration limit
    
    // Use entry velocity with small boost, capped at max slide speed
    const entrySpeed = Math.max(currentSpeed, this.isSprinting() ? 14 : 8);
    const boostedSpeed = Math.min(entrySpeed * 1.1, this.SLIDE_SPEED);
    
    // Set velocity in current movement direction
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

  private tryJump() {
    // Slide hop - jump while sliding preserves momentum
    if (this.isSliding) {
      this.isSliding = false;
      this.vel.y = this.JUMP_FORCE;
      
      // Preserve 85% of slide momentum + small directional boost
      const preserveRatio = 0.85;
      this.vel.x *= preserveRatio;
      this.vel.z *= preserveRatio;
      
      // Add wish direction boost if input present
      const wish = this.wishDir();
      if (wish.length() > 0.1) {
        const boost = 3;
        this.vel.x += wish.x * boost;
        this.vel.z += wish.z * boost;
      }
      
      this.jumpCount = 1;
      this.jumpBufferTimer = 0;
      return;
    }

    // Wall jump with bouncing
    if (this.isWallRunning) {
      // Calculate approach angle to wall for bounce intensity
      const moveDir = new THREE.Vector3(this.vel.x, 0, this.vel.z);
      const currentSpeed = moveDir.length();
      
      if (currentSpeed > 0.1) {
        moveDir.normalize();
        // Dot product shows how perpendicular we are to wall
        const wallDot = Math.abs(moveDir.dot(this.wallNormal));
        
        // More perpendicular approach = bigger bounce multiplier
        const bounceMultiplier = 1 + wallDot * 0.8;
        
        // Reflect velocity based on approach angle
        const reflectDir = moveDir.clone().reflect(this.wallNormal).normalize();
        
        // Blend between reflection and wall normal for control
        const finalDir = new THREE.Vector3()
          .addScaledVector(reflectDir, 0.7)
          .addScaledVector(this.wallNormal, 0.3)
          .normalize();
          
        const jumpSpeed = this.WALL_JUMP_OUT * bounceMultiplier;
        this.vel.x = finalDir.x * jumpSpeed;
        this.vel.z = finalDir.z * jumpSpeed;
      } else {
        // Fallback: use wall normal if barely moving
        const n = this.wallNormal.clone();
        n.y = 0;
        n.normalize();
        this.vel.x = n.x * this.WALL_JUMP_OUT;
        this.vel.z = n.z * this.WALL_JUMP_OUT;
      }

      this.vel.y = this.WALL_JUMP_UP;
      this.isWallRunning = false;
      this.wallJumpCooldown = 0.2; // 0.2s before can wallrun again
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

  // Double jump (TF2: max 2 jumps total - only after first jump)
    if (this.jumpCount === 1) {
      this.vel.y = this.DOUBLE_JUMP;
      this.jumpCount = 2;
      this.jumpBufferTimer = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Main update – called AFTER world.step()                            */
  /* ------------------------------------------------------------------ */

  update(delta: number, targets?: any[], enemies?: any[]) {
    this.pollGamepad();
    
    // If piloting titan, update titan controls instead of player movement
    if (this.isPilotingTitan) {
      this.updateTitanControls();
      // Keep existing player bullets simulated, but disable player weapon firing.
      this.handleShooting(delta, targets, enemies, false);
      return;
    }
    
    // Track keyboard embark key hold for disembark
    if (this.keys.embark) {
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
      if (holdDuration >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) {
        if (timeSinceEmbark < this.EMBARK_COOLDOWN) {
          console.log('Keyboard: Disembark blocked - in embark cooldown (' + timeSinceEmbark.toFixed(2) + 's / ' + this.EMBARK_COOLDOWN + 's)');
        } else {
          this.isDisembarking = true;
          this.hasTriggeredEmbark = true; // Mark as triggered so we don't also embark
          this.onDisembarkTitan();
        }
      }
    }
    
    this.move(delta);
    this.applyVelocity();
    this.handleShooting(delta, targets, enemies);
    this.syncCamera();
    this.updateUI();
  }

  private exitWallRun(cooldown: number): void {
    // Preserve only tangent velocity when leaving the wall.
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

  private move(dt: number) {
    // Clear crouch release requirement when player actually releases crouch
    if (this.needsCrouchRelease && !this.isCrouching()) {
      this.needsCrouchRelease = false;
    }

    this.wasGrounded = this.isGrounded;
    this.isGrounded = this.checkGrounded();

    // Read back position cannon solved (collision pushed us out of walls)
    // but ignore cannon's velocity – we manage our own.

    // Detect landing frame for bunny hopping
    const justLanded = !this.wasGrounded && this.isGrounded;

    // --- Bunny hop detection ---
    if (justLanded && this.jumpBufferTimer > 0) {
      // Bunny hop! Jump immediately on landing, preserving momentum
      this.vel.y = this.JUMP_FORCE;
      // Horizontal velocity is preserved (no ground friction)
      this.isSliding = false;
      // Don't reset jumpCount - we're continuing our air sequence
      this.jumpBufferTimer = 0;
    }

    // --- Grounded transitions ---
    if (this.isGrounded) {
      this.coyoteTimer = this.coyoteTime;
      if (justLanded) {
        // just landed (normal landing, not bunny hop)
        this.jumpCount = 0;
        this.isWallRunning = false;
        // Auto-slide on landing if crouch is held and moving fast enough
        if (this.isCrouching()) {
          this.startSlide();
        }
      }
    } else {
      this.coyoteTimer -= dt;
    }

    // --- Wall run detection FIRST (before jump) ---
    // Decrement cooldowns
    if (this.wallJumpCooldown > 0) {
      this.wallJumpCooldown -= dt;
    }
    if (this.wallRunExitGraceTimer > 0) {
      this.wallRunExitGraceTimer -= dt;
    }
    if (this.slideEndCooldown > 0) {
      this.slideEndCooldown -= dt;
    }
    if (this.edgeBoostCooldown > 0) {
      this.edgeBoostCooldown -= dt;
    }
    const wall = this.checkWall();
    // Can only start wallrun if cooldown has expired
    if (
      !this.isGrounded &&
      !this.isMantling &&
      wall.hit &&
      this.hSpeed() > 3 &&
      !this.isWallRunning &&
      this.wallJumpCooldown <= 0
    ) {
      this.isWallRunning = true;
      this.wallNormal = wall.normal;
      this.wallRunTimer = 0;
    }
    // Wall run timeout check
    if (this.isWallRunning) {
      this.wallRunTimer += dt;

      // Lost wall contact: immediately exit wallrun state.
      if (!wall.hit) {
        this.exitWallRun(0.1);
      } else {
        // Keep normal fresh so run direction stays stable on changing surfaces.
        this.wallNormal.copy(wall.normal);
      }
      
      // Crouch cancels wall run
      if (this.isCrouching()) {
        this.exitWallRun(0.2);
      }
      
      // Timeout after max duration
      if (this.wallRunTimer > this.WALL_RUN_MAX_TIME) {
        this.exitWallRun(0.3); // Slightly longer cooldown on timeout
      }
    }

    // --- Jump buffer (after wall detection so wallrun is active) ---
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer -= dt;
      this.tryJump();
    }

    // --- Mantle detection (airborne, moving forward, hitting a ledge) ---
    // Block mantle shortly after wall run ends to prevent auto-mantle
    const canMantle = !this.isGrounded && 
                      !this.isMantling && 
                      !this.isWallRunning && 
                      this.wallJumpCooldown < 0.1 && // Brief buffer after wall run
                      this.vel.y <= 2;
    if (canMantle) {
      const wish = this.wishDir();
      if (wish.length() > 0.1) {
        const mantle = this.checkMantle();
        if (mantle.can) {
          this.isMantling = true;
          this.mantleTimer = this.MANTLE_DURATION;
          this.mantleTarget.set(
            this.body.position.x,
            mantle.ledgeY,
            this.body.position.z,
          );
          // Move target slightly forward onto the ledge
          const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            this.euler.y,
          );
          fwd.y = 0;
          fwd.normalize();
          this.mantleTarget.add(fwd.multiplyScalar(0.5));
        }
      }
    }

    // --- Build velocity based on state ---
    const wishMove = this.wishDir();

    if (this.isMantling) {
      // ---- MANTLE ----
      this.mantleTimer -= dt;
      // Lerp toward ledge top
      const diff = this.mantleTarget
        .clone()
        .sub(
          new THREE.Vector3(
            this.body.position.x,
            this.body.position.y,
            this.body.position.z,
          ),
        );
      const upNeeded = diff.y;
      const fwdNeeded = Math.sqrt(diff.x * diff.x + diff.z * diff.z);

      this.vel.y = Math.max(
        upNeeded / Math.max(this.mantleTimer, 0.05),
        this.MANTLE_UP_SPEED,
      );
      if (fwdNeeded > 0.1) {
        const fwdDir = new THREE.Vector3(diff.x, 0, diff.z).normalize();
        this.vel.x = fwdDir.x * this.MANTLE_FWD_SPEED;
        this.vel.z = fwdDir.z * this.MANTLE_FWD_SPEED;
      }

      if (this.mantleTimer <= 0 || upNeeded < 0.1) {
        // Mantle complete – apply boost
        this.isMantling = false;
        const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          this.euler.y,
        );
        fwd.y = 0;
        fwd.normalize();
        this.vel.x = fwd.x * this.MANTLE_BOOST;
        this.vel.z = fwd.z * this.MANTLE_BOOST;
        this.vel.y = 1; // small upward pop
        this.jumpCount = 0; // reset jumps after mantle
      }
    } else if (this.isSliding) {
      // ---- SLIDE ----
      // Slide continues even when falling or on steep surfaces
      this.slideTimer += dt;

      if (!this.isCrouching()) {
        // Crouch released - exit slide immediately
        this.isSliding = false;
        this.vel.x *= 0.5; // Keep some momentum
        this.vel.z *= 0.5;
        this.slideEndCooldown = this.SLIDE_STOP_DELAY;
        return;
      }

      // Get surface info for physics (only if grounded)
      const surface = this.checkGroundedWithSurface();
      
      // Check if we just left a ledge while sliding (edge boost)
      const wasGrounded = this.wasGrounded;
      const justLeftLedge = wasGrounded && !surface.grounded && this.vel.y <= 0.1;
      if (justLeftLedge && this.hSpeed() > 6) {
        // Edge boost - accelerate when leaving ledge during slide
        const boost = 8;
        const dir = new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize();
        this.vel.x += dir.x * boost;
        this.vel.z += dir.z * boost;
        
        // Smooth transition off ledge - small upward arc to create parabolic motion
        this.vel.y = 3; // Initial upward velocity for smooth arc
      }
      
      // Apply gravity when airborne
      if (!surface.grounded) {
        this.vel.y += this.GRAVITY * dt;
      }
      
      // Surface-aware friction - different materials have different slide properties
      let frictionMultiplier = 1.0; // Default: normal friction
      
      if (surface.grounded && surface.material) {
        // Check material name/type for different friction
        const matName = (surface.material as any).name || '';
        if (matName.includes('floor') || matName.includes('Floor')) {
          frictionMultiplier = 0.7; // Smooth floors - less friction
        } else if (matName.includes('wall') || matName.includes('Wall')) {
          frictionMultiplier = 1.5; // Walls - more friction  
        } else if (matName.includes('ramp') || matName.includes('Ramp')) {
          frictionMultiplier = 0.5; // Ramps - very slippery
        }
      }

      // Exponential friction decay - TF2 style momentum preservation
      const baseFriction = 0.985; // 1.5% speed loss per second
      const friction = Math.pow(baseFriction, frictionMultiplier);
      const speed = this.hSpeed();
      const minSlideSpeed = 1;
      
      // Project velocity onto surface plane (follows slope)
      if (surface.grounded && surface.steepness > 0.05) {
        const vel = new THREE.Vector3(this.vel.x, 0, this.vel.z);
        // Remove component into the surface
        vel.addScaledVector(surface.normal, -vel.dot(surface.normal));
        this.vel.x = vel.x;
        this.vel.z = vel.z;
      }
      
      // Apply exponential decay
      const newSpeed = Math.max(speed * Math.pow(friction, dt * 60), minSlideSpeed);
      
      if (speed > 0.1) {
        const ratio = newSpeed / speed;
        this.vel.x *= ratio;
        this.vel.z *= ratio;
      } else {
        // Too slow - exit slide
        this.isSliding = false;
      }

      // Allow falling during slide (gravity applied above)
    } else if (this.isWallRunning) {
      // ---- WALL RUN ----
      // Determine desired direction from input or camera forward
      let dir: THREE.Vector3;
      const wish = this.wishDir();
      if (wish.length() > 0) {
        dir = wish.clone();
      } else {
        dir = new THREE.Vector3(0, 0, -1).applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          this.euler.y,
        );
        dir.y = 0;
        dir.normalize();
      }

      // Project onto wall tangent plane — removes component into/away from wall
      // so looking away from the wall doesn't push the player off it
      dir.addScaledVector(this.wallNormal, -dir.dot(this.wallNormal));
      if (dir.length() > 0.01) dir.normalize();

      this.vel.x = dir.x * this.WALL_RUN_SPEED;
      this.vel.z = dir.z * this.WALL_RUN_SPEED;

      // Small push toward wall to maintain contact with the surface
      this.vel.x -= this.wallNormal.x * 3;
      this.vel.z -= this.wallNormal.z * 3;

      this.vel.y = 0; // no gravity during wall run
    } else if (this.isGrounded) {
      // ---- GROUND ----
      // Jump fired this frame (tryJump set vel.y > 0) — preserve horizontal momentum
      if (this.vel.y > 0) {
        // do nothing to horizontal velocity
      } else if (this.slideEndCooldown > 0) {
        this.vel.x = 0;
        this.vel.z = 0;
      } else if (this.isCrouching()) {
        // Crouch walking
        const target = this.CROUCH_SPEED;
        if (wishMove.length() > 0) {
          // Accelerate toward wish direction
          const currentSpeed = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(
            wishMove,
          );
          const addSpeed = target - currentSpeed;
          if (addSpeed > 0) {
            const accel = Math.min(this.GROUND_ACCEL * dt, addSpeed);
            this.vel.x += wishMove.x * accel;
            this.vel.z += wishMove.z * accel;
          }
          // Clamp to crouch speed
          const hs = this.hSpeed();
          if (hs > target) {
            const s = target / hs;
            this.vel.x *= s;
            this.vel.z *= s;
          }
        }
      } else {
        const target = this.isSprinting() ? this.SPRINT_SPEED : this.GROUND_SPEED;
        if (wishMove.length() > 0) {
          // Accelerate toward wish direction
          const currentSpeed = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(
            wishMove,
          );
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
      }
      // Clamp downward velocity on ground
      if (this.vel.y < 0) this.vel.y = 0;
    } else {
      // ---- AIRBORNE ----
      // Edge boost: speed boost when walking off ledge at speed
      if (this.edgeBoostCooldown <= 0 && this.wasGrounded && this.vel.y <= 0.1 && this.hSpeed() > 8) {
        const boost = 8;
        const dir = new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize();
        this.vel.x += dir.x * boost;
        this.vel.z += dir.z * boost;
        this.edgeBoostCooldown = 0.5;
      }
      
      if (this.wallRunExitGraceTimer <= 0 && wishMove.length() > 0) {
        // Quake-style air acceleration
        const currentSpeed = new THREE.Vector3(this.vel.x, 0, this.vel.z).dot(
          wishMove,
        );
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
    // Play jump sound when jumping
    if (this.vel.y > 0.1 && !this.wasJumping) {
      import("./sound").then(({ soundManager }) => {
        soundManager.playSound("jump");
      });
    }
    this.wasJumping = this.vel.y > 0.1;

    // Play slide sound when starting slide
    if (this.isSliding && !this.wasSliding) {
      import("./sound").then(({ soundManager }) => {
        soundManager.playSound("slide");
      });
    }
    this.wasSliding = this.isSliding;

    // Play wall run sound when starting wall run
    if (this.isWallRunning && !this.wasWallRunning) {
      import("./sound").then(({ soundManager }) => {
        soundManager.playSound("wallrun");
      });
    }
    this.wasWallRunning = this.isWallRunning;

    // Play mantle sound
    if (this.isMantling && !this.wasMantling) {
      import("./sound").then(({ soundManager }) => {
        soundManager.playSound("mantle");
      });
    }
    this.wasMantling = this.isMantling;

    this.body.velocity.set(this.vel.x, this.vel.y, this.vel.z);
    // Sync Three.js group from cannon position
    this.group.position.set(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z,
    );

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

  private handleShooting(delta: number, targets?: any[], enemies?: any[], allowFire: boolean = true) {
    if (allowFire && (this.keys.fire || this.gamepadFire)) {
      const now = performance.now();
      if (now - this.lastShotTime > 100) {
        this.shoot();
        this.lastShotTime = now;
      }
    }
    const worldMeshes = this.getBulletCollisionMeshes();
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.time += delta;

      // Apply gravity to bullet
      b.velocity.y += this.BULLET_GRAVITY * delta;

      // Update position
      const prevPos = b.mesh.position.clone();
      const step = b.velocity.clone().multiplyScalar(delta);
      b.mesh.position.add(step);

      // Orient bullet to face velocity direction
      if (b.velocity.length() > 0.1) {
        const lookTarget = b.mesh.position.clone().add(b.velocity);
        b.mesh.lookAt(lookTarget);
      }

      // Update trail
      b.trailPositions.unshift(b.mesh.position.clone());
      if (b.trailPositions.length > b.maxTrailLength) {
        b.trailPositions.pop();
      }

      // Update trail geometry
      if (b.trailPositions.length >= 2) {
        const positions: number[] = [];
        for (const pos of b.trailPositions) {
          positions.push(pos.x, pos.y, pos.z);
        }
        b.trail.geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(positions, 3),
        );
        (
          b.trail.geometry as THREE.BufferGeometry
        ).attributes.position.needsUpdate = true;

        // Fade trail based on age
        const alpha = 1 - b.time / 3;
        (b.trail.material as THREE.LineBasicMaterial).opacity = Math.max(
          0,
          alpha * 0.5,
        );
      }

      // Check target hits
      let hit = false;
      const stepLen = step.length();
      if (stepLen > 1e-6) {
        const raycaster = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen);
        const wallHits = raycaster.intersectObjects(worldMeshes, false);
        if (wallHits.length > 0 && wallHits[0].distance <= stepLen) {
          const wallHit = wallHits[0];
          b.mesh.position.copy(wallHit.point);
          const normal = wallHit.face
            ? wallHit.face.normal.clone().transformDirection((wallHit.object as THREE.Mesh).matrixWorld)
            : step.clone().normalize().negate();
          this.createBulletImpact(wallHit.point, normal);
          hit = true;
        }
      }

      if (targets) {
        for (const target of targets) {
          if (target.checkBulletHit && target.checkBulletHit(b.mesh.position)) {
            target.takeDamage(25, b.mesh.position);
            this.createBulletImpact(
              b.mesh.position.clone(),
              b.velocity.clone().normalize().negate(),
            );
            hit = true;
            break;
          }
        }
      }

      // Check enemy hits
      if (!hit && enemies) {
        for (const enemy of enemies) {
          if (enemy.checkBulletHit && enemy.checkBulletHit(b.mesh.position)) {
            enemy.takeDamage(25, b.mesh.position);
            this.createBulletImpact(
              b.mesh.position.clone(),
              b.velocity.clone().normalize().negate(),
            );
            hit = true;
            break;
          }
        }
      }

      if (hit || b.time > 3 || b.mesh.position.y < -5) {
        this.scene.remove(b.mesh);
        this.scene.remove(b.trail);
        b.trail.geometry.dispose();
        (b.trail.material as THREE.LineBasicMaterial).dispose();
        this.bullets.splice(i, 1);
      }
    }
    this.updateBulletImpactEffects(delta);
  }

  takeDamage(amount: number) {
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      // Respawn after death
      setTimeout(() => {
        this.body.position.set(0, 5, 0);
        this.vel.set(0, 0, 0);
        this.body.velocity.set(0, 0, 0);
        this.health = 100;
      }, 2000);
    }
  }

  private shoot() {
    const bulletSpeed = 120; // m/s - realistic rifle speed
    const gravity = Math.abs(this.BULLET_GRAVITY);

    // Cast ray from camera to find where crosshair points
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = raycaster.intersectObjects(this.getMeshes());

    // Determine target point
    let targetPoint: THREE.Vector3;
    if (intersects.length > 0 && intersects[0].distance < 200) {
      targetPoint = intersects[0].point;
    } else {
      // Default target at 50m
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(
        this.camera.quaternion,
      );
      targetPoint = this.camera.position.clone().add(fwd.multiplyScalar(50));
    }

    // Start position at gun barrel
    const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.camera.quaternion,
    );
    const startPos = this.group.position
      .clone()
      .add(aimDir.clone().multiplyScalar(0.5));

    // Calculate trajectory to hit target
    const displacement = targetPoint.clone().sub(startPos);
    const horizontalDist = Math.sqrt(
      displacement.x * displacement.x + displacement.z * displacement.z,
    );
    const verticalDist = displacement.y;

    // Calculate launch angle using ballistic trajectory
    // Quadratic formula for tan(theta)
    const discriminant =
      bulletSpeed * bulletSpeed * bulletSpeed * bulletSpeed -
      gravity *
        (gravity * horizontalDist * horizontalDist +
          2 * verticalDist * bulletSpeed * bulletSpeed);

    let velocity: THREE.Vector3;

    if (discriminant >= 0 && horizontalDist > 0.1) {
      // Use the lower angle solution for flatter trajectory
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
        velocity = new THREE.Vector3(
          horizontalDir.x * Math.cos(launchAngle) * bulletSpeed,
          Math.sin(launchAngle) * bulletSpeed,
          horizontalDir.z * Math.cos(launchAngle) * bulletSpeed,
        );
      } else {
        // Angle too steep, shoot straight
        velocity = aimDir.clone().multiplyScalar(bulletSpeed);
      }
    } else {
      // No solution, shoot straight
      velocity = aimDir.clone().multiplyScalar(bulletSpeed);
    }

    // Create bullet mesh
    const geo = new THREE.CapsuleGeometry(0.02, 0.08, 4, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ffcc });
    const bullet = new THREE.Mesh(geo, mat);

    bullet.position.copy(startPos);
    // Orient bullet to face velocity
    if (velocity.length() > 0.1) {
      const lookTarget = startPos.clone().add(velocity);
      bullet.lookAt(lookTarget);
      bullet.rotateX(Math.PI / 2);
    }
    this.scene.add(bullet);

    // Create trail
    const trailGeo = new THREE.BufferGeometry();
    const trailMat = new THREE.LineBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.5,
      linewidth: 2,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    this.scene.add(trail);

    this.bullets.push({
      mesh: bullet,
      trail,
      trailPositions: [bullet.position.clone()],
      maxTrailLength: 20,
      velocity: velocity,
      time: 0,
    });
    this.titanMeter = Math.min(100, this.titanMeter + 0.5);
    if (this.onTitanMeterChange) {
      this.onTitanMeterChange(this.titanMeter);
    }
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
    // Health and titan bars are now updated in game.ts

    let el = document.getElementById("debug-speed");
    if (!el) {
      el = document.createElement("div");
      el.id = "debug-speed";
      el.style.cssText =
        "position:fixed;top:20px;right:20px;color:#0f0;font:14px monospace;z-index:100;background:rgba(0,0,0,0.7);padding:8px;line-height:1.5;";
      document.body.appendChild(el);
    }
    const hs = this.hSpeed();
    const state = this.isMantling
      ? "MANTLE"
      : this.isSliding
        ? "SLIDE"
        : this.isWallRunning
          ? "WALLRUN"
          : this.isGrounded
            ? "GROUND"
            : "AIR";
    const isSprinting = this.isSprinting();
    const sprintStatus = isSprinting ? "ON" : "off";
    const sprintColor = isSprinting ? "#00ff00" : "#888888";
    el.innerHTML =
      `Speed: ${hs.toFixed(1)}<br>` +
      `State: ${state}<br>` +
      `Vel: ${this.vel.x.toFixed(1)}, ${this.vel.y.toFixed(1)}, ${this.vel.z.toFixed(1)}<br>` +
      `Jumps: ${this.jumpCount}<br>` +
      `<span style="color:${sprintColor}">SPRINT: ${sprintStatus}</span> | Crouch: ${this.isCrouching()}`;
  }
}

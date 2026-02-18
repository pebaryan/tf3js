import * as THREE from "three";
import * as CANNON from "cannon-es";
import { getBindings } from "./keybindings";
import { Weapon, R201_WEAPON } from "./weapons";
import { BallisticsSystem, Bullet } from "./ballistics";
import { ImpactEffectsRenderer, PLAYER_IMPACT_CONFIG } from "./effects";
import { MovementSystem, MovementInput } from "./movement";

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

  // --- movement (delegated to MovementSystem) ---
  private movement!: MovementSystem;

  // Sound state tracking (previous-frame flags for transition detection)
  private wasJumping = false;
  private wasSliding = false;
  private wasWallRunning = false;
  private wasMantling = false;

  // Edge-trigger flags consumed once per update() call
  private jumpJustPressed = false;
  private crouchJustPressed = false;

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
  private bullets: Bullet[] = [];
  private ballisticsSystem!: BallisticsSystem;
  private impactRenderer!: ImpactEffectsRenderer;
  private activeWeapon: Weapon = R201_WEAPON;

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

    this.movement = new MovementSystem(scene, this.body);
    this.setupControls();
    this.createWeapon();
    this.ballisticsSystem = new BallisticsSystem(this.scene);
    this.impactRenderer = new ImpactEffectsRenderer(this.scene);
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
    else if (e.code === b.jump)      { this.keys.jump = true; this.jumpJustPressed = true; }
    else if (e.code === b.sprint)    { this.keys.sprint = true; }
    else if (e.code === b.crouch)    { this.keys.crouch = true; this.crouchJustPressed = true; }
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
    this.movement.vel.set(0, 0, 0);
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
    this.movement.vel.set(x, y, z);
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
      this.jumpJustPressed = true;
    }
    this.gamepadJumpPrev = lb;

    if (rb && !this.gamepadCrouchPrev) {
      this.crouchJustPressed = true;
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
  /*  Main update – called AFTER world.step()                           */
  /* ------------------------------------------------------------------ */

  private buildMovementInput(): MovementInput {
    const input: MovementInput = {
      forward:          this.keys.forward,
      backward:         this.keys.backward,
      left:             this.keys.left,
      right:            this.keys.right,
      jumpJustPressed:  this.jumpJustPressed,
      sprint:           this.keys.sprint,
      crouch:           this.keys.crouch,
      crouchJustPressed: this.crouchJustPressed,
      gamepadMove:      this.gamepadMove.clone(),
      gamepadSprint:    this.gamepadSprint,
      gamepadCrouch:    this.gamepadCrouch,
      yaw:              this.euler.y,
    };
    // Consume the edge-trigger flags
    this.jumpJustPressed   = false;
    this.crouchJustPressed = false;
    return input;
  }

  update(delta: number, targets?: any[], enemies?: any[]) {
    this.pollGamepad();

    if (this.isPilotingTitan) {
      this.updateTitanControls();
      // Keep existing bullets simulated, but disable firing while in Titan
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
          this.hasTriggeredEmbark = true;
          this.onDisembarkTitan();
        }
      }
    }

    this.movement.update(delta, this.buildMovementInput());
    this.applyVelocity();
    this.handleShooting(delta, targets, enemies);
    this.syncCamera();
    this.updateUI();
  }

  /** Flush movement velocity into cannon, sync group position, and trigger sounds. */
  private applyVelocity() {
    const m = this.movement;

    if (m.vel.y > 0.1 && !this.wasJumping) {
      import("./sound").then(({ soundManager }) => { soundManager.playSound("jump"); });
    }
    this.wasJumping = m.vel.y > 0.1;

    if (m.isSliding && !this.wasSliding) {
      import("./sound").then(({ soundManager }) => { soundManager.playSound("slide"); });
    }
    this.wasSliding = m.isSliding;

    if (m.isWallRunning && !this.wasWallRunning) {
      import("./sound").then(({ soundManager }) => { soundManager.playSound("wallrun"); });
    }
    this.wasWallRunning = m.isWallRunning;

    if (m.isMantling && !this.wasMantling) {
      import("./sound").then(({ soundManager }) => { soundManager.playSound("mantle"); });
    }
    this.wasMantling = m.isMantling;

    m.applyToBody();
    this.group.position.set(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z,
    );
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

    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prevPos = b.mesh.position.clone();
      this.ballisticsSystem.updateBullet(b, delta);
      const step = b.mesh.position.clone().sub(prevPos);

      // Hit detection
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
          this.impactRenderer.spawnImpact(wallHit.point, normal, PLAYER_IMPACT_CONFIG);
          hit = true;
        }
      }

      if (!hit && targets) {
        for (const target of targets) {
          if (target.checkBulletHit && target.checkBulletHit(b.mesh.position)) {
            target.takeDamage(this.activeWeapon.damage, b.mesh.position);
            this.impactRenderer.spawnImpact(
              b.mesh.position.clone(),
              b.velocity.clone().normalize().negate(),
              PLAYER_IMPACT_CONFIG,
            );
            hit = true;
            break;
          }
        }
      }

      if (!hit && enemies) {
        for (const enemy of enemies) {
          if (enemy.checkBulletHit && enemy.checkBulletHit(b.mesh.position)) {
            enemy.takeDamage(this.activeWeapon.damage, b.mesh.position);
            this.impactRenderer.spawnImpact(
              b.mesh.position.clone(),
              b.velocity.clone().normalize().negate(),
              PLAYER_IMPACT_CONFIG,
            );
            hit = true;
            break;
          }
        }
      }

      if (hit || b.time > b.maxLifetime || b.mesh.position.y < -5) {
        this.ballisticsSystem.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }

    this.impactRenderer.update(delta);
  }

  takeDamage(amount: number) {
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      // Respawn after death
      setTimeout(() => {
        this.body.position.set(0, 5, 0);
        this.movement.vel.set(0, 0, 0);
        this.body.velocity.set(0, 0, 0);
        this.health = 100;
      }, 2000);
    }
  }

  private getMeshes(): THREE.Mesh[] {
    return this.scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  }

  private shoot() {
    const weapon = this.activeWeapon;

    // Cast ray from camera to find where crosshair points
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = raycaster.intersectObjects(this.getMeshes());

    // Determine target point
    let targetPoint: THREE.Vector3;
    if (intersects.length > 0 && intersects[0].distance < 200) {
      targetPoint = intersects[0].point;
    } else {
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

    // Calculate velocity with ballistic arc compensation
    const velocity = BallisticsSystem.calculateParabolicVelocity(
      startPos,
      targetPoint,
      weapon.bulletSpeed,
      Math.abs(weapon.bulletVisuals.gravity),
      aimDir,
    );

    const bullet = this.ballisticsSystem.createBullet(startPos, velocity, weapon.bulletVisuals);
    this.bullets.push(bullet);

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
    const m = this.movement;
    const hs = m.hSpeed();
    const state = m.isMantling
      ? "MANTLE"
      : m.isSliding
        ? "SLIDE"
        : m.isWallRunning
          ? "WALLRUN"
          : m.isGrounded
            ? "GROUND"
            : "AIR";
    const isSprinting = this.keys.sprint || this.gamepadSprint;
    const sprintColor = isSprinting ? "#00ff00" : "#888888";
    el.innerHTML =
      `Speed: ${hs.toFixed(1)}<br>` +
      `State: ${state}<br>` +
      `Vel: ${m.vel.x.toFixed(1)}, ${m.vel.y.toFixed(1)}, ${m.vel.z.toFixed(1)}<br>` +
      `Jumps: ${m.jumpCount}<br>` +
      `<span style="color:${sprintColor}">SPRINT: ${isSprinting ? "ON" : "off"}</span> | Crouch: ${this.keys.crouch || this.gamepadCrouch}`;
  }
}

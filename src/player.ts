import * as THREE from "three";
import * as CANNON from "cannon-es";
import { getBindings, getAimCurve, applyAimCurve } from "./keybindings";
import { Weapon, WeaponManager, R201_WEAPON } from "./weapons";
import { BallisticsSystem, Bullet } from "./ballistics";
import { ImpactEffectsRenderer, PLAYER_IMPACT_CONFIG, DEFAULT_MUZZLE_CONFIG, EPG_EXPLOSION_CONFIG, FRAG_EXPLOSION_CONFIG } from "./effects";
import { MovementSystem, MovementInput } from "./movement";
import { AimingSystem } from "./aiming";
import { ReticleRenderer } from "./reticle";
import { RadarRenderer } from "./radar";
import { soundManager } from "./sound";

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

interface Grenade {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  fuseTime: number;
  bouncesLeft: number;
  trail: THREE.Line;
  trailPositions: THREE.Vector3[];
}

/**
 * Titanfall 2 player controller.
 *
 * Movement is delegated to MovementSystem. This class handles input,
 * camera, combat (shooting, grenades, grapple), weapon viewmodel, and UI.
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

  // --- grapple ---
  private isGrappling = false;
  private grappleTarget = new THREE.Vector3();
  private grappleRope: THREE.Line | null = null;
  private grappleCooldown = 0;
  private grappleKeyHeld = false;
  private readonly GRAPPLE_RANGE = 40;
  private readonly GRAPPLE_PULL_SPEED = 25;
  private readonly GRAPPLE_COOLDOWN = 8;
  private readonly GRAPPLE_GRAVITY = -5;

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
  private mouseADS = false;
  private gamepadTitanDash = false;

  // --- weapon viewmodel ---
  private weaponMesh: THREE.Group | null = null;
  private readonly hipfirePos = new THREE.Vector3(0.25, -0.22, -0.4);
  private readonly adsPos = new THREE.Vector3(0, -0.13, -0.35);
  private weaponViewOffset = this.hipfirePos.clone();
  private weaponBobTime = 0;
  private weaponRecoilKick = 0; // current recoil animation (0-1, decays to 0)
  private weaponSwayX = 0;
  private weaponSwayY = 0;

  // --- combat ---
  health = 100;
  titanMeter = 0;
  private lastShotTime = 0;
  private bullets: Bullet[] = [];

  // --- grenades ---
  private grenades: Grenade[] = [];
  private grenadeCooldown = 0;
  private grenadeCount = 2;
  private maxGrenades = 2;
  private grenadeRegenTime = 0;
  private readonly GRENADE_REGEN_DURATION = 5; // seconds to regenerate one grenade
  private grenadeHeld = false;
  private grenadeTrajectoryLine: THREE.Line | null = null;
  private gamepadGrenadeHeld = false;
  private ballisticsSystem!: BallisticsSystem;
  private impactRenderer!: ImpactEffectsRenderer;
  private weaponManager = new WeaponManager();
  private activeWeapon!: Weapon;
  private aimingSystem = new AimingSystem();
  private reticleRenderer = new ReticleRenderer();
  private radarRenderer = new RadarRenderer();
  private recoilOffset = { x: 0, y: 0 };
  private crosshairSpread = 0;
  private weaponSwitchCooldown = 0;

  // cannon body (collision only)
  body: CANNON.Body;

  // --- titan callbacks and state ---
  private onTitanMeterChange?: (meter: number) => void;
  private onCallTitan?: () => void;
  private onEmbarkTitan?: () => void;
  private onDisembarkTitan?: () => void;
  private onPause?: () => void;
  private onTitanControl?: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean) => void;
  private isPilotingTitan = false;
  private gamepadButtonXHoldTime = 0;
  private gamepadMenuPrev = false;
  private keyboardEmbarkStartTime = 0;
  private hasTriggeredEmbark = false;
  private suppressInteractRelease = false;
  private readonly DISENGAGE_HOLD_TIME = 1.0;
  private readonly EMBARK_COOLDOWN = 2.0;
  private lastEmbarkTime = 0;
  private isDisembarking = false;
  private gamepadDpadDownPrev = false;
  private gamepadReloadPrev = false;
  private gamepadGrenadePrev = false;
  private gamepadGrapplePrev = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
    world: CANNON.World,
  ) {
    this.camera = camera;
    this.scene = scene;
    this.group = new THREE.Group();

    const shape = new CANNON.Sphere(0.4);
    this.body = new CANNON.Body({
      mass: 1,
      shape,
      position: new CANNON.Vec3(0, 2, 0),
      fixedRotation: true,
      linearDamping: 0,
      angularDamping: 1,
    });
    this.body.type = CANNON.Body.DYNAMIC;
    world.addBody(this.body);

    this.movement = new MovementSystem(scene, this.body);
    this.setupControls();
    this.ballisticsSystem = new BallisticsSystem(this.scene);
    this.impactRenderer = new ImpactEffectsRenderer(this.scene);
    this.aimingSystem.setRecoilCompensation((movement) => {
      this.recoilOffset.x += movement.x;
      this.recoilOffset.y += movement.y;
    });
this.weaponManager.addWeapon(R201_WEAPON);
    this.activeWeapon = this.weaponManager.getCurrentWeapon()!;
    this.reticleRenderer.setWeapon(this.activeWeapon.name);
    this.rebuildWeaponMesh();
    this.updateWeaponHUD();
  }

  /* ------------------------------------------------------------------ */
  /*  Weapon viewmodel                                                   */
  /* ------------------------------------------------------------------ */

  private rebuildWeaponMesh() {
    console.log('[Player] rebuildWeaponMesh called for', this.activeWeapon?.name);
    if (this.weaponMesh) {
      this.scene.remove(this.weaponMesh);
      this.weaponMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.weaponMesh = null;
    }

    const gun = new THREE.Group();
    const weapon = this.activeWeapon;
    const name = weapon?.name ?? 'R-201';

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const accentColor = weapon?.bulletVisuals?.color ?? 0x00ffcc;
    const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 0.3 });

    if (name === 'R-201') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.018, 0.4, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.15); gun.add(barrel);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.2), bodyMat);
      body.position.set(0, -0.01, 0.05); gun.add(body);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.1), bodyMat);
      stock.position.set(0, -0.01, 0.2); gun.add(stock);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.08, 0.03), accentMat);
      mag.position.set(0, -0.06, 0.05); gun.add(mag);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.01, 0.15), accentMat);
      rail.position.set(0, 0.03, -0.05); gun.add(rail);
    } else if (name === 'EVA-8') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.3, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.1); gun.add(barrel);
      const pump = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 8), accentMat);
      pump.rotation.x = Math.PI / 2; pump.position.set(0, -0.025, -0.05); gun.add(pump);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.15), bodyMat);
      body.position.set(0, -0.01, 0.08); gun.add(body);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.08), bodyMat);
      stock.position.set(0, -0.01, 0.2); gun.add(stock);
    } else if (name === 'Kraber') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.55, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.2); gun.add(barrel);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.25), bodyMat);
      body.position.set(0, -0.01, 0.1); gun.add(body);
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 8), accentMat);
      scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.04, 0.0); gun.add(scope);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 8), accentMat);
      lens.position.set(0, 0.04, -0.05); gun.add(lens);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.07, 0.12), bodyMat);
      stock.position.set(0, -0.02, 0.28); gun.add(stock);
    } else if (name === 'EPG-1') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.2, 10), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.08); gun.add(barrel);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.005, 8, 16), accentMat);
      ring.position.set(0, 0.01, -0.18); gun.add(ring);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.18), bodyMat);
      body.position.set(0, -0.01, 0.07); gun.add(body);
      const cell = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 10), accentMat);
      cell.position.set(0, -0.01, 0.18); gun.add(cell);
    } else if (name === 'Alternator') {
      const barrelL = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.25, 8), bodyMat);
      barrelL.rotation.x = Math.PI / 2; barrelL.position.set(-0.018, 0.01, -0.08); gun.add(barrelL);
      const barrelR = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.25, 8), bodyMat);
      barrelR.rotation.x = Math.PI / 2; barrelR.position.set(0.018, 0.01, -0.08); gun.add(barrelR);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.12), bodyMat);
      body.position.set(0, -0.01, 0.06); gun.add(body);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.08), bodyMat);
      stock.position.set(0, -0.01, 0.16); gun.add(stock);
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.02, 0.03), accentMat);
      vent.position.set(0, 0.02, 0.04); gun.add(vent);
    } else if (name === 'CAR') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.22, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.06); gun.add(barrel);
      const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8), bodyMat);
      suppressor.rotation.x = Math.PI / 2; suppressor.position.set(0, 0.01, -0.16); gun.add(suppressor);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.055, 0.14), bodyMat);
      body.position.set(0, -0.01, 0.05); gun.add(body);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.07, 0.035), bodyMat);
      mag.position.set(0, -0.05, 0.03); gun.add(mag);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.1), bodyMat);
      stock.position.set(0, -0.01, 0.15); gun.add(stock);
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.025, 0.04), accentMat);
      sight.position.set(0, 0.035, 0.02); gun.add(sight);
    } else if (name === 'Flatline') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.32, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.12); gun.add(barrel);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.055, 0.2), bodyMat);
      body.position.set(0, -0.005, 0.06); gun.add(body);
      const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.08), accentMat);
      handguard.position.set(0, -0.01, -0.04); gun.add(handguard);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.04), bodyMat);
      mag.position.set(0, -0.05, 0.06); gun.add(mag);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.055, 0.1), bodyMat);
      stock.position.set(0, -0.01, 0.2); gun.add(stock);
    } else if (name === 'Mastiff') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.15, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.03); gun.add(barrel);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.16), bodyMat);
      body.position.set(0, -0.01, 0.08); gun.add(body);
      const energyCell = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), accentMat);
      energyCell.position.set(0, 0.02, 0.14); gun.add(energyCell);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.08), bodyMat);
      stock.position.set(0, -0.01, 0.2); gun.add(stock);
      const frame = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 16, Math.PI), accentMat);
      frame.rotation.x = Math.PI / 2; frame.rotation.z = Math.PI; frame.position.set(0, 0.01, -0.02); gun.add(frame);
    } else if (name === 'Wingman') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.28, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.12); gun.add(barrel);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.07, 0.12), bodyMat);
      body.position.set(0, -0.02, 0.02); gun.add(body);
      const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.035, 6), bodyMat);
      cylinder.position.set(0, -0.02, -0.02); gun.add(cylinder);
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.05), accentMat);
      sight.position.set(0, 0.04, 0.0); gun.add(sight);
      const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.03, 0.015), bodyMat);
      trigger.position.set(0, -0.06, 0.06); gun.add(trigger);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.06, 0.04), bodyMat);
      grip.position.set(0, -0.06, 0.04); gun.add(grip);
    } else if (name === 'L-STAR') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.35, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.12); gun.add(barrel);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.065, 0.22), bodyMat);
      body.position.set(0, -0.01, 0.06); gun.add(body);
      const coil1 = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.006, 6, 16), accentMat);
      coil1.position.set(0, 0.02, -0.02); gun.add(coil1);
      const coil2 = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.006, 6, 16), accentMat);
      coil2.position.set(0, 0.02, -0.06); gun.add(coil2);
      const energyPack = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.04), accentMat);
      energyPack.position.set(0, -0.04, 0.08); gun.add(energyPack);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.055, 0.08), bodyMat);
      stock.position.set(0, -0.01, 0.2); gun.add(stock);
    } else if (name === 'XO-16') {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 8), bodyMat);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.25); gun.add(barrel);
      const barrelShroud = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.3, 8), bodyMat);
      barrelShroud.rotation.x = Math.PI / 2; barrelShroud.position.set(0, 0.02, -0.45); gun.add(barrelShroud);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.25), bodyMat);
      body.position.set(0, -0.01, 0.05); gun.add(body);
      const ammoBox = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.08), accentMat);
      ammoBox.position.set(0, -0.06, 0.02); gun.add(ammoBox);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.15, 0.04), bodyMat);
      handle.position.set(0, -0.08, 0.12); handle.rotation.x = -0.3; gun.add(handle);
      const sightRail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.2), bodyMat);
      sightRail.position.set(0, 0.045, -0.03); gun.add(sightRail);
      const coolingVents = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.06), accentMat);
      coolingVents.position.set(0, 0.03, 0.08); gun.add(coolingVents);
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), bodyMat);
      gun.add(body);
    }

    // Grip + trigger guard (shared)
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.06, 0.025), bodyMat);
    grip.position.set(0, -0.05, 0.03); grip.rotation.x = -0.2; gun.add(grip);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.008, 0.04), bodyMat);
    guard.position.set(0, -0.03, 0.02); gun.add(guard);

    gun.renderOrder = 900;
    gun.frustumCulled = false;
    gun.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.renderOrder = 900;
      child.frustumCulled = false;

      const material = child.material as THREE.Material & {
        depthTest?: boolean;
        depthWrite?: boolean;
        fog?: boolean;
        opacity?: number;
        transparent?: boolean;
        toneMapped?: boolean;
      };
      material.transparent = true;
      material.opacity = 1;
      material.depthTest = false;
      material.depthWrite = false;
      material.fog = false;
      material.toneMapped = false;
    });

    this.weaponViewOffset.copy(this.hipfirePos);
    this.scene.add(gun);
    this.weaponMesh = gun;
    this.syncWeaponMeshToCamera();
    console.log('[Player] Weapon mesh created and added to camera');
    console.log('[Player] Weapon mesh children:', gun.children.length);
  }

  private syncWeaponMeshToCamera(): void {
    if (!this.weaponMesh) return;

    const offset = this.weaponViewOffset.clone().applyQuaternion(this.camera.quaternion);
    this.weaponMesh.position.copy(this.camera.position).add(offset);
    this.weaponMesh.quaternion.copy(this.camera.quaternion);
  }

  private syncViewmodelAnchors(): void {
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.position.copy(this.group.position);
    this.camera.position.y += 0.5;
    this.syncWeaponMeshToCamera();
  }

private getWeaponMuzzleLocalOffset(): THREE.Vector3 {
    switch (this.activeWeapon.name) {
      case 'R-201':
        return new THREE.Vector3(0, 0.01, -0.35);
      case 'EVA-8':
        return new THREE.Vector3(0, 0.01, -0.25);
      case 'Kraber':
        return new THREE.Vector3(0, 0.01, -0.48);
      case 'EPG-1':
        return new THREE.Vector3(0, 0.01, -0.18);
      case 'Alternator':
        return new THREE.Vector3(0, 0.01, -0.2);
      case 'CAR':
        return new THREE.Vector3(0, 0.01, -0.22);
      case 'Flatline':
        return new THREE.Vector3(0, 0.01, -0.28);
      case 'Mastiff':
        return new THREE.Vector3(0, 0.01, -0.18);
      case 'Wingman':
        return new THREE.Vector3(0, 0.01, -0.26);
      case 'L-STAR':
        return new THREE.Vector3(0, 0.01, -0.35);
      case 'XO-16':
        return new THREE.Vector3(0, 0.02, -0.6);
      default:
        return new THREE.Vector3(0, 0, -0.18);
    }
  }

  private getWeaponMuzzlePosition(aimDir: THREE.Vector3): THREE.Vector3 {
    this.syncViewmodelAnchors();

    if (!this.weaponMesh) {
      return this.camera.position.clone().add(aimDir.clone().multiplyScalar(0.5));
    }

    this.weaponMesh.updateWorldMatrix(true, false);
    return this.weaponMesh.localToWorld(this.getWeaponMuzzleLocalOffset());
  }

  private getShotDirection(
    weapon: Weapon,
    aimDir: THREE.Vector3,
    spreadRad: number,
    pelletIndex: number,
    pelletCount: number,
  ): THREE.Vector3 {
    if (spreadRad <= 0) return aimDir.clone();

    const right = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) {
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }

    const up = new THREE.Vector3().crossVectors(right, aimDir).normalize();

    if (weapon.name === 'Mastiff' && pelletCount > 1) {
      const t = pelletCount === 1 ? 0 : pelletIndex / (pelletCount - 1);
      const angleOffset = (t - 0.5) * 2 * spreadRad;
      return aimDir.clone().applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(up, angleOffset),
      );
    }

    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spreadRad;
    return aimDir.clone()
      .add(right.multiplyScalar(Math.cos(angle) * radius))
      .add(up.multiplyScalar(Math.sin(angle) * radius))
      .normalize();
  }

  /* ------------------------------------------------------------------ */
  /*  Input                                                              */
  /* ------------------------------------------------------------------ */

  private setupControls() {
    document.addEventListener("keydown", (e) => this.onKeyDown(e));
    document.addEventListener("keyup", (e) => this.onKeyUp(e));
    document.addEventListener("mousemove", (e) => this.onMouseMove(e));
    document.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.keys.fire = true;
      if (e.button === 2) this.mouseADS = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.keys.fire = false;
      if (e.button === 2) this.mouseADS = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("gamepadconnected", (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.gamepadIndex = null;
    });

    document.addEventListener("wheel", (e) => {
      if (!document.pointerLockElement) return;
      if (this.weaponSwitchCooldown > 0) return;
      if (e.deltaY > 0) {
        this.switchWeapon(this.weaponManager.nextWeapon());
      } else if (e.deltaY < 0) {
        this.switchWeapon(this.weaponManager.prevWeapon());
      }
    });

    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) { this.gamepadIndex = i; break; }
    }
  }

  tryPickupWeapon(newWeapon: Weapon): Weapon | null {
    const idx = this.weaponManager.getCurrentIndex();
    const dropped = this.weaponManager.replaceWeapon(idx, newWeapon);
    if (dropped) {
      this.activeWeapon = this.weaponManager.getCurrentWeapon()!;
      this.weaponSwitchCooldown = 0.3;
      this.reticleRenderer.setWeapon(this.activeWeapon.name);
      this.rebuildWeaponMesh();
      this.updateWeaponHUD();
      soundManager.playSound('pickup', 0.4);
    }
    return dropped;
  }

  private switchWeapon(weapon: Weapon | null): void {
    if (!weapon || weapon === this.activeWeapon) return;
    this.weaponManager.cancelReload();
    this.activeWeapon = weapon;
    this.weaponSwitchCooldown = 0.3;
    this.crosshairSpread = 0;
    this.reticleRenderer.setWeapon(weapon.name);
    this.rebuildWeaponMesh();
    this.updateWeaponHUD();
    soundManager.playSound('weapon_switch', 0.4);
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
      this.keyboardEmbarkStartTime = performance.now();
      this.hasTriggeredEmbark = false;
      this.suppressInteractRelease = false;
    }
    // Reload
    else if (e.code === 'KeyR') { if (this.weaponManager.startReload()) { soundManager.playSound('reload', 0.4); } this.updateWeaponHUD(); }
    else if (e.code === 'KeyG') { this.grenadeHeld = true; }
    else if (e.code === 'KeyQ') { this.grappleKeyHeld = true; this.startGrapple(); }
    // Weapon switching: 1-4 keys
    else if (e.code === 'Digit1') { this.switchWeapon(this.weaponManager.switchTo(0)); }
    else if (e.code === 'Digit2') { this.switchWeapon(this.weaponManager.switchTo(1)); }
    else if (e.code === 'Digit3') { this.switchWeapon(this.weaponManager.switchTo(2)); }
    else if (e.code === 'Digit4') { this.switchWeapon(this.weaponManager.switchTo(3)); }
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
      if (!this.hasTriggeredEmbark && !this.suppressInteractRelease && holdDuration < this.DISENGAGE_HOLD_TIME && this.onEmbarkTitan) {
        this.lastEmbarkTime = performance.now();
        this.onEmbarkTitan();
      }
      this.hasTriggeredEmbark = false;
      this.suppressInteractRelease = false;
    }
    else if (e.code === 'KeyQ') { this.grappleKeyHeld = false; this.stopGrapple(); }
    else if (e.code === 'KeyG') {
      if (this.grenadeHeld) {
        this.grenadeHeld = false;
        this.throwGrenade();
      }
    }
  }

  // --- look sensitivity ---
  private readonly LOOK_SENS_X = 0.002;
  private readonly LOOK_SENS_Y = 0.0012;
  private readonly ADS_SENS_MULT = 0.4;
  private readonly TITAN_LOOK_X_FROM_MOUSE = this.LOOK_SENS_X / 0.03;
  private readonly TITAN_LOOK_Y_FROM_MOUSE = this.LOOK_SENS_Y / 0.02;

  private onMouseMove(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    const sensMult = (this.mouseADS || this.gamepadADS) ? this.ADS_SENS_MULT : 1.0;
    if (this.isPilotingTitan) {
      this.titanMouseLook.x += e.movementX * this.TITAN_LOOK_X_FROM_MOUSE * sensMult;
      this.titanMouseLook.y += e.movementY * this.TITAN_LOOK_Y_FROM_MOUSE * sensMult;
    }

    const compX = this.recoilOffset.x;
    const compY = this.recoilOffset.y;
    this.recoilOffset.x = 0;
    this.recoilOffset.y = 0;

    this.euler.y -= (e.movementX * this.LOOK_SENS_X + compX) * sensMult;
    this.euler.x -= (e.movementY * this.LOOK_SENS_Y + compY) * sensMult;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
  }

  lockPointer() {
    document.body.requestPointerLock();
  }

  /* ------------------------------------------------------------------ */
  /*  Titan callbacks                                                    */
  /* ------------------------------------------------------------------ */

  setTitanMeterCallback(callback: (meter: number) => void): void { this.onTitanMeterChange = callback; }
  setCallTitanCallback(callback: () => void): void { this.onCallTitan = callback; }
  setEmbarkTitanCallback(callback: () => void): void { this.onEmbarkTitan = callback; }
  setDisembarkTitanCallback(callback: () => void): void { this.onDisembarkTitan = callback; }
  setPauseCallback(callback: () => void): void { this.onPause = callback; }
  setTitanControlCallback(callback: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean) => void): void {
    this.onTitanControl = callback;
  }

  setPilotingState(piloting: boolean): void {
    this.isPilotingTitan = piloting;
    if (!piloting) { this.titanMouseLook.set(0, 0); }
    const hud = document.getElementById('weapon-hud');
    if (hud) hud.style.display = piloting ? 'none' : '';
    if (piloting) {
      this.reticleRenderer.setWeapon('XO-16');
    } else {
      this.reticleRenderer.setWeapon(this.activeWeapon.name);
    }
  }

  private updateTitanControls(): void {
    if (!this.onTitanControl || !this.isPilotingTitan) return;
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
    if (mag > 1) { localX /= mag; localZ /= mag; }
    const forward = -localZ;
    const right = localX;
    const lookX = (this.gamepadLook.x || 0) + this.titanMouseLook.x;
    const lookY = (this.gamepadLook.y || 0) + this.titanMouseLook.y;
    this.titanMouseLook.set(0, 0);
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
    if (this.onTitanMeterChange) { this.onTitanMeterChange(0); }
  }

  setVelocity(x: number, y: number, z: number): void {
    this.movement.vel.set(x, y, z);
  }

  isADSActive(): boolean {
    return this.mouseADS || this.gamepadADS;
  }

  shouldShowSniperScope(): boolean {
    return !this.isPilotingTitan && this.activeWeapon.name === 'Kraber' && this.isADSActive();
  }

  isInteractHeld(): boolean {
    return this.keys.embark || this.gamepadButtonXHoldTime > 0;
  }

  consumeInteractHold(): void {
    this.hasTriggeredEmbark = true;
    this.suppressInteractRelease = true;
  }

  isInteractConsumed(): boolean {
    return this.suppressInteractRelease;
  }

  getVelocity(): THREE.Vector3 {
    return this.movement.vel;
  }

  /* ------------------------------------------------------------------ */
  /*  Gamepad                                                            */
  /* ------------------------------------------------------------------ */

  private pollGamepad() {
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;

    const dz = 0.15;
    const moveSens = 0.6;
    const lookSens = 1.0;
    const ax = (i: number, sens: number) => {
      const v = gp.axes[i];
      return Math.abs(v) > dz ? v * sens : 0;
    };
    this.gamepadMove.set(ax(0, moveSens), ax(1, moveSens));
    const curve = getAimCurve();
    const rawLookX = Math.abs(gp.axes[2]) > dz ? gp.axes[2] : 0;
    const rawLookY = Math.abs(gp.axes[3]) > dz ? gp.axes[3] : 0;
    this.gamepadLook.set(
      applyAimCurve(rawLookX, curve) * lookSens,
      applyAimCurve(rawLookY, curve) * lookSens,
    );

    // Ninja layout: LB=jump, RB=crouch, LT=ADS, RT=fire
    const lb = gp.buttons[4]?.pressed ?? false;
    const rb = gp.buttons[5]?.pressed ?? false;
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;
    const buttonX = gp.buttons[2]?.pressed ?? false;
    const dpadDown = gp.buttons[13]?.pressed ?? false;
    const menuBtn = gp.buttons[8]?.pressed ?? false;
    const buttonA = gp.buttons[0]?.pressed ?? false;
    const buttonB = gp.buttons[1]?.pressed ?? false;
    const buttonY = gp.buttons[3]?.pressed ?? false;

    // Y = cycle weapon
    if (buttonY && !this.gamepadReloadPrev) {
      this.switchWeapon(this.weaponManager.nextWeapon());
    }
    this.gamepadReloadPrev = buttonY;

    // B = grenade (hold to aim, release to throw)
    if (buttonB && !this.gamepadGrenadePrev) {
      this.gamepadGrenadeHeld = true;
    }
    if (!buttonB && this.gamepadGrenadeHeld) {
      this.gamepadGrenadeHeld = false;
      this.throwGrenade();
    }
    this.gamepadGrenadePrev = buttonB;

    if (lb && !this.gamepadJumpPrev) {
      this.jumpJustPressed = true;
    }
    this.gamepadJumpPrev = lb;

    if (rb && !this.gamepadCrouchPrev) {
      this.crouchJustPressed = true;
    }
    this.gamepadCrouchPrev = rb;
    this.gamepadCrouch = rb;

    // Button X: Short press = reload / embark, Hold = disembark
    if (buttonX) {
      if (this.gamepadButtonXHoldTime === 0) {
        this.hasTriggeredEmbark = false;
        this.suppressInteractRelease = false;
      }
      if (!this.isDisembarking) {
        this.gamepadButtonXHoldTime += 0.016;
        const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
        if (this.gamepadButtonXHoldTime >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) {
          if (timeSinceEmbark >= this.EMBARK_COOLDOWN) {
            this.isDisembarking = true;
            this.onDisembarkTitan();
          }
        }
      }
} else {
      if (
        this.gamepadButtonXHoldTime > 0 &&
        this.gamepadButtonXHoldTime < this.DISENGAGE_HOLD_TIME &&
        !this.suppressInteractRelease
      ) {
        // Short press: try embark first, otherwise reload
        if (this.onEmbarkTitan) {
          this.lastEmbarkTime = performance.now();
          this.onEmbarkTitan();
        } else {
          if (this.weaponManager.startReload()) { soundManager.playSound('reload', 0.4); }
          this.updateWeaponHUD();
        }
      }
      this.gamepadButtonXHoldTime = 0;
      this.isDisembarking = false;
      this.hasTriggeredEmbark = false;
      this.suppressInteractRelease = false;
    }

    // D-pad down to call Titan
    if (dpadDown && !this.gamepadDpadDownPrev && this.onCallTitan) {
      this.onCallTitan();
    }
    this.gamepadDpadDownPrev = dpadDown;

    // Menu button to pause
    if (menuBtn && !this.gamepadMenuPrev && this.onPause) {
      this.onPause();
    }
    this.gamepadMenuPrev = menuBtn;
    this.gamepadTitanDash = buttonA;

    // A = grapple (when not piloting titan)
    if (!this.isPilotingTitan) {
      if (buttonA && !this.gamepadGrapplePrev) {
        this.grappleKeyHeld = true;
        this.startGrapple();
      } else if (!buttonA && this.gamepadGrapplePrev) {
        this.grappleKeyHeld = false;
        this.stopGrapple();
      }
    }
    this.gamepadGrapplePrev = buttonA;

    // Auto-sprint: full stick deflection
    const rawX = gp.axes[0] ?? 0;
    const rawY = gp.axes[1] ?? 0;
    this.gamepadSprint = Math.sqrt(rawX * rawX + rawY * rawY) > 0.9;
    // RT = fire, LT = ADS
    this.gamepadFire = rt > 0.5;
    this.gamepadADS = lt > 0.3;

    if (this.gamepadLook.length() > dz) {
      const adsMult = (this.mouseADS || this.gamepadADS) ? this.ADS_SENS_MULT : 1.0;
      this.euler.y -= this.gamepadLook.x * 0.04 * adsMult;
      this.euler.x -= this.gamepadLook.y * 0.025 * adsMult;
      this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private getMeshes(): THREE.Mesh[] {
    return this.scene.children.filter(
      (o) => o instanceof THREE.Mesh && !o.userData.ignoreRaycast,
    ) as THREE.Mesh[];
  }

  /* ------------------------------------------------------------------ */
  /*  Main update                                                        */
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
    // Consume edge-trigger flags
    this.jumpJustPressed   = false;
    this.crouchJustPressed = false;
    return input;
  }

  update(delta: number, targets?: any[], enemies?: any[]) {
    this.pollGamepad();

    if (this.isPilotingTitan) {
      this.updateTitanControls();
      this.handleShooting(delta, targets, enemies, false);
      this.updateGrenades(delta, targets, enemies);
      return;
    }

    // Track keyboard embark key hold for disembark
    if (this.keys.embark) {
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
      if (holdDuration >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) {
        if (timeSinceEmbark >= this.EMBARK_COOLDOWN) {
          this.isDisembarking = true;
          this.hasTriggeredEmbark = true;
          this.onDisembarkTitan();
        }
      }
    }

    // Delegate movement to MovementSystem (unless grappling)
    if (!this.isGrappling) {
      const input = this.buildMovementInput();
      this.movement.update(delta, input);
    } else {
      // While grappling, consume edge-trigger flags
      this.jumpJustPressed = false;
      this.crouchJustPressed = false;
    }

    this.updateGrapple(delta);
    this.applyVelocity();
    this.handleShooting(delta, targets, enemies);
    this.updateGrenades(delta, targets, enemies);
    this.updateGrenadeTrajectory();
    this.updateAiming(delta);
    this.syncCamera();
    this.updateUI();
  }

  /** Write velocity into cannon body, play movement sounds, sync position. */
  private applyVelocity() {
    const m = this.movement;

    // Play jump sound when jumping
    if (m.vel.y > 0.1 && !this.wasJumping) {
      soundManager.playSound("jump", 0.3);
    }
    this.wasJumping = m.vel.y > 0.1;

    // Play slide sound when starting slide
    if (m.isSliding && !this.wasSliding) {
      soundManager.playSound("slide", 0.3);
    }
    this.wasSliding = m.isSliding;

    // Play wall run sound when starting wall run
    if (m.isWallRunning && !this.wasWallRunning) {
      soundManager.playSound("wallrun", 0.25);
    }
    this.wasWallRunning = m.isWallRunning;

    // Play mantle sound
    if (m.isMantling && !this.wasMantling) {
      soundManager.playSound("mantle", 0.3);
    }
    this.wasMantling = m.isMantling;

    m.applyToBody();
    this.group.position.set(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z,
    );

    // Respawn if fallen
    if (this.body.position.y < -10) {
      this.body.position.set(0, 5, 0);
      m.vel.set(0, 0, 0);
      this.body.velocity.set(0, 0, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Shooting                                                           */
  /* ------------------------------------------------------------------ */

  private handleShooting(delta: number, targets?: any[], enemies?: any[], allowFire: boolean = true) {
    if (this.weaponSwitchCooldown > 0) {
      this.weaponSwitchCooldown = Math.max(0, this.weaponSwitchCooldown - delta);
    }

    if (this.weaponManager.isReloading()) {
      if (this.weaponManager.updateReload(delta * 1000)) {
        this.updateWeaponHUD();
      }
    }

    if (allowFire && this.weaponSwitchCooldown <= 0 && !this.weaponManager.isReloading() && (this.keys.fire || this.gamepadFire)) {
      const now = performance.now();
      if (now - this.lastShotTime > this.activeWeapon.fireRate) {
        if (this.weaponManager.getCurrentAmmo() <= 0) {
          if (this.weaponManager.startReload()) { soundManager.playSound('reload', 0.4); }
          this.updateWeaponHUD();
        } else {
          this.weaponManager.consumeAmmo(1);
          this.shoot();
          this.lastShotTime = now;
          this.updateWeaponHUD();
        }
      }
    }

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
            this.impactRenderer.spawnImpact(b.mesh.position.clone(), b.velocity.clone().normalize().negate(), PLAYER_IMPACT_CONFIG);
            this.reticleRenderer.showHitmarker(target.health <= 0);
            hit = true;
            break;
          }
        }
      }

      if (!hit && enemies) {
        for (const enemy of enemies) {
          if (enemy.checkBulletHit && enemy.checkBulletHit(b.mesh.position)) {
            const wasDead = enemy.health <= 0;
            enemy.takeDamage(this.activeWeapon.damage, b.mesh.position);
            this.impactRenderer.spawnImpact(b.mesh.position.clone(), b.velocity.clone().normalize().negate(), PLAYER_IMPACT_CONFIG);
            if (!wasDead && enemy.health <= 0) {
              this.reticleRenderer.showHitmarker(true);
            } else {
              this.reticleRenderer.showHitmarker(false);
            }
            hit = true;
            break;
          }
        }
      }

      if (hit || b.time > b.maxLifetime || b.mesh.position.y < -5) {
        if (hit && b.explosive) {
          this.impactRenderer.spawnExplosion(b.mesh.position.clone(), EPG_EXPLOSION_CONFIG);
          soundManager.playSound('explosion', 0.6);
          const splashR = b.splashRadius;
          if (splashR > 0) {
            const impactPos = b.mesh.position;
            if (targets) {
              for (const target of targets) {
                if (target.checkBulletHit && target.group) {
                  const dist = impactPos.distanceTo(target.group.position);
                  if (dist < splashR) {
                    const falloff = 1 - dist / splashR;
                    target.takeDamage(Math.round(this.activeWeapon.damage * falloff), impactPos);
                    this.reticleRenderer.showHitmarker(target.health <= 0);
                  }
                }
              }
            }
            if (enemies) {
              for (const enemy of enemies) {
                if (enemy.checkBulletHit && enemy.group) {
                  const dist = impactPos.distanceTo(enemy.group.position);
                  if (dist < splashR) {
                    const falloff = 1 - dist / splashR;
                    const wasDead = enemy.health <= 0;
                    enemy.takeDamage(Math.round(this.activeWeapon.damage * falloff), impactPos);
                    if (!wasDead && enemy.health <= 0) {
                      this.reticleRenderer.showHitmarker(true);
                    } else {
                      this.reticleRenderer.showHitmarker(false);
                    }
                  }
                }
              }
            }
          }
        }
        this.ballisticsSystem.disposeBullet(b);
        this.bullets.splice(i, 1);
      }
    }

    this.impactRenderer.update(delta);
  }

  private updateAiming(delta: number): void {
    this.crosshairSpread = Math.max(0, this.crosshairSpread - 30 * delta);
    const isADS = this.mouseADS || this.gamepadADS;
    const moveSpread = this.movement.hSpeed() * (isADS ? 0.1 : 0.3);
    const totalSpread = this.crosshairSpread + moveSpread;

    // Hide reticle when pointer is not locked (menu/pause)
    if (!document.pointerLockElement) {
      this.reticleRenderer.hide();
      return;
    }

    if (this.shouldShowSniperScope()) {
      this.reticleRenderer.hide();
    } else {
      this.reticleRenderer.setSpread(totalSpread);
      this.reticleRenderer.render();
      this.reticleRenderer.show();
    }

    if (this.gamepadLook.length() > 0.1) {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const hits = raycaster.intersectObjects(this.getMeshes());
      if (hits.length > 0 && hits[0].distance < 30) {
        this.aimingSystem.assistAiming({
          x: this.gamepadLook.x,
          y: this.gamepadLook.y,
        });
      }
    }
  }

  takeDamage(amount: number, sourcePosition?: THREE.Vector3) {
    this.health = Math.max(0, this.health - amount);
    soundManager.playSound('hit', 0.5);
    
    if (sourcePosition) {
      const playerRotation = this.euler.y;
      this.radarRenderer.showDamageDirection(sourcePosition, this.group.position, playerRotation);
    }
    
    if (this.health <= 0) {
      setTimeout(() => {
        this.body.position.set(0, 5, 0);
        this.movement.vel.set(0, 0, 0);
        this.body.velocity.set(0, 0, 0);
        this.health = 100;
      }, 2000);
    }
  }

  updateRadar(enemies: { position: THREE.Vector3; velocity?: THREE.Vector3 }[]): void {
    this.radarRenderer.updateEnemies(enemies, this.group.position, this.euler.y);
  }

  renderRadar(): void {
    this.radarRenderer.render();
  }

  private shoot() {
    const weapon = this.activeWeapon;
    const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const startPos = this.getWeaponMuzzlePosition(aimDir);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = raycaster.intersectObjects(this.getMeshes());

    let targetPoint: THREE.Vector3;
    if (intersects.length > 0 && intersects[0].distance < 200) {
      targetPoint = intersects[0].point;
    } else {
      targetPoint = this.camera.position.clone().add(aimDir.clone().multiplyScalar(50));
    }

    const pellets = weapon.bulletsPerShot;
    const isADS = this.mouseADS || this.gamepadADS;
    const adsSpreadMult = isADS ? 0.3 : 1.0; // ADS tightens spread significantly
    const spreadRad = (weapon.spread * adsSpreadMult * Math.PI) / 180;

    for (let p = 0; p < pellets; p++) {
      const shotDir = this.getShotDirection(weapon, aimDir, spreadRad, p, pellets);

      const pelletTarget = pellets > 1
        ? startPos.clone().add(shotDir.multiplyScalar(weapon.range))
        : targetPoint;

      const velocity = BallisticsSystem.calculateParabolicVelocity(
        startPos, pelletTarget, weapon.bulletSpeed,
        Math.abs(weapon.bulletVisuals.gravity), shotDir,
      );

      const bullet = this.ballisticsSystem.createBullet(startPos, velocity, weapon.bulletVisuals);
      this.bullets.push(bullet);
    }

    const recoil = weapon.recoil;
    const recoilMult = isADS ? 0.5 : 1.0;
    this.crosshairSpread = Math.min(12, this.crosshairSpread + recoil.y * 2 * recoilMult);
    this.weaponRecoilKick = Math.min(1, this.weaponRecoilKick + recoil.y * 0.25 * recoilMult);

    if (weapon.muzzleFlash) {
      this.impactRenderer.spawnMuzzleFlash(startPos, aimDir, DEFAULT_MUZZLE_CONFIG);
    }

    soundManager.playSound(weapon.soundId, 0.4);

    this.titanMeter = Math.min(100, this.titanMeter + 0.5);
    if (this.onTitanMeterChange) {
      this.onTitanMeterChange(this.titanMeter);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Grapple                                                            */
  /* ------------------------------------------------------------------ */

  private startGrapple(): void {
    if (this.isGrappling || this.grappleCooldown > 0) return;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    raycaster.far = this.GRAPPLE_RANGE;

    const hits = raycaster.intersectObjects(this.getMeshes());
    if (hits.length === 0) return;

    this.isGrappling = true;
    this.grappleTarget.copy(hits[0].point);

    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(6);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x00ffcc, transparent: true, opacity: 0.7,
    });
    this.grappleRope = new THREE.Line(geo, mat);
    this.scene.add(this.grappleRope);

    // Cancel other movement states
    this.movement.isWallRunning = false;
    this.movement.isSliding = false;
    this.movement.isMantling = false;

    soundManager.playSound('grapple', 0.4);
    this.updateWeaponHUD();
  }

  private stopGrapple(): void {
    if (!this.isGrappling) return;

    this.isGrappling = false;
    this.grappleCooldown = this.GRAPPLE_COOLDOWN;

    if (this.grappleRope) {
      this.scene.remove(this.grappleRope);
      this.grappleRope.geometry.dispose();
      (this.grappleRope.material as THREE.Material).dispose();
      this.grappleRope = null;
    }

    this.updateWeaponHUD();
  }

  private updateGrapple(delta: number): void {
    if (this.grappleCooldown > 0) {
      this.grappleCooldown = Math.max(0, this.grappleCooldown - delta);
    }

    if (!this.isGrappling) return;

    const m = this.movement;
    const playerPos = this.group.position;
    const toTarget = this.grappleTarget.clone().sub(playerPos);
    const dist = toTarget.length();

    if (dist < 1.5) {
      this.stopGrapple();
      return;
    }

    // Cancel on jump
    if (this.jumpJustPressed) {
      m.vel.y = Math.max(m.vel.y, 11 * 0.7); // JUMP_FORCE * 0.7
      this.stopGrapple();
      return;
    }

    if (!this.grappleKeyHeld) {
      this.stopGrapple();
      return;
    }

    // Physics: pull toward target
    const dir = toTarget.normalize();
    m.vel.x += dir.x * this.GRAPPLE_PULL_SPEED * delta;
    m.vel.y += dir.y * this.GRAPPLE_PULL_SPEED * delta;
    m.vel.z += dir.z * this.GRAPPLE_PULL_SPEED * delta;

    // Reduced gravity while grappling
    m.vel.y += this.GRAPPLE_GRAVITY * delta;

    // Cap speed
    const speed = m.vel.length();
    if (speed > 35) {
      m.vel.multiplyScalar(35 / speed);
    }

    // Update rope visual
    if (this.grappleRope) {
      const ropeStart = playerPos.clone();
      ropeStart.y += 0.3;
      const positions = this.grappleRope.geometry.attributes.position as THREE.BufferAttribute;
      positions.setXYZ(0, ropeStart.x, ropeStart.y, ropeStart.z);
      positions.setXYZ(1, this.grappleTarget.x, this.grappleTarget.y, this.grappleTarget.z);
      positions.needsUpdate = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Grenades                                                           */
  /* ------------------------------------------------------------------ */

  private throwGrenade(): void {
    if (this.grenadeCooldown > 0 || this.grenadeCount <= 0) return;

    this.grenadeCount--;
    this.grenadeCooldown = 0.8;
    this.grenadeRegenTime = 0;

    const throwDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    throwDir.y += 0.3;
    throwDir.normalize();

    // Start from hand position (lower right of screen where weapon appears)
    const handOffset = new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion);
    const startPos = this.camera.position.clone().add(handOffset);
    const velocity = throwDir.multiplyScalar(20);

    const geo = new THREE.SphereGeometry(0.05, 8, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x44ff44,
      emissive: 0x44ff44,
      emissiveIntensity: 2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(startPos);
    this.scene.add(mesh);

    const trailGeo = new THREE.BufferGeometry();
    const trailPositions = new Float32Array(60 * 3);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({
      color: 0x44ff44,
      transparent: true,
      opacity: 0.6,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    this.scene.add(trail);

    this.grenades.push({ 
      mesh, 
      velocity, 
      fuseTime: 2.0, 
      bouncesLeft: 3,
      trail,
      trailPositions: [startPos.clone()],
    });
    this.updateWeaponHUD();
  }

  private updateGrenades(delta: number, targets?: any[], enemies?: any[]): void {
    if (this.grenadeCooldown > 0) {
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    }

    if (this.grenadeCount < this.maxGrenades) {
      this.grenadeRegenTime += delta;
      if (this.grenadeRegenTime >= this.GRENADE_REGEN_DURATION) {
        this.grenadeCount++;
        this.grenadeRegenTime = 0;
        this.updateWeaponHUD();
      }
    }

    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);

    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];

      g.velocity.y -= 20 * delta;

      const prevPos = g.mesh.position.clone();
      g.mesh.position.add(g.velocity.clone().multiplyScalar(delta));

      g.trailPositions.push(g.mesh.position.clone());
      if (g.trailPositions.length > 20) {
        g.trailPositions.shift();
      }
      const trailArray = (g.trail.geometry.attributes.position as THREE.BufferAttribute).array;
      for (let j = 0; j < g.trailPositions.length; j++) {
        trailArray[j * 3] = g.trailPositions[j].x;
        trailArray[j * 3 + 1] = g.trailPositions[j].y;
        trailArray[j * 3 + 2] = g.trailPositions[j].z;
      }
      g.trail.geometry.attributes.position.needsUpdate = true;
      g.trail.geometry.setDrawRange(0, g.trailPositions.length);

      const step = g.mesh.position.clone().sub(prevPos);
      const stepLen = step.length();
      if (stepLen > 1e-6) {
        const raycaster = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen + 0.05);
        const hits = raycaster.intersectObjects(worldMeshes, false);
        if (hits.length > 0 && hits[0].distance <= stepLen + 0.05) {
          const hit = hits[0];
          g.mesh.position.copy(hit.point);
          const normal = hit.face
            ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld)
            : step.clone().normalize().negate();

          if (g.bouncesLeft > 0) {
            g.velocity.reflect(normal).multiplyScalar(0.5);
            g.bouncesLeft--;
            g.mesh.position.add(normal.clone().multiplyScalar(0.02));
          } else {
            g.velocity.set(0, 0, 0);
          }
        }
      }

      g.fuseTime -= delta;

      if (g.fuseTime <= 0 || g.mesh.position.y < -20) {
        if (g.fuseTime <= 0) {
          const pos = g.mesh.position.clone();
          this.impactRenderer.spawnExplosion(pos, FRAG_EXPLOSION_CONFIG);
          soundManager.playSound('explosion', 0.6);

          const splashR = 6;
          const damage = 100;
          if (targets) {
            for (const target of targets) {
              if (target.group) {
                const dist = pos.distanceTo(target.group.position);
                if (dist < splashR) {
                  const falloff = 1 - dist / splashR;
                  target.takeDamage(Math.round(damage * falloff), pos);
                  this.reticleRenderer.showHitmarker(target.health <= 0);
                }
              }
            }
          }
          if (enemies) {
            for (const enemy of enemies) {
              if (enemy.group) {
                const dist = pos.distanceTo(enemy.group.position);
                if (dist < splashR) {
                  const wasDead = enemy.health <= 0;
                  const falloff = 1 - dist / splashR;
                  enemy.takeDamage(Math.round(damage * falloff), pos);
                  if (!wasDead && enemy.health <= 0) {
                    this.reticleRenderer.showHitmarker(true);
                  } else {
                    this.reticleRenderer.showHitmarker(false);
                  }
                }
              }
            }
          }
        }

        this.scene.remove(g.mesh);
        g.mesh.geometry.dispose();
        (g.mesh.material as THREE.Material).dispose();
        this.scene.remove(g.trail);
        g.trail.geometry.dispose();
        (g.trail.material as THREE.Material).dispose();
        this.grenades.splice(i, 1);
      }
    }
  }

  private updateGrenadeTrajectory(): void {
    // Hide trajectory when pointer is not locked (menu/pause)
    if (!document.pointerLockElement) {
      if (this.grenadeTrajectoryLine) {
        this.scene.remove(this.grenadeTrajectoryLine);
        this.grenadeTrajectoryLine.geometry.dispose();
        (this.grenadeTrajectoryLine.material as THREE.Material).dispose();
        this.grenadeTrajectoryLine = null;
      }
      return;
    }

    const isHolding = this.grenadeHeld || this.gamepadGrenadeHeld;
    
    if (!isHolding || this.grenadeCooldown > 0 || this.grenadeCount <= 0) {
      if (this.grenadeTrajectoryLine) {
        this.scene.remove(this.grenadeTrajectoryLine);
        this.grenadeTrajectoryLine.geometry.dispose();
        (this.grenadeTrajectoryLine.material as THREE.Material).dispose();
        this.grenadeTrajectoryLine = null;
      }
      return;
    }

    const throwDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    throwDir.y += 0.3;
    throwDir.normalize();
    
    // Start position matches throwGrenade - use weapon-like offset from camera
    const handOffset = new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion);
    const startPos = this.camera.position.clone().add(handOffset);
    const velocity = throwDir.clone().multiplyScalar(20);
    const gravity = -20;
    
    // Get collision meshes but we'll skip early segments to avoid hitting weapon
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    
    const points: THREE.Vector3[] = [];
    const pos = startPos.clone();
    const vel = velocity.clone();
    const dt = 0.03;
    const maxBounces = 3;
    let bounces = 0;
    
    // Skip collision for first few steps to avoid hitting weapon/viewmodel
    const skipCollisionSteps = 3;
    
    for (let i = 0; i < 150 && bounces <= maxBounces; i++) {
      points.push(pos.clone());
      
      const prevPos = pos.clone();
      vel.y += gravity * dt;
      pos.add(vel.clone().multiplyScalar(dt));
      
      // Skip collision detection near player to avoid hitting weapon model
      if (i < skipCollisionSteps) continue;
      
      const stepLen = pos.distanceTo(prevPos);
      if (stepLen > 0.001) {
        const raycaster = new THREE.Raycaster(prevPos, pos.clone().sub(prevPos).normalize(), 0, stepLen + 0.05);
        const hits = raycaster.intersectObjects(worldMeshes, false);
        
        if (hits.length > 0 && hits[0].distance <= stepLen + 0.05) {
          const hit = hits[0];
          points.push(hit.point.clone());
          
          if (bounces < maxBounces) {
            const normal = hit.face
              ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld)
              : pos.clone().sub(prevPos).normalize().negate();
            vel.reflect(normal).multiplyScalar(0.5);
            pos.copy(hit.point).add(normal.multiplyScalar(0.02));
            bounces++;
          } else {
            break;
          }
        }
      }
      
      if (pos.y < -10) break;
    }

    // Ensure we have at least the start point
    if (points.length < 1) {
      points.push(startPos.clone());
    }

    if (points.length < 2) {
      // Add a point ahead if we don't have enough
      const forward = new THREE.Vector3(0, 0, -2).applyQuaternion(this.camera.quaternion);
      points.push(startPos.clone().add(forward));
    }

    if (this.grenadeTrajectoryLine) {
      this.scene.remove(this.grenadeTrajectoryLine);
      this.grenadeTrajectoryLine.geometry.dispose();
      (this.grenadeTrajectoryLine.material as THREE.Material).dispose();
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ 
      color: 0x44ff44, 
      transparent: true, 
      opacity: 0.8,
      linewidth: 2
    });

    this.grenadeTrajectoryLine = new THREE.Line(geometry, material);
    this.scene.add(this.grenadeTrajectoryLine);
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

    const isADS = this.isADSActive();

    const targetFOV = isADS
      ? (this.activeWeapon.name === 'Kraber' ? 20 : this.adsFOV)
      : this.baseFOV;
    this.currentFOV += (targetFOV - this.currentFOV) * 0.15;
    this.camera.fov = this.currentFOV;
    this.camera.updateProjectionMatrix();

    if (this.weaponMesh) {
      this.weaponMesh.visible = !this.shouldShowSniperScope();
      const target = isADS ? this.adsPos.clone() : this.hipfirePos.clone();
      const speed = this.movement.hSpeed();

      // Weapon bob while moving on ground
      if (speed > 1 && this.movement.isGrounded) {
        const bobFreq = isADS ? 6 : 10;
        const bobAmpX = isADS ? 0.002 : 0.008;
        const bobAmpY = isADS ? 0.002 : 0.006;
        this.weaponBobTime += speed * 0.06;
        target.x += Math.sin(this.weaponBobTime * bobFreq) * bobAmpX;
        target.y += Math.abs(Math.sin(this.weaponBobTime * bobFreq * 0.5)) * bobAmpY;
      } else {
        // Slowly reset bob phase when not moving
        this.weaponBobTime *= 0.95;
      }

      // Idle sway (uses weapon accuracy — higher accuracy = less sway)
      const swayAmount = isADS ? 0.0005 : 0.002 * this.activeWeapon.accuracy;
      const t = performance.now() * 0.001;
      this.weaponSwayX += (Math.sin(t * 1.1) * swayAmount - this.weaponSwayX) * 0.05;
      this.weaponSwayY += (Math.cos(t * 0.9) * swayAmount - this.weaponSwayY) * 0.05;
      target.x += this.weaponSwayX;
      target.y += this.weaponSwayY;

      // Recoil kick (pushes weapon back and up, then decays)
      this.weaponRecoilKick *= 0.85;
      target.z += this.weaponRecoilKick * 0.06;
      target.y += this.weaponRecoilKick * 0.01;

      this.weaponViewOffset.lerp(target, 0.15);
      this.syncWeaponMeshToCamera();
    }
  }

  private updateWeaponHUD(): void {
    let container = document.getElementById('weapon-hud');
    if (!container) {
      container = document.createElement('div');
      container.id = 'weapon-hud';
      container.style.cssText =
        'position:fixed;bottom:80px;right:20px;color:#fff;font:13px monospace;z-index:100;' +
        'background:rgba(0,0,0,0.6);padding:8px 12px;border-radius:4px;line-height:1.6;';
      document.body.appendChild(container);
    }
    const weapons = this.weaponManager.getAllWeapons();
    const idx = this.weaponManager.getCurrentIndex();
    const ammo = this.weaponManager.getCurrentAmmo();
    const mag = this.activeWeapon.magazineSize;
    const reloading = this.weaponManager.isReloading();

    const weaponList = weapons
      .map((w, i) => {
        const active = i === idx;
        const color = active ? '#00ffcc' : '#666';
        const prefix = active ? '>' : ' ';
        return `<span style="color:${color}">${prefix} ${i + 1}. ${w.name}</span>`;
      })
      .join('<br>');

    const ammoColor = ammo === 0 ? '#ff4444' : reloading ? '#ffaa00' : '#fff';
    const ammoText = reloading
      ? `<span style="color:#ffaa00">RELOADING</span>`
      : `<span style="color:${ammoColor}">${ammo} / ${mag}</span>`;

    const grenadeColor = this.grenadeCount > 0 ? '#88cc88' : '#ff4444';
    const grenadeText = `<span style="color:${grenadeColor}">G: ${this.grenadeCount}</span>`;

    const grappleReady = this.grappleCooldown <= 0;
    const grappleColor = this.isGrappling ? '#00ffcc' : grappleReady ? '#88cc88' : '#666';
    const grappleLabel = this.isGrappling ? 'GRAPPLE' : grappleReady ? 'READY' : `${this.grappleCooldown.toFixed(1)}s`;
    const grappleText = `<span style="color:${grappleColor}">Q: ${grappleLabel}</span>`;

    container.innerHTML = `${weaponList}<br><br>${ammoText}<br>${grenadeText}<br>${grappleText}`;
  }

  private updateUI() {
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

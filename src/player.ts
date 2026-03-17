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

/* ------------------------------------------------------------------ */
/*  Weapon Mesh Construction                                         */
/* ------------------------------------------------------------------ */

export function createWeaponMesh(weapon: Weapon, forPickup: boolean = false): THREE.Group {
  const gun = new THREE.Group();
  const name = weapon?.name ?? 'R-201';

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const accentColor = weapon?.bulletVisuals?.color ?? 0x00ffcc;
  const accentMat = new THREE.MeshStandardMaterial({ 
    color: accentColor, 
    emissive: accentColor, 
    emissiveIntensity: forPickup ? 1.0 : 0.3 
  });

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
    const barrelL = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.15, 8), bodyMat);
    barrelL.rotation.x = Math.PI / 2; barrelL.position.set(-0.018, 0.01, -0.03); gun.add(barrelL);
    const barrelR = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.15, 8), bodyMat);
    barrelR.rotation.x = Math.PI / 2; barrelR.position.set(0.018, 0.01, -0.03); gun.add(barrelR);
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
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.14, 8), bodyMat);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.01, -0.05); gun.add(barrel);
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

  // --- Attachments Visuals ---
  const attachments = weapon?.attachments || {};

  // Optic
  if (attachments.optic) {
    const opt = attachments.optic;
    const opticGroup = new THREE.Group();
    opticGroup.position.set(0, 0.04, 0.05); // Standard top-rail position

    if (opt.id === 'hcog') {
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.06), bodyMat);
      opticGroup.add(base);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.005), new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.4 }));
      glass.position.set(0, 0.02, -0.02);
      opticGroup.add(glass);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.003, 4, 4), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
      dot.position.set(0, 0.02, -0.021);
      opticGroup.add(dot);
    } else if (opt.id === 'ranger') {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.012, 0.1, 8), bodyMat);
      scope.rotation.x = Math.PI / 2;
      opticGroup.add(scope);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.012, 12), new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.5 }));
      lens.position.z = -0.051; lens.rotation.y = Math.PI;
      opticGroup.add(lens);
    } else if (opt.id === 'threat') {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.08), bodyMat);
      opticGroup.add(box);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.025, 0.025), new THREE.MeshBasicMaterial({ color: 0xff3300, transparent: true, opacity: 0.6 }));
      screen.position.z = 0.041;
      opticGroup.add(screen);
    }
    gun.add(opticGroup);
  }

  // Barrel
  if (attachments.barrel) {
    const bar = attachments.barrel;
    let muzzlePos = new THREE.Vector3(0, 0.01, -0.35); // Default
    if (name === 'Kraber') muzzlePos.set(0, 0.01, -0.48);
    else if (name === 'Alternator') muzzlePos.set(0, 0.01, -0.1);
    else if (name === 'Wingman') muzzlePos.set(0, 0.01, -0.1);

    if (bar.id === 'suppressor') {
      const supGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.15, 8);
      const sup = new THREE.Mesh(supGeo, bodyMat);
      sup.rotation.x = Math.PI / 2;
      sup.position.copy(muzzlePos);
      sup.position.z -= 0.075;
      gun.add(sup);
    } else if (bar.id === 'stabilizer') {
      const stabGeo = new THREE.BoxGeometry(0.03, 0.03, 0.08);
      const stab = new THREE.Mesh(stabGeo, accentMat);
      stab.position.copy(muzzlePos);
      stab.position.z -= 0.04;
      gun.add(stab);
    }
  }

  // Magazine
  if (attachments.magazine && attachments.magazine.id === 'extended_mag') {
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.12, 0.035), accentMat);
    mag.position.set(0, -0.08, 0.05);
    gun.add(mag);
  }

  if (!forPickup) {
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
  } else {
    // Pickup specific scale and rotation adjustments if needed
    gun.scale.set(1.5, 1.5, 1.5); // Make it slightly larger in world
  }

  return gun;
}

/**
 * Titanfall 2 player controller.
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

  private movement!: MovementSystem;
  private wasJumping = false;
  private wasSliding = false;
  private wasWallRunning = false;
  private wasMantling = false;
  private jumpJustPressed = false;
  private crouchJustPressed = false;

  private isGrappling = false;
  private grappleTarget = new THREE.Vector3();
  private grappleRope: THREE.Line | null = null;
  private grapplePreviewLine: THREE.Line | null = null;
  private grappleCooldown = 0;
  private grappleKeyHeld = false;
  private grappleAimTarget = new THREE.Vector3();
  private grappleProjectile: THREE.Mesh | null = null;
  private grappleProjectileVelocity = new THREE.Vector3();
  private grappleProjectileActive = false;
  private readonly GRAPPLE_RANGE = 50;
  private readonly GRAPPLE_PULL_SPEED = 30;
  private readonly GRAPPLE_COOLDOWN = 2;
  private readonly GRAPPLE_PROJECTILE_SPEED = 60;
  private readonly GRAPPLE_GRAVITY = -15;
  private readonly GRAPPLE_TANGENT_BOOST = 1.2;

  private gamepadIndex: number | null = null;
  private gamepadMove = new THREE.Vector2();
  private gamepadLook = new THREE.Vector2();
  private gamepadLookSmoothed = new THREE.Vector2();
  private titanMouseLook = new THREE.Vector2();
  private gamepadJumpPrev = false;
  private gamepadCrouchPrev = false;
  private gamepadSprint = false;
  private gamepadCrouch = false;
  private gamepadFire = false;
  private gamepadADS = false;
  private mouseADS = false;
  private gamepadTitanDash = false;

  private weaponMesh: THREE.Group | null = null;
  private readonly hipfirePos = new THREE.Vector3(0.25, -0.22, -0.4);
  private readonly adsPos = new THREE.Vector3(0, -0.13, -0.35);
  private weaponViewOffset = this.hipfirePos.clone();
  private weaponBobTime = 0;
  private weaponRecoilKick = 0;
  private weaponSwayX = 0;
  private weaponSwayY = 0;

  health = 100;
  titanMeter = 0;
  private lastShotTime = 0;
  private bullets: Bullet[] = [];
  private grenades: Grenade[] = [];
  private grenadeCooldown = 0;
  private grenadeCount = 2;
  private maxGrenades = 2;
  private grenadeRegenTime = 0;
  private readonly GRENADE_REGEN_DURATION = 5;
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

  body: CANNON.Body;

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
  private lastEmbarkTime = performance.now();
  private isDisembarking = false;
  private gamepadDpadDownPrev = false;
  private gamepadReloadPrev = false;
  private gamepadGrenadePrev = false;
  private gamepadGrapplePrev = false;

  constructor(camera: THREE.PerspectiveCamera, scene: THREE.Scene, world: CANNON.World) {
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

  private rebuildWeaponMesh() {
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

    const gun = createWeaponMesh(this.activeWeapon, false);
    this.weaponViewOffset.copy(this.hipfirePos);
    this.scene.add(gun);
    this.weaponMesh = gun;
    this.syncWeaponMeshToCamera();
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
      case 'R-201': return new THREE.Vector3(0, 0.01, -0.35);
      case 'EVA-8': return new THREE.Vector3(0, 0.01, -0.25);
      case 'Kraber': return new THREE.Vector3(0, 0.01, -0.48);
      case 'EPG-1': return new THREE.Vector3(0, 0.01, -0.18);
      case 'Alternator': return new THREE.Vector3(0, 0.01, -0.1);
      case 'CAR': return new THREE.Vector3(0, 0.01, -0.22);
      case 'Flatline': return new THREE.Vector3(0, 0.01, -0.28);
      case 'Mastiff': return new THREE.Vector3(0, 0.01, -0.18);
      case 'Wingman': return new THREE.Vector3(0, 0.01, -0.1);
      case 'L-STAR': return new THREE.Vector3(0, 0.01, -0.35);
      case 'XO-16': return new THREE.Vector3(0, 0.02, -0.6);
      default: return new THREE.Vector3(0, 0, -0.18);
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

  private getShotDirection(weapon: Weapon, aimDir: THREE.Vector3, spreadRad: number, pelletIndex: number, pelletCount: number): THREE.Vector3 {
    if (spreadRad <= 0) return aimDir.clone();
    const right = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
    const up = new THREE.Vector3().crossVectors(right, aimDir).normalize();
    if (weapon.name === 'Mastiff' && pelletCount > 1) {
      const t = pelletCount === 1 ? 0 : pelletIndex / (pelletCount - 1);
      const angleOffset = (t - 0.5) * 2 * spreadRad;
      return aimDir.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(up, angleOffset));
    }
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spreadRad;
    return aimDir.clone().add(right.multiplyScalar(Math.cos(angle) * radius)).add(up.multiplyScalar(Math.sin(angle) * radius)).normalize();
  }

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
    window.addEventListener("gamepadconnected", (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener("gamepaddisconnected", () => { this.gamepadIndex = null; });
    document.addEventListener("wheel", (e) => {
      if (!document.pointerLockElement) return;
      if (this.weaponSwitchCooldown > 0) return;
      if (e.deltaY > 0) this.switchWeapon(this.weaponManager.nextWeapon());
      else if (e.deltaY < 0) this.switchWeapon(this.weaponManager.prevWeapon());
    });
    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) { if (gamepads[i]) { this.gamepadIndex = i; break; } }
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
    if (e.code === b.forward) this.keys.forward = true;
    else if (e.code === b.backward) this.keys.backward = true;
    else if (e.code === b.left) this.keys.left = true;
    else if (e.code === b.right) this.keys.right = true;
    else if (e.code === b.jump) { this.keys.jump = true; this.jumpJustPressed = true; }
    else if (e.code === b.sprint) this.keys.sprint = true;
    else if (e.code === b.crouch) { this.keys.crouch = true; this.crouchJustPressed = true; }
    else if (e.code === b.embark) { this.keys.embark = true; this.keyboardEmbarkStartTime = performance.now(); this.hasTriggeredEmbark = false; this.suppressInteractRelease = false; }
    else if (e.code === 'KeyR') { if (this.weaponManager.startReload()) soundManager.playSound('reload', 0.4); this.updateWeaponHUD(); }
    else if (e.code === 'KeyG') this.grenadeHeld = true;
    else if (e.code === 'KeyQ') { this.grappleKeyHeld = true; this.startGrapple(); }
    else if (e.code === 'Digit1') this.switchWeapon(this.weaponManager.switchTo(0));
    else if (e.code === 'Digit2') this.switchWeapon(this.weaponManager.switchTo(1));
    else if (e.code === 'Digit3') this.switchWeapon(this.weaponManager.switchTo(2));
    else if (e.code === 'Digit4') this.switchWeapon(this.weaponManager.switchTo(3));
  }

  private onKeyUp(e: KeyboardEvent) {
    const b = getBindings();
    if (e.code === b.forward) this.keys.forward = false;
    else if (e.code === b.backward) this.keys.backward = false;
    else if (e.code === b.left) this.keys.left = false;
    else if (e.code === b.right) this.keys.right = false;
    else if (e.code === b.jump) this.keys.jump = false;
    else if (e.code === b.sprint) this.keys.sprint = false;
    else if (e.code === b.crouch) this.keys.crouch = false;
    else if (e.code === b.embark) {
      this.keys.embark = false;
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      if (!this.hasTriggeredEmbark && !this.suppressInteractRelease && holdDuration < this.DISENGAGE_HOLD_TIME && this.onEmbarkTitan) {
        // Only embark here if NOT piloting and NOT already triggered by Game.ts hold
        if (!this.isPilotingTitan) {
          this.lastEmbarkTime = performance.now();
          this.onEmbarkTitan();
        }
      }
      this.hasTriggeredEmbark = false;
      this.suppressInteractRelease = false;
    }
    else if (e.code === 'KeyQ') { this.grappleKeyHeld = false; this.stopGrapple(); }
    else if (e.code === 'KeyG') { if (this.grenadeHeld) { this.grenadeHeld = false; this.throwGrenade(); } }
  }

  private readonly LOOK_SENS_X = 0.002;
  private readonly LOOK_SENS_Y = 0.0012;
  private readonly ADS_SENS_MULT = 0.4;
  private readonly TITAN_LOOK_X_FROM_MOUSE = 0.06;
  private readonly TITAN_LOOK_Y_FROM_MOUSE = 0.06;

  private onMouseMove(e: MouseEvent) {
    if (!document.pointerLockElement) return;
    const sensMult = (this.mouseADS || this.gamepadADS) ? this.ADS_SENS_MULT : 1.0;
    if (this.isPilotingTitan) {
      this.titanMouseLook.x += e.movementX * this.TITAN_LOOK_X_FROM_MOUSE * sensMult;
      this.titanMouseLook.y += e.movementY * this.TITAN_LOOK_Y_FROM_MOUSE * sensMult;
    }
    const compX = this.recoilOffset.x;
    const compY = this.recoilOffset.y;
    this.recoilOffset.x = 0; this.recoilOffset.y = 0;
    this.euler.y -= (e.movementX * this.LOOK_SENS_X + compX) * sensMult;
    this.euler.x -= (e.movementY * this.LOOK_SENS_Y + compY) * sensMult;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
  }

  lockPointer() { document.body.requestPointerLock(); }

  setTitanMeterCallback(callback: (meter: number) => void): void { this.onTitanMeterChange = callback; }
  setCallTitanCallback(callback: () => void): void { this.onCallTitan = callback; }
  setEmbarkTitanCallback(callback: () => void): void { this.onEmbarkTitan = callback; }
  setDisembarkTitanCallback(callback: () => void): void { this.onDisembarkTitan = callback; }
  setPauseCallback(callback: () => void): void { this.onPause = callback; }
  setTitanControlCallback(callback: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean) => void): void { this.onTitanControl = callback; }

  setPilotingState(piloting: boolean): void {
    this.isPilotingTitan = piloting;
    if (!piloting) this.titanMouseLook.set(0, 0);
    const hud = document.getElementById('weapon-hud');
    if (hud) hud.style.display = piloting ? 'none' : '';
    if (piloting) this.reticleRenderer.setWeapon('XO-16'); else this.reticleRenderer.setWeapon(this.activeWeapon.name);
  }

  private updateTitanControls(): void {
    if (!this.onTitanControl || !this.isPilotingTitan) return;
    let localX = 0, localZ = 0;
    if (this.keys.forward) localZ -= 1; if (this.keys.backward) localZ += 1;
    if (this.keys.left) localX -= 1; if (this.keys.right) localX += 1;
    if (this.gamepadMove.length() > 0.1) { localX += this.gamepadMove.x; localZ += this.gamepadMove.y; }
    const mag = Math.hypot(localX, localZ);
    if (mag > 1) { localX /= mag; localZ /= mag; }
    const lookX = (this.gamepadLook.x || 0) + this.titanMouseLook.x;
    const lookY = (this.gamepadLook.y || 0) + this.titanMouseLook.y;
    this.titanMouseLook.set(0, 0);
    this.onTitanControl(-localZ, localX, lookX, lookY, this.keys.fire || this.gamepadFire, this.keys.sprint || this.gamepadTitanDash);
  }

  syncToTitan(position: THREE.Vector3, yaw: number): void {
    this.body.position.set(position.x, position.y + 1, position.z);
    this.body.velocity.set(0, 0, 0); this.movement.vel.set(0, 0, 0);
    this.group.position.set(position.x, position.y + 1, position.z);
    this.euler.y = yaw;
  }

  resetTitanMeter(): void { this.titanMeter = 0; if (this.onTitanMeterChange) this.onTitanMeterChange(0); }
  setVelocity(x: number, y: number, z: number): void { this.movement.vel.set(x, y, z); }
  isADSActive(): boolean { return this.mouseADS || this.gamepadADS; }
  shouldShowSniperScope(): boolean { return !this.isPilotingTitan && this.activeWeapon.name === 'Kraber' && this.isADSActive(); }
  isInteractHeld(): boolean { return this.keys.embark || this.gamepadButtonXHoldTime > 0; }
  consumeInteractHold(): void { this.hasTriggeredEmbark = true; this.suppressInteractRelease = true; }
  isInteractConsumed(): boolean { return this.suppressInteractRelease; }
  getVelocity(): THREE.Vector3 { return this.movement.vel; }

  private pollGamepad() {
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;
    const dz = 0.15, moveSens = 0.6, lookSens = 1.0;
    const ax = (i: number, sens: number) => { const v = gp.axes[i]; return Math.abs(v) > dz ? v * sens : 0; };
    this.gamepadMove.set(ax(0, moveSens), ax(1, moveSens));
    const curve = getAimCurve();
    const rawLookX = Math.abs(gp.axes[2]) > dz ? gp.axes[2] : 0;
    const rawLookY = Math.abs(gp.axes[3]) > dz ? gp.axes[3] : 0;
    this.gamepadLook.set(applyAimCurve(rawLookX, curve) * lookSens, applyAimCurve(rawLookY, curve) * lookSens);
    const smoothFactor = 0.3;
    this.gamepadLookSmoothed.x += (this.gamepadLook.x - this.gamepadLookSmoothed.x) * smoothFactor;
    this.gamepadLookSmoothed.y += (this.gamepadLook.y - this.gamepadLookSmoothed.y) * smoothFactor;
    const lb = gp.buttons[4]?.pressed ?? false, rb = gp.buttons[5]?.pressed ?? false, lt = gp.buttons[6]?.value ?? 0, rt = gp.buttons[7]?.value ?? 0;
    const buttonX = gp.buttons[2]?.pressed ?? false, dpadDown = gp.buttons[13]?.pressed ?? false, menuBtn = gp.buttons[8]?.pressed ?? false;
    const buttonA = gp.buttons[0]?.pressed ?? false, buttonB = gp.buttons[1]?.pressed ?? false, buttonY = gp.buttons[3]?.pressed ?? false;
    if (buttonY && !this.gamepadReloadPrev) this.switchWeapon(this.weaponManager.nextWeapon());
    this.gamepadReloadPrev = buttonY;
    if (buttonB && !this.gamepadGrenadePrev) this.gamepadGrenadeHeld = true;
    if (!buttonB && this.gamepadGrenadeHeld) { this.gamepadGrenadeHeld = false; this.throwGrenade(); }
    this.gamepadGrenadePrev = buttonB;
    if (lb && !this.gamepadJumpPrev) this.jumpJustPressed = true;
    this.gamepadJumpPrev = lb;
    if (rb && !this.gamepadCrouchPrev) this.crouchJustPressed = true;
    this.gamepadCrouchPrev = rb; this.gamepadCrouch = rb;
    if (buttonX) {
      if (this.gamepadButtonXHoldTime === 0) { this.hasTriggeredEmbark = false; this.suppressInteractRelease = false; }
      if (!this.isDisembarking) {
        this.gamepadButtonXHoldTime += 0.016;
        const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
        if (this.gamepadButtonXHoldTime >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) {
          if (timeSinceEmbark >= this.EMBARK_COOLDOWN) { this.isDisembarking = true; this.onDisembarkTitan(); }
        }
      }
    } else {
      if (this.gamepadButtonXHoldTime > 0 && this.gamepadButtonXHoldTime < this.DISENGAGE_HOLD_TIME && !this.suppressInteractRelease) {
        if (this.onEmbarkTitan) { this.lastEmbarkTime = performance.now(); this.onEmbarkTitan(); }
        else { if (this.weaponManager.startReload()) soundManager.playSound('reload', 0.4); this.updateWeaponHUD(); }
      }
      this.gamepadButtonXHoldTime = 0; this.isDisembarking = false; this.hasTriggeredEmbark = false; this.suppressInteractRelease = false;
    }
    if (dpadDown && !this.gamepadDpadDownPrev && this.onCallTitan) this.onCallTitan();
    this.gamepadDpadDownPrev = dpadDown;
    if (menuBtn && !this.gamepadMenuPrev && this.onPause) this.onPause();
    this.gamepadMenuPrev = menuBtn; this.gamepadTitanDash = buttonA;
    if (!this.isPilotingTitan) {
      if (buttonA && !this.gamepadGrapplePrev) { this.grappleKeyHeld = true; this.startGrapple(); }
      else if (!buttonA && this.gamepadGrapplePrev) { this.grappleKeyHeld = false; this.stopGrapple(); }
    }
    this.gamepadGrapplePrev = buttonA;
    this.gamepadSprint = Math.hypot(gp.axes[0] || 0, gp.axes[1] || 0) > 0.9;
    this.gamepadFire = rt > 0.5; this.gamepadADS = lt > 0.3;
    if (this.gamepadLookSmoothed.length() > dz) {
      const adsMult = (this.mouseADS || this.gamepadADS) ? this.ADS_SENS_MULT : 1.0;
      this.euler.y -= this.gamepadLookSmoothed.x * 0.04 * adsMult;
      this.euler.x -= this.gamepadLookSmoothed.y * 0.03 * adsMult;
      this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
    }
  }

  private getMeshes(): THREE.Mesh[] { return this.scene.children.filter((o) => o instanceof THREE.Mesh && !o.userData.ignoreRaycast) as THREE.Mesh[]; }

  private buildMovementInput(): MovementInput {
    const input: MovementInput = { forward: this.keys.forward, backward: this.keys.backward, left: this.keys.left, right: this.keys.right, jumpJustPressed: this.jumpJustPressed, sprint: this.keys.sprint, crouch: this.keys.crouch, crouchJustPressed: this.crouchJustPressed, gamepadMove: this.gamepadMove.clone(), gamepadSprint: this.gamepadSprint, gamepadCrouch: this.gamepadCrouch, yaw: this.euler.y };
    this.jumpJustPressed = false; this.crouchJustPressed = false; return input;
  }

  update(delta: number, targets?: any[], enemies?: any[]) {
    this.pollGamepad();
    if (this.isPilotingTitan) { this.updateTitanControls(); this.handleShooting(delta, targets, enemies, false); this.updateGrenades(delta, targets, enemies); return; }
    if (this.keys.embark) {
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
      if (holdDuration >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) { if (timeSinceEmbark >= this.EMBARK_COOLDOWN) { this.isDisembarking = true; this.hasTriggeredEmbark = true; this.onDisembarkTitan(); } }
    }
    this.updateGrapple(delta);
    if (!this.isGrappling) { const input = this.buildMovementInput(); this.movement.update(delta, input); }
    else { this.jumpJustPressed = false; this.crouchJustPressed = false; }
    this.applyVelocity(); this.handleShooting(delta, targets, enemies); this.updateGrenades(delta, targets, enemies); this.updateGrenadeTrajectory(); this.updateGrappleTrajectory(); this.updateAiming(delta); this.syncCamera(); this.updateUI();
  }

  private applyVelocity() {
    const m = this.movement;
    if (m.vel.y > 0.1 && !this.wasJumping) soundManager.playSound("jump", 0.3); this.wasJumping = m.vel.y > 0.1;
    if (m.isSliding && !this.wasSliding) soundManager.playSound("slide", 0.3); this.wasSliding = m.isSliding;
    if (m.isWallRunning && !this.wasWallRunning) soundManager.playSound("wallrun", 0.25); this.wasWallRunning = m.isWallRunning;
    if (m.isMantling && !this.wasMantling) soundManager.playSound("mantle", 0.3); this.wasMantling = m.isMantling;
    m.applyToBody(); this.group.position.set(this.body.position.x, this.body.position.y, this.body.position.z);
    if (this.body.position.y < -10) { this.body.position.set(0, 5, 0); m.vel.set(0, 0, 0); this.body.velocity.set(0, 0, 0); }
  }

  private handleShooting(delta: number, targets?: any[], enemies?: any[], allowFire: boolean = true) {
    if (this.weaponSwitchCooldown > 0) this.weaponSwitchCooldown = Math.max(0, this.weaponSwitchCooldown - delta);
    if (this.weaponManager.isReloading()) { if (this.weaponManager.updateReload(delta * 1000)) this.updateWeaponHUD(); }
    if (allowFire && this.weaponSwitchCooldown <= 0 && !this.weaponManager.isReloading() && (this.keys.fire || this.gamepadFire)) {
      const now = performance.now();
      if (now - this.lastShotTime > this.activeWeapon.fireRate) {
        if (this.weaponManager.getCurrentAmmo() <= 0) { if (this.weaponManager.startReload()) soundManager.playSound('reload', 0.4); this.updateWeaponHUD(); }
        else { this.weaponManager.consumeAmmo(1); this.shoot(); this.lastShotTime = now; this.updateWeaponHUD(); }
      }
    }
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i]; const prevPos = b.mesh.position.clone(); this.ballisticsSystem.updateBullet(b, delta);
      const step = b.mesh.position.clone().sub(prevPos); let hit = false; const stepLen = step.length();
      if (stepLen > 1e-6) {
        const raycaster = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen);
        const wallHits = raycaster.intersectObjects(worldMeshes, false);
        if (wallHits.length > 0 && wallHits[0].distance <= stepLen) {
          const wallHit = wallHits[0]; b.mesh.position.copy(wallHit.point);
          const normal = wallHit.face ? wallHit.face.normal.clone().transformDirection((wallHit.object as THREE.Mesh).matrixWorld) : step.clone().normalize().negate();
          this.impactRenderer.spawnImpact(wallHit.point, normal, PLAYER_IMPACT_CONFIG); hit = true;
        }
      }
      if (!hit && targets) { for (const target of targets) { if (target.checkBulletHit && target.checkBulletHit(b.mesh.position)) { target.takeDamage(this.activeWeapon.damage, b.mesh.position); this.impactRenderer.spawnImpact(b.mesh.position.clone(), b.velocity.clone().normalize().negate(), PLAYER_IMPACT_CONFIG); this.reticleRenderer.showHitmarker(target.health <= 0); hit = true; break; } } }
      if (!hit && enemies) { for (const enemy of enemies) { if (enemy.checkBulletHit && enemy.checkBulletHit(b.mesh.position)) { const wasDead = enemy.health <= 0; enemy.takeDamage(this.activeWeapon.damage, b.mesh.position); this.impactRenderer.spawnImpact(b.mesh.position.clone(), b.velocity.clone().normalize().negate(), PLAYER_IMPACT_CONFIG); this.reticleRenderer.showHitmarker(enemy.health <= 0); hit = true; break; } } }
      if (hit || b.time > b.maxLifetime || b.mesh.position.y < -5) {
        if (hit && b.explosive) {
          this.impactRenderer.spawnExplosion(b.mesh.position.clone(), EPG_EXPLOSION_CONFIG); soundManager.playSound('explosion', 0.6);
          const splashR = b.splashRadius;
          if (splashR > 0) {
            const impactPos = b.mesh.position;
            if (targets) { for (const target of targets) { if (target.group && impactPos.distanceTo(target.group.position) < splashR) { const falloff = 1 - impactPos.distanceTo(target.group.position) / splashR; target.takeDamage(Math.round(this.activeWeapon.damage * falloff), impactPos); this.reticleRenderer.showHitmarker(target.health <= 0); } } }
            if (enemies) { for (const enemy of enemies) { if (enemy.group && impactPos.distanceTo(enemy.group.position) < splashR) { const falloff = 1 - impactPos.distanceTo(enemy.group.position) / splashR; enemy.takeDamage(Math.round(this.activeWeapon.damage * falloff), impactPos); this.reticleRenderer.showHitmarker(enemy.health <= 0); } } }
          }
        }
        this.ballisticsSystem.disposeBullet(b); this.bullets.splice(i, 1);
      }
    }
    this.impactRenderer.update(delta);
  }

  private updateAiming(delta: number): void {
    this.crosshairSpread = Math.max(0, this.crosshairSpread - 30 * delta);
    const totalSpread = this.crosshairSpread + this.movement.hSpeed() * (this.isADSActive() ? 0.1 : 0.3);
    if (!document.pointerLockElement) { this.reticleRenderer.hide(); return; }
    if (this.shouldShowSniperScope()) this.reticleRenderer.hide();
    else { this.reticleRenderer.setSpread(totalSpread); this.reticleRenderer.render(); this.reticleRenderer.show(); }
    if (this.gamepadLook.length() > 0.1) {
      const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const hits = raycaster.intersectObjects(this.getMeshes()); if (hits.length > 0 && hits[0].distance < 30) this.aimingSystem.assistAiming({ x: this.gamepadLook.x, y: this.gamepadLook.y });
    }
  }

  takeDamage(amount: number, sourcePosition?: THREE.Vector3) {
    this.health = Math.max(0, this.health - amount); soundManager.playSound('hit', 0.5);
    if (sourcePosition) this.radarRenderer.showDamageDirection(sourcePosition, this.group.position, this.euler.y);
    if (this.health <= 0) setTimeout(() => { this.body.position.set(0, 5, 0); this.movement.vel.set(0, 0, 0); this.body.velocity.set(0, 0, 0); this.health = 100; }, 2000);
  }

  updateRadar(enemies: { position: THREE.Vector3; velocity?: THREE.Vector3 }[]): void { this.radarRenderer.updateEnemies(enemies, this.group.position, this.euler.y); }
  renderRadar(): void { this.radarRenderer.render(); }

  private shoot() {
    const weapon = this.activeWeapon; const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const startPos = this.getWeaponMuzzlePosition(aimDir);
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersects = raycaster.intersectObjects(this.getMeshes());
    const targetPoint = (intersects.length > 0 && intersects[0].distance < 200) ? intersects[0].point : this.camera.position.clone().add(aimDir.clone().multiplyScalar(50));
    const pellets = weapon.bulletsPerShot, isADS = this.isADSActive(), spreadRad = (weapon.spread * (isADS ? 0.3 : 1.0) * Math.PI) / 180;
    for (let p = 0; p < pellets; p++) {
      const shotDir = this.getShotDirection(weapon, aimDir, spreadRad, p, pellets);
      const pelletTarget = pellets > 1 ? startPos.clone().add(shotDir.multiplyScalar(weapon.range)) : targetPoint;
      const velocity = BallisticsSystem.calculateParabolicVelocity(startPos, pelletTarget, weapon.bulletSpeed, Math.abs(weapon.bulletVisuals.gravity), shotDir);
      this.bullets.push(this.ballisticsSystem.createBullet(startPos, velocity, weapon.bulletVisuals));
    }
    const recoilMult = isADS ? 0.5 : 1.0;
    this.crosshairSpread = Math.min(12, this.crosshairSpread + weapon.recoil.y * 2 * recoilMult);
    this.weaponRecoilKick = Math.min(1, this.weaponRecoilKick + weapon.recoil.y * 0.25 * recoilMult);
    if (weapon.muzzleFlash) this.impactRenderer.spawnMuzzleFlash(startPos, aimDir, DEFAULT_MUZZLE_CONFIG);
    soundManager.playSound(weapon.soundId, 0.4);
    this.titanMeter = Math.min(100, this.titanMeter + 0.5); if (this.onTitanMeterChange) this.onTitanMeterChange(this.titanMeter);
  }

  private startGrapple(): void {
    if (this.isGrappling || this.grappleCooldown > 0 || this.grappleProjectileActive) return;
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera); raycaster.far = this.GRAPPLE_RANGE;
    const hits = raycaster.intersectObjects(this.getMeshes()); if (hits.length === 0) return;
    const handOffset = new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion);
    const startPos = this.camera.position.clone().add(handOffset);
    this.grappleProjectile = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.9 }));
    this.grappleProjectile.position.copy(startPos);
    this.grappleProjectileVelocity = hits[0].point.clone().sub(startPos).normalize().multiplyScalar(this.GRAPPLE_PROJECTILE_SPEED);
    this.grappleProjectileActive = true;
    const ropeGeo = new THREE.BufferGeometry(); ropeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.grappleRope = new THREE.Line(ropeGeo, new THREE.LineBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.7, linewidth: 2 }));
    this.scene.add(this.grappleRope); this.scene.add(this.grappleProjectile); this.updateWeaponHUD();
  }

  private updateGrappleProjectile(delta: number): void {
    if (!this.grappleProjectileActive || !this.grappleProjectile) return;
    this.grappleProjectileVelocity.y += this.GRAPPLE_GRAVITY * delta;
    const oldPos = this.grappleProjectile.position.clone();
    this.grappleProjectile.position.add(this.grappleProjectileVelocity.clone().multiplyScalar(delta));
    if (this.grappleRope) {
      const ropeStart = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion));
      const posAttr = this.grappleRope.geometry.attributes.position as THREE.BufferAttribute;
      posAttr.setXYZ(0, ropeStart.x, ropeStart.y, ropeStart.z); posAttr.setXYZ(1, this.grappleProjectile.position.x, this.grappleProjectile.position.y, this.grappleProjectile.position.z); posAttr.needsUpdate = true;
    }
    const dist = this.grappleProjectile.position.distanceTo(oldPos);
    if (dist > 0.01) {
      const raycaster = new THREE.Raycaster(oldPos, this.grappleProjectileVelocity.clone().normalize(), 0, dist + 0.1);
      const hits = raycaster.intersectObjects(this.getMeshes());
      if (hits.length > 0) {
        this.grappleTarget.copy(hits[0].point);
        this.scene.remove(this.grappleProjectile); this.grappleProjectile.geometry.dispose(); (this.grappleProjectile.material as THREE.Material).dispose(); this.grappleProjectile = null;
        this.grappleProjectileActive = false; this.startGrappleFromPoint(); return;
      }
    }
    if (this.grappleProjectile.position.distanceTo(this.camera.position) > this.GRAPPLE_RANGE) {
      this.scene.remove(this.grappleProjectile); this.grappleProjectile.geometry.dispose(); (this.grappleProjectile.material as THREE.Material).dispose(); this.grappleProjectile = null;
      this.grappleProjectileActive = false; this.grappleCooldown = this.GRAPPLE_COOLDOWN * 0.5;
      if (this.grappleRope) { this.scene.remove(this.grappleRope); this.grappleRope.geometry.dispose(); (this.grappleRope.material as THREE.Material).dispose(); this.grappleRope = null; }
    }
  }

  private startGrappleFromPoint(): void {
    this.isGrappling = true;
    if (this.grapplePreviewLine) { this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null; }
    if (this.grappleRope) {
      (this.grappleRope.material as THREE.LineBasicMaterial).opacity = 0.85;
      (this.grappleRope.geometry.attributes.position as THREE.BufferAttribute).setXYZ(1, this.grappleTarget.x, this.grappleTarget.y, this.grappleTarget.z); this.grappleRope.geometry.attributes.position.needsUpdate = true;
    }
    this.movement.isWallRunning = false; this.movement.isSliding = false; this.movement.isMantling = false;
    const toTarget = this.grappleTarget.clone().sub(this.group.position);
    if (toTarget.length() > 5) {
      const playerVel = this.movement.vel, toTargetNorm = toTarget.clone().normalize();
      const velTangent = playerVel.clone().sub(toTargetNorm.clone().multiplyScalar(playerVel.dot(toTargetNorm)));
      if (velTangent.length() > 1) this.movement.vel.copy(velTangent.multiplyScalar(this.GRAPPLE_TANGENT_BOOST)).add(toTargetNorm.clone().multiplyScalar(playerVel.dot(toTargetNorm)));
    }
    soundManager.playSound('grapple', 0.4); this.updateWeaponHUD();
  }

  private stopGrapple(): void {
    if (!this.isGrappling) return;
    if (this.movement.vel.length() > 5) this.movement.vel.multiplyScalar(1.15);
    this.isGrappling = false; this.grappleCooldown = this.GRAPPLE_COOLDOWN;
    if (this.grappleRope) { this.scene.remove(this.grappleRope); this.grappleRope.geometry.dispose(); (this.grappleRope.material as THREE.Material).dispose(); this.grappleRope = null; }
    this.updateWeaponHUD();
  }

  getGrappleCooldownPercent(): number { return this.grappleCooldown <= 0 ? 0 : 1 - (this.grappleCooldown / this.GRAPPLE_COOLDOWN); }
  isGrappleReady(): boolean { return this.grappleCooldown <= 0; }

  private updateGrapple(delta: number): void {
    if (this.grappleCooldown > 0) this.grappleCooldown = Math.max(0, this.grappleCooldown - delta);
    if (this.grappleProjectileActive) { this.updateGrappleProjectile(delta); return; }
    if (!this.isGrappling) return;
    const m = this.movement, playerPos = this.group.position, toTarget = this.grappleTarget.clone().sub(playerPos), dist = toTarget.length();
    if (this.grappleRope) {
      const ropeStart = playerPos.clone().add(new THREE.Vector3(0, 0.3, 0));
      const posAttr = this.grappleRope.geometry.attributes.position as THREE.BufferAttribute;
      posAttr.setXYZ(0, ropeStart.x, ropeStart.y, ropeStart.z); posAttr.setXYZ(1, this.grappleTarget.x, this.grappleTarget.y, this.grappleTarget.z); posAttr.needsUpdate = true;
    }
    if (dist < 2.0) { this.stopGrapple(); return; }
    if (this.jumpJustPressed) { this.jumpJustPressed = false; m.vel.y = Math.max(m.vel.y, 9); this.stopGrapple(); return; }
    if (!this.grappleKeyHeld) { this.stopGrapple(); return; }
    const dir = toTarget.clone().normalize();
    m.vel.add(dir.clone().multiplyScalar(this.GRAPPLE_PULL_SPEED * delta));
    const tangentialVel = m.vel.clone().sub(dir.clone().multiplyScalar(m.vel.dot(dir)));
    if (tangentialVel.length() > 2) m.vel.add(tangentialVel.clone().multiplyScalar(0.05));
    m.vel.y += this.GRAPPLE_GRAVITY * delta;
    if (m.vel.length() > 40) m.vel.multiplyScalar(40 / m.vel.length());
  }

  private throwGrenade(): void {
    if (this.grenadeCooldown > 0 || this.grenadeCount <= 0) return;
    this.grenadeCount--; this.grenadeCooldown = 0.8; this.grenadeRegenTime = 0;
    const throwDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); throwDir.y += 0.3; throwDir.normalize();
    const startPos = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion));
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshStandardMaterial({ color: 0x44ff44, emissive: 0x44ff44, emissiveIntensity: 2 }));
    mesh.position.copy(startPos); this.scene.add(mesh);
    const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(60 * 3), 3)); trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.6 }));
    this.scene.add(trail); this.grenades.push({ mesh, velocity: throwDir.multiplyScalar(20), fuseTime: 2.0, bouncesLeft: 3, trail, trailPositions: [startPos.clone()] });
    this.updateWeaponHUD();
  }

  private updateGrenades(delta: number, targets?: any[], enemies?: any[]): void {
    if (this.grenadeCooldown > 0) this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    if (this.grenadeCount < this.maxGrenades) { this.grenadeRegenTime += delta; if (this.grenadeRegenTime >= this.GRENADE_REGEN_DURATION) { this.grenadeCount++; this.grenadeRegenTime = 0; this.updateWeaponHUD(); } }
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i]; g.velocity.y -= 20 * delta; const prevPos = g.mesh.position.clone(); g.mesh.position.add(g.velocity.clone().multiplyScalar(delta));
      g.trailPositions.push(g.mesh.position.clone()); if (g.trailPositions.length > 20) g.trailPositions.shift();
      const trailArr = (g.trail.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      for (let j = 0; j < g.trailPositions.length; j++) { trailArr[j * 3] = g.trailPositions[j].x; trailArr[j * 3 + 1] = g.trailPositions[j].y; trailArr[j * 3 + 2] = g.trailPositions[j].z; }
      g.trail.geometry.attributes.position.needsUpdate = true; g.trail.geometry.setDrawRange(0, g.trailPositions.length);
      const step = g.mesh.position.clone().sub(prevPos), stepLen = step.length();
      if (stepLen > 1e-6) {
        const hits = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen + 0.05).intersectObjects(worldMeshes, false);
        if (hits.length > 0) {
          const hit = hits[0]; g.mesh.position.copy(hit.point);
          const normal = hit.face ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld) : step.clone().normalize().negate();
          if (g.bouncesLeft > 0) { g.velocity.reflect(normal).multiplyScalar(0.5); g.bouncesLeft--; g.mesh.position.add(normal.clone().multiplyScalar(0.02)); } else g.velocity.set(0, 0, 0);
        }
      }
      g.fuseTime -= delta;
      if (g.fuseTime <= 0 || g.mesh.position.y < -20) {
        if (g.fuseTime <= 0) {
          const pos = g.mesh.position.clone(); this.impactRenderer.spawnExplosion(pos, FRAG_EXPLOSION_CONFIG); soundManager.playSound('explosion', 0.6);
          const splashR = 6, damage = 100;
          if (targets) { for (const t of targets) { if (t.group && pos.distanceTo(t.group.position) < splashR) { t.takeDamage(Math.round(damage * (1 - pos.distanceTo(t.group.position) / splashR)), pos); this.reticleRenderer.showHitmarker(t.health <= 0); } } }
          if (enemies) { for (const e of enemies) { if (e.group && pos.distanceTo(e.group.position) < splashR) { const wasDead = e.health <= 0; e.takeDamage(Math.round(damage * (1 - pos.distanceTo(e.group.position) / splashR)), pos); this.reticleRenderer.showHitmarker(e.health <= 0); } } }
        }
        this.scene.remove(g.mesh); g.mesh.geometry.dispose(); (g.mesh.material as THREE.Material).dispose();
        this.scene.remove(g.trail); g.trail.geometry.dispose(); (g.trail.material as THREE.Material).dispose();
        this.grenades.splice(i, 1);
      }
    }
  }

  private updateGrenadeTrajectory(): void {
    if (!document.pointerLockElement) { if (this.grenadeTrajectoryLine) { this.scene.remove(this.grenadeTrajectoryLine); this.grenadeTrajectoryLine.geometry.dispose(); (this.grenadeTrajectoryLine.material as THREE.Material).dispose(); this.grenadeTrajectoryLine = null; } return; }
    if (!(this.grenadeHeld || this.gamepadGrenadeHeld) || this.grenadeCooldown > 0 || this.grenadeCount <= 0) { if (this.grenadeTrajectoryLine) { this.scene.remove(this.grenadeTrajectoryLine); this.grenadeTrajectoryLine.geometry.dispose(); (this.grenadeTrajectoryLine.material as THREE.Material).dispose(); this.grenadeTrajectoryLine = null; } return; }
    const throwDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); throwDir.y += 0.3; throwDir.normalize();
    const startPos = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion));
    const vel = throwDir.clone().multiplyScalar(20), gravity = -20, worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets), points: THREE.Vector3[] = [], pos = startPos.clone(), dt = 0.03;
    let bounces = 0;
    for (let i = 0; i < 150 && bounces <= 3; i++) {
      points.push(pos.clone()); const prevPos = pos.clone(); vel.y += gravity * dt; pos.add(vel.clone().multiplyScalar(dt));
      if (i < 3) continue;
      const stepLen = pos.distanceTo(prevPos);
      if (stepLen > 0.001) {
        const hits = new THREE.Raycaster(prevPos, pos.clone().sub(prevPos).normalize(), 0, stepLen + 0.05).intersectObjects(worldMeshes, false);
        if (hits.length > 0) {
          const hit = hits[0]; points.push(hit.point.clone());
          if (bounces < 3) { const normal = hit.face ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld) : pos.clone().sub(prevPos).normalize().negate(); vel.reflect(normal).multiplyScalar(0.5); pos.copy(hit.point).add(normal.multiplyScalar(0.02)); bounces++; } else break;
        }
      }
      if (pos.y < -10) break;
    }
    if (points.length < 2) points.push(startPos.clone().add(new THREE.Vector3(0, 0, -2).applyQuaternion(this.camera.quaternion)));
    if (this.grenadeTrajectoryLine) { this.scene.remove(this.grenadeTrajectoryLine); this.grenadeTrajectoryLine.geometry.dispose(); (this.grenadeTrajectoryLine.material as THREE.Material).dispose(); }
    this.grenadeTrajectoryLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.8, linewidth: 2 }));
    this.scene.add(this.grenadeTrajectoryLine);
  }

  private updateGrappleTrajectory(): void {
    if (!document.pointerLockElement) { if (this.grapplePreviewLine) { this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null; } return; }
    if (!(this.grappleKeyHeld && !this.isGrappling && this.grappleCooldown <= 0)) { if (this.grapplePreviewLine) { this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null; } return; }
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera); raycaster.far = this.GRAPPLE_RANGE;
    const hits = raycaster.intersectObjects(this.getMeshes());
    if (hits.length > 0) {
      const start = this.group.position.clone().add(new THREE.Vector3(0, 0.3, 0)), end = hits[0].point.clone();
      if (this.grapplePreviewLine) { const posAttr = this.grapplePreviewLine.geometry.attributes.position as THREE.BufferAttribute; posAttr.setXYZ(0, start.x, start.y, start.z); posAttr.setXYZ(1, end.x, end.y, end.z); posAttr.needsUpdate = true; }
      else { this.grapplePreviewLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), new THREE.LineDashedMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.5, dashSize: 1, gapSize: 0.5 })); (this.grapplePreviewLine as THREE.Line).computeLineDistances(); this.scene.add(this.grapplePreviewLine); }
    }
  }

  private baseFOV = 75;
  private adsFOV = 45;
  private currentFOV = 75;
  private syncCamera() {
    this.camera.quaternion.setFromEuler(this.euler); this.camera.position.copy(this.group.position); this.camera.position.y += 0.5;
    const isADS = this.isADSActive(), targetFOV = isADS ? (this.activeWeapon.name === 'Kraber' ? 20 : this.adsFOV) : this.baseFOV;
    this.currentFOV += (targetFOV - this.currentFOV) * 0.15; this.camera.fov = this.currentFOV; this.camera.updateProjectionMatrix();
    if (this.weaponMesh) {
      this.weaponMesh.visible = !this.shouldShowSniperScope();
      const target = isADS ? this.adsPos.clone() : this.hipfirePos.clone(), speed = this.movement.hSpeed();
      if (speed > 1 && this.movement.isGrounded) { const bobFreq = isADS ? 6 : 10, bobAmpX = isADS ? 0.002 : 0.008, bobAmpY = isADS ? 0.002 : 0.006; this.weaponBobTime += speed * 0.06; target.x += Math.sin(this.weaponBobTime * bobFreq) * bobAmpX; target.y += Math.abs(Math.sin(this.weaponBobTime * bobFreq * 0.5)) * bobAmpY; }
      else this.weaponBobTime *= 0.95;
      const swayAmount = isADS ? 0.0005 : 0.002 * this.activeWeapon.accuracy, t = performance.now() * 0.001;
      this.weaponSwayX += (Math.sin(t * 1.1) * swayAmount - this.weaponSwayX) * 0.05; this.weaponSwayY += (Math.cos(t * 0.9) * swayAmount - this.weaponSwayY) * 0.05;
      target.x += this.weaponSwayX; target.y += this.weaponSwayY;
      this.weaponRecoilKick *= 0.85; target.z += this.weaponRecoilKick * 0.06; target.y += this.weaponRecoilKick * 0.01;
      this.weaponViewOffset.lerp(target, 0.15); this.syncWeaponMeshToCamera();
    }
  }

  private updateWeaponHUD(): void {
    let container = document.getElementById('weapon-hud');
    if (!container) { container = document.createElement('div'); container.id = 'weapon-hud'; container.style.cssText = 'position:fixed;bottom:80px;right:20px;color:#fff;font:13px monospace;z-index:100;background:rgba(0,0,0,0.6);padding:8px 12px;border-radius:4px;line-height:1.6;text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px #000;'; document.body.appendChild(container); }
    const idx = this.weaponManager.getCurrentIndex(), ammo = this.weaponManager.getCurrentAmmo(), mag = this.weaponManager.getEffectiveMagazineSize(this.activeWeapon), reloading = this.weaponManager.isReloading();
    const weaponList = this.weaponManager.getAllWeapons().map((w, i) => `<span style="color:${i === idx ? '#00ffcc' : '#666'}">${i === idx ? '>' : ' '} ${i + 1}. ${w.name}</span>`).join('<br>');
    
    // Attachments display
    const atts = this.activeWeapon.attachments;
    const attList = [atts.optic?.name, atts.barrel?.name, atts.magazine?.name].filter(Boolean).join(', ');
    const attText = attList ? `<br><span style="color:#aaa;font-size:11px;">[${attList}]</span>` : '';

    const ammoText = reloading ? `<span style="color:#ffaa00">RELOADING</span>` : `<span style="color:${ammo === 0 ? '#ff4444' : '#fff'}">${ammo} / ${mag}</span>`;
    const grappleReady = this.grappleCooldown <= 0 && !this.grappleProjectileActive;
    const grappleColor = this.isGrappling ? '#00ffcc' : grappleReady ? '#88cc88' : '#666';
    const grappleLabel = this.isGrappling ? 'GRAPPLING' : this.grappleProjectileActive ? 'HOOKING...' : grappleReady ? 'READY' : `${this.grappleCooldown.toFixed(1)}s`;
    const grappleProgress = grappleReady ? '' : `<div style="width:100%;height:3px;background:#333;margin-top:2px;"><div style="width:${Math.max(5, (1 - this.grappleCooldown / this.GRAPPLE_COOLDOWN) * 100)}%;height:100%;background:${grappleColor};transition:width 0.1s;"></div></div>`;
    container.innerHTML = `${weaponList}${attText}<br><br>${ammoText}<br><span style="color:${this.grenadeCount > 0 ? '#88cc88' : '#ff4444'}">G: ${this.grenadeCount}</span><br><span style="color:${grappleColor}">Q: ${grappleLabel}</span>${grappleProgress}`;
  }

  private updateUI() {
    let el = document.getElementById("debug-speed");
    if (!el) { el = document.createElement("div"); el.id = "debug-speed"; el.style.cssText = "position:fixed;top:20px;right:20px;color:#0f0;font:14px monospace;z-index:100;background:rgba(0,0,0,0.7);padding:8px;line-height:1.5;"; document.body.appendChild(el); }
    const m = this.movement, state = m.isMantling ? "MANTLE" : m.isSliding ? "SLIDE" : m.isWallRunning ? "WALLRUN" : m.isGrounded ? "GROUND" : "AIR";
    el.innerHTML = `Speed: ${m.hSpeed().toFixed(1)}<br>State: ${state}<br>Vel: ${m.vel.x.toFixed(1)}, ${m.vel.y.toFixed(1)}, ${m.vel.z.toFixed(1)}<br>Jumps: ${m.jumpCount}<br><span style="color:${(this.keys.sprint || this.gamepadSprint) ? "#00ff00" : "#888888"}">SPRINT: ${(this.keys.sprint || this.gamepadSprint) ? "ON" : "off"}</span> | Crouch: ${this.keys.crouch || this.gamepadCrouch}`;
  }
}

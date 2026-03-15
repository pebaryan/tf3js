import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Target } from './target';
import { Enemy } from './enemy';
import { createLevel } from './level';
import { LevelType, Level, LEVELS } from './levels';
import { Player } from './player';
import { Titan, TitanState } from './titan';
import { GameState, GameStats } from './types';
import { GameUI } from './ui';
import { Weapon, EVA8_WEAPON, KRABER_WEAPON, EPG_WEAPON, ALTERNATOR_WEAPON, CAR_WEAPON, FLATLINE_WEAPON, MASTIFF_WEAPON, WINGMAN_WEAPON, LSTAR_WEAPON } from './weapons';
import { getBindings, keyCodeToLabel } from './keybindings';
// import { soundManager } from './sound';

interface WeaponPickup {
  weapon: Weapon;
  mesh: THREE.Group;
  position: THREE.Vector3;
  baseY: number;
  cooldown: number;
}


export class Game {
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  player!: Player;
  world!: CANNON.World;
  clock!: THREE.Clock;
  targets: Target[] = [];
  enemies: Enemy[] = [];
  capturePoints: any[] = [];
  checkpoints: any[] = [];
  titan: Titan | null = null;
  private weaponPickups: WeaponPickup[] = [];
  private pickupPromptEl: HTMLElement | null = null;
  private activePickupHold: WeaponPickup | null = null;
  private activePickupHoldTime = 0;
  private readonly PICKUP_RANGE = 2;
  private readonly PICKUP_PROMPT_RANGE = 4;
  private readonly PICKUP_HOLD_TIME = 0.35;

  state: GameState = GameState.MAIN_MENU;
  currentLevel: Level | null = null;
  stats: GameStats;
  levelStartTime: number = 0;
  scoreMultiplier: number = 1;
  levels: Level[] = LEVELS;

  private gameContainer: HTMLElement;
  private ambientLight!: THREE.AmbientLight;
  private directionalLight!: THREE.DirectionalLight;
  private ui: GameUI;

  private capturedTime = 0;
  private checkpointProgress = 0;
  private lastEmbarkIndicatorState = false;

  constructor(containerId: string) {
    this.gameContainer = document.getElementById(containerId) || document.body;
    this.stats = {
      level: 1,
      score: 0,
      kills: 0,
      time: 0,
      objectivesCompleted: 0,
      titanMeter: 0,
      health: 100
    };

    this.ui = new GameUI();
    this.initScene();
    this.ui.init(
      () => { if (this.state === GameState.PLAYING || this.state === GameState.PAUSED) this.togglePause(); },
      () => { if (this.state === GameState.PLAYING) this.callTitan(); }
    );
    this.showMainMenu();
    this.animate();
  }

  private initScene() {
    this.clock = new THREE.Clock();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0a1e, 80, 300);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 2, 0);
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.gameContainer.appendChild(this.renderer.domElement);

    // Sky dome
    this.createSkyDome();

    // Hemisphere light: sky blue from above, ground warm from below
    const hemiLight = new THREE.HemisphereLight(0x334466, 0x221122, 0.6);
    this.scene.add(hemiLight);

    this.ambientLight = new THREE.AmbientLight(0x404060, 0.4);
    this.scene.add(this.ambientLight);

    // Sun-like directional light — warm orange tint, lower angle for dramatic shadows
    this.directionalLight = new THREE.DirectionalLight(0xffd4a0, 1.4);
    this.directionalLight.position.set(-40, 60, -50);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 2048;
    this.directionalLight.shadow.mapSize.height = 2048;
    this.directionalLight.shadow.camera.near = 10;
    this.directionalLight.shadow.camera.far = 200;
    this.directionalLight.shadow.camera.left = -50;
    this.directionalLight.shadow.camera.right = 50;
    this.directionalLight.shadow.camera.top = 50;
    this.directionalLight.shadow.camera.bottom = -50;
    this.scene.add(this.directionalLight);

    this.world = new CANNON.World();
    this.world.gravity.set(0, 0, 0);

    window.addEventListener('resize', () => this.onWindowResize());
  }

  private createSkyDome() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    // Gradient: horizon warm haze → mid deep blue → zenith dark purple
    const grad = ctx.createLinearGradient(0, 512, 0, 0);
    grad.addColorStop(0.0, '#1a1018');   // horizon — warm dark
    grad.addColorStop(0.15, '#2a1428');  // low — reddish haze
    grad.addColorStop(0.35, '#0e1030');  // mid-low — deep navy
    grad.addColorStop(0.6, '#0a0c28');   // mid — dark blue
    grad.addColorStop(1.0, '#060818');   // zenith — near black

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);

    // Scatter stars in upper half
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 350; // upper 70%
      const r = Math.random() * 1.2 + 0.3;
      const brightness = Math.floor(Math.random() * 100 + 155);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${brightness}, ${brightness}, ${Math.min(255, brightness + 40)}, ${0.4 + Math.random() * 0.6})`;
      ctx.fill();
    }

    // A few brighter stars
    for (let i = 0; i < 15; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 256;
      ctx.beginPath();
      ctx.arc(x, y, Math.random() * 1.5 + 1, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 230, 255, ${0.6 + Math.random() * 0.4})`;
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = texture;
  }

  callTitan(): void {
    if (!this.player || this.stats.titanMeter < 100) return;

    if (this.titan && this.titan.state !== TitanState.INACTIVE && this.titan.state !== TitanState.DESTROYED) {
      return;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);

    const meshes: THREE.Object3D[] = [];
    this.scene.traverse((child) => {
      if ((child instanceof THREE.Mesh || child instanceof THREE.Group) && child !== this.titan?.group) {
        meshes.push(child);
      }
    });

    const intersects = raycaster.intersectObjects(meshes);
    let spawnPos: THREE.Vector3;

    if (intersects.length > 0 && intersects[0].distance < 100) {
      spawnPos = intersects[0].point;
    } else {
      const playerPos = this.player.group.position.clone();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.group.quaternion);
      spawnPos = playerPos.clone().add(forward.multiplyScalar(20));
      spawnPos.y = 0;
    }

    this.createTitanCallAnimation(spawnPos);

    this.titan = new Titan(this.scene, this.world, spawnPos);
    this.titan.call(spawnPos);

    // Reset titan meter in both stats and player
    this.stats.titanMeter = 0;
    this.player?.resetTitanMeter();
    this.addScore(500);
  }

  embarkTitan(): void {
    console.log('embarkTitan called');
    if (!this.player || !this.titan) {
      console.log('embarkTitan: No player or titan');
      return;
    }
    
    // Check if player is close to the titan (within 3 meters)
    const distance = this.player.group.position.distanceTo(this.titan.group.position);
    console.log('embarkTitan: Distance to titan:', distance, 'meters');
    if (distance > 3) {
      console.log('embarkTitan: Too far from titan');
      return;
    }
    
    // Check if titan is ready to be embarked
    console.log('embarkTitan: Titan state:', this.titan.state);
    if (this.titan.state !== TitanState.READY) {
      console.log('embarkTitan: Titan not ready');
      return;
    }
    
    console.log('embarkTitan: Success! Entering titan...');
    // Enter the titan
    this.titan.enter();
    
    // Hide player model and enable piloting mode
    this.player.group.visible = false;
    this.player.setPilotingState(true);
  }

  disembarkTitan(): void {
    if (!this.player || !this.titan) return;
    
    // Only disembark if currently piloting
    if (this.titan.state !== TitanState.PILOTING) return;
    
    // Exit the titan
    this.titan.exit();
    
    // Position player near the titan when exiting
    const titanPos = this.titan.group.position.clone();
    const exitOffset = new THREE.Vector3(0, 0, 4).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.titan.group.rotation.y
    );
    this.player.body.position.set(
      titanPos.x + exitOffset.x,
      titanPos.y + 0.5,
      titanPos.z + exitOffset.z
    );
    
    // Show player model again and disable piloting mode
    this.player.group.visible = true;
    this.player.setPilotingState(false);
    
    // Reset player velocity with slight upward boost (ejection)
    this.player.setVelocity(exitOffset.x * 2, 5, exitOffset.z * 2);
  }

  private createTitanCallAnimation(position: THREE.Vector3): void {
    const ringGeo = new THREE.RingGeometry(0.5, 1, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);

    ring.position.copy(position);
    ring.position.y = 0.1;
    ring.rotation.x = -Math.PI / 2;
    ring.rotation.z = Math.random() * Math.PI * 2;

    this.scene.add(ring);

    const startTime = Date.now();
    const duration = 2000;

    const animateRing = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;

      if (progress >= 1) {
        this.scene.remove(ring);
        ring.geometry.dispose();
        ringMat.dispose();
        return;
      }

      const scale = 1 + progress * 20;
      ring.scale.set(scale, scale, 1);
      ringMat.opacity = 0.8 * (1 - progress);
      ring.rotation.z += 0.05;

      requestAnimationFrame(animateRing);
    };

    animateRing();

    setTimeout(() => {
      const ring2 = ring.clone();
      ring2.material = ringMat.clone();
      this.scene.add(ring2);

      const startTime2 = Date.now();
      const animateRing2 = () => {
        const elapsed = Date.now() - startTime2;
        const progress = elapsed / duration;

        if (progress >= 1) {
          this.scene.remove(ring2);
          ring2.geometry.dispose();
          (ring2.material as THREE.Material).dispose();
          return;
        }

        const scale = 1 + progress * 20;
        ring2.scale.set(scale, scale, 1);
        (ring2.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - progress);
        ring2.rotation.z -= 0.05;

        requestAnimationFrame(animateRing2);
      };

      animateRing2();
    }, 300);
  }

  startGame(levelId: number = 1) {
    this.state = GameState.PLAYING;
    this.currentLevel = this.levels.find(l => l.id === levelId) || this.levels[0];
    this.stats.level = levelId;
    this.stats.score = 0;
    this.stats.kills = 0;
    this.stats.time = 0;
    this.stats.objectivesCompleted = 0;
    this.stats.titanMeter = 0;
    this.stats.health = 100;
    this.levelStartTime = Date.now();
    this.scoreMultiplier = 1;
    this.targets = [];
    this.enemies = [];
    this.capturePoints = [];
    this.checkpoints = [];
    this.capturedTime = 0;
    this.checkpointProgress = 0;
    this.weaponPickups = [];

    // Clear existing scene (keep lights)
    const children = [...this.scene.children];
    children.forEach(child => {
      if (child !== this.ambientLight && child !== this.directionalLight) {
        this.scene.remove(child);
      }
    });
    while (this.world.bodies.length > 0) {
      this.world.removeBody(this.world.bodies[0]);
    }

    if (this.titan) {
      this.titan.dispose();
      this.titan = null;
    }

    createLevel(this.scene, this.world, this.currentLevel);

    console.log('[Game] Creating player...');
    this.player = new Player(this.camera, this.scene, this.world);
    console.log('[Game] Player created, group children:', this.player.group.children.length);
    this.player.setTitanMeterCallback((meter) => {
      this.stats.titanMeter = meter;
    });
    this.player.setCallTitanCallback(() => {
      this.callTitan();
    });
    this.player.setEmbarkTitanCallback(() => {
      this.embarkTitan();
    });
    this.player.setDisembarkTitanCallback(() => {
      this.disembarkTitan();
    });
    this.player.setPauseCallback(() => {
      this.togglePause();
    });
    this.player.setTitanControlCallback((forward, right, lookX, lookY, fire, dash) => {
      if (this.titan) {
        this.titan.setPilotInput(forward, right, lookX, lookY, fire, dash);
      }
    });
    this.scene.add(this.player.group);

    this.spawnWeaponPickups();

    if (this.currentLevel.type === LevelType.TRAINING || this.currentLevel.type === LevelType.CAPTURE) {
      for (let i = 0; i < this.currentLevel.targetCount; i++) {
        const x = (i % 3) * 8 - 8;
        const z = Math.floor(i / 3) * 8 + 40;
        this.targets.push(new Target(this.scene, this.world, x, 0, z));
      }
    }

    this.setupObjectives();
    this.player.lockPointer();

    this.renderer.domElement.addEventListener('click', () => {
      if (this.state === GameState.PLAYING && !document.pointerLockElement) {
        this.player.lockPointer();
      }
    });

    this.ui.hideMenus();
  }

  private setupObjectives() {
    switch (this.currentLevel!.type) {
      case LevelType.CAPTURE:
        this.setupCapturePoints();
        break;
      case LevelType.RACE:
        this.setupCheckpoints();
        break;
      case LevelType.SURVIVAL:
        this.setupEnemies();
        break;
    }
    this.updateHUD();
  }

  private setupCapturePoints() {
    this.capturePoints = [
      { position: new THREE.Vector3(-15, 1, 30), captured: false, timer: 0 },
      { position: new THREE.Vector3(0, 1, 30), captured: false, timer: 0 },
      { position: new THREE.Vector3(15, 1, 30), captured: false, timer: 0 }
    ];

    const pointGeo = new THREE.ConeGeometry(2, 3, 8);
    const pointMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    this.capturePoints.forEach(point => {
      const mesh = new THREE.Mesh(pointGeo, pointMat);
      mesh.position.copy(point.position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    });
  }

  private setupCheckpoints() {
    const checkpointGeo = new THREE.RingGeometry(3, 3.5, 32);
    const checkpointMat = new THREE.MeshStandardMaterial({ color: 0x00ffcc, side: THREE.DoubleSide });

    this.checkpoints = [
      { position: new THREE.Vector3(0, 2, -20), completed: false },
      { position: new THREE.Vector3(10, 2, -40), completed: false },
      { position: new THREE.Vector3(-10, 2, -60), completed: false },
      { position: new THREE.Vector3(0, 2, -80), completed: false }
    ];

    this.checkpoints.forEach((checkpoint, index) => {
      const mesh = new THREE.Mesh(checkpointGeo, checkpointMat);
      mesh.position.copy(checkpoint.position);
      this.scene.add(mesh);

      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#00ffcc';
      ctx.font = 'bold 64px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((index + 1).toString(), 64, 64);

      const tex = new THREE.CanvasTexture(canvas);
      const numGeo = new THREE.PlaneGeometry(2, 2);
      const numMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
      const numMesh = new THREE.Mesh(numGeo, numMat);
      numMesh.position.set(checkpoint.position.x, checkpoint.position.y + 3, checkpoint.position.z);
      numMesh.lookAt(new THREE.Vector3(0, 0, 1));
      this.scene.add(numMesh);
    });
  }

  private setupEnemies() {
    for (let i = 0; i < this.currentLevel!.enemyCount; i++) {
      const x = (i % 3) * 10 - 10;
      const z = Math.floor(i / 3) * 10 - 30;
      const position = new THREE.Vector3(x, 1.8, z);

      const diff = 0.3 + Math.random() * 0.4; // 0.3-0.7
      const enemy = new Enemy(this.scene, this.world, position, {
        health: 50,
        speed: 1.5,
        aggressive: false,
        attackCooldown: 2,
        difficulty: diff,
      });

      this.enemies.push(enemy);
    }
  }

  update(delta: number) {
    if (!this.player || !this.currentLevel) return;

    this.world.step(1 / 60, delta, 4);

    this.player.update(delta, this.targets, this.enemies);
    this.targets.forEach(target => target.update(delta, this.camera.position));

    // Update radar with enemy positions
    const enemyData = this.enemies.map(e => ({
      position: e.group.position.clone(),
      velocity: e.body?.velocity ? new THREE.Vector3(e.body.velocity.x, e.body.velocity.y, e.body.velocity.z) : undefined
    }));
    this.player.updateRadar(enemyData);
    this.player.renderRadar();

    this.updateObjectives(delta);
    this.updateEnemies(delta);

    if (this.titan) {
      this.titan.update(delta, this.targets, this.enemies);
      this.titan.updatePhysicsPosition();

      // Check if player is near titan and can embark, or if piloting
      if (this.player) {
        const distance = this.player.group.position.distanceTo(this.titan.group.position);
        const canEmbark = this.titan.state === TitanState.READY && distance <= 3;
        const isPiloting = this.titan.state === TitanState.PILOTING || this.titan.state === TitanState.ENTERING;
        
        // Only log when state changes to avoid spam
        if (canEmbark !== this.lastEmbarkIndicatorState) {
          console.log('Embark check - State:', this.titan.state, 'Distance:', distance.toFixed(2), 'Can embark:', canEmbark, 'Is piloting:', isPiloting);
          this.lastEmbarkIndicatorState = canEmbark;
        }
        
        this.ui.showEmbarkIndicator(canEmbark);
        this.ui.showPilotingIndicator(isPiloting);
        if (isPiloting) {
          this.player.syncToTitan(this.titan.group.position, this.titan.group.rotation.y);
        }
        
        // When piloting, sync camera to titan cockpit
        if (this.titan.state === TitanState.PILOTING) {
          const cockpit = this.titan.getCockpitCamera();
          this.camera.position.copy(cockpit.position);
          this.camera.rotation.set(cockpit.rotation.x, cockpit.rotation.y, cockpit.rotation.z, 'YXZ');
        }
      } else {
        this.ui.showEmbarkIndicator(false);
        this.ui.showPilotingIndicator(false);
        this.lastEmbarkIndicatorState = false;
      }

      const shakeIntensity = this.titan.getShakeIntensity();
      if (shakeIntensity > 0.01) {
        this.camera.position.x += (Math.random() - 0.5) * shakeIntensity * 0.3;
        this.camera.position.y += (Math.random() - 0.5) * shakeIntensity * 0.3;
      }
    } else {
      this.ui.showEmbarkIndicator(false);
    }

    this.updateWeaponPickups(delta);
    this.updateHUD();
    this.checkLevelCompletion();
    this.stats.time = (Date.now() - this.levelStartTime) / 1000;
  }

  private spawnWeaponPickups() {
    // Pickup positions: scattered across the level
    const pickupDefs: { weapon: Weapon; pos: THREE.Vector3 }[] = [
      { weapon: EVA8_WEAPON, pos: new THREE.Vector3(-7, 1.5, -35) },
      { weapon: KRABER_WEAPON, pos: new THREE.Vector3(7, 1.5, -35) },
      { weapon: EPG_WEAPON, pos: new THREE.Vector3(0, 0.5, -55) },
      { weapon: ALTERNATOR_WEAPON, pos: new THREE.Vector3(-12, 1.5, -20) },
      { weapon: CAR_WEAPON, pos: new THREE.Vector3(12, 1.5, -20) },
      { weapon: FLATLINE_WEAPON, pos: new THREE.Vector3(-10, 1.5, -50) },
      { weapon: MASTIFF_WEAPON, pos: new THREE.Vector3(10, 1.5, -50) },
      { weapon: WINGMAN_WEAPON, pos: new THREE.Vector3(-5, 1.5, -70) },
      { weapon: LSTAR_WEAPON, pos: new THREE.Vector3(5, 1.5, -70) },
    ];

    for (const def of pickupDefs) {
      const pickup = this.createPickupMesh(def.weapon, def.pos);
      this.weaponPickups.push(pickup);
    }
  }

  private createPickupMesh(weapon: Weapon, position: THREE.Vector3): WeaponPickup {
    const group = new THREE.Group();
    const color = weapon.bulletVisuals.color;

    // Weapon indicator box
    const boxGeo = new THREE.BoxGeometry(0.12, 0.08, 0.35);
    const boxMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.9,
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.y = 0.5;
    group.add(box);

    // Base ring glow
    const ringGeo = new THREE.TorusGeometry(0.3, 0.03, 8, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    // Vertical light beam
    const beamGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.5, 6);
    const beamMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.15,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = 0.75;
    group.add(beam);

    group.position.copy(position);
    this.scene.add(group);

    return {
      weapon,
      mesh: group,
      position: position.clone(),
      baseY: position.y,
      cooldown: 0,
    };
  }

  private rebuildPickupMesh(pickup: WeaponPickup) {
    // Remove old mesh children
    while (pickup.mesh.children.length > 0) {
      const child = pickup.mesh.children[0];
      pickup.mesh.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    this.scene.remove(pickup.mesh);

    // Create new pickup with updated weapon
    const newPickup = this.createPickupMesh(pickup.weapon, pickup.position);
    pickup.mesh = newPickup.mesh;
  }

  private updateWeaponPickups(delta: number) {
    if (!this.player) return;

    const time = performance.now() * 0.001;
    let nearestPickup: WeaponPickup | null = null;
    let nearestDist = Infinity;

    for (const pickup of this.weaponPickups) {
      // Cooldown
      if (pickup.cooldown > 0) {
        pickup.cooldown -= delta;
        pickup.mesh.visible = pickup.cooldown <= 0;
        if (pickup.cooldown > 0) continue;
      }

      // Animate: rotate + bob
      pickup.mesh.rotation.y += 1.5 * delta;
      pickup.mesh.position.y = pickup.baseY + Math.sin(time * 2) * 0.1;

      // Distance check
      const dist = this.player.group.position.distanceTo(pickup.position);

      // Track nearest for prompt
      if (dist < this.PICKUP_PROMPT_RANGE && dist < nearestDist) {
        nearestDist = dist;
        nearestPickup = pickup;
      }
    }

    const canHoldPickup = !!nearestPickup &&
      nearestDist < this.PICKUP_RANGE &&
      this.player.isInteractHeld() &&
      !this.player.isInteractConsumed();

    if (canHoldPickup && nearestPickup) {
      const pickup = nearestPickup;

      if (this.activePickupHold !== pickup) {
        this.activePickupHold = pickup;
        this.activePickupHoldTime = 0;
      }

      this.activePickupHoldTime = Math.min(this.PICKUP_HOLD_TIME, this.activePickupHoldTime + delta);

      if (this.activePickupHoldTime >= this.PICKUP_HOLD_TIME) {
        const dropped = this.player.tryPickupWeapon(pickup.weapon);
        if (dropped) {
          pickup.weapon = dropped;
          this.rebuildPickupMesh(pickup);
          pickup.cooldown = 0.5;
          pickup.mesh.visible = false;
          this.player.consumeInteractHold();
          nearestPickup = null;
        }
        this.activePickupHold = null;
        this.activePickupHoldTime = 0;
      }
    } else {
      this.activePickupHold = null;
      this.activePickupHoldTime = 0;
    }

    const holdProgress = this.activePickupHold === nearestPickup && nearestPickup
      ? this.activePickupHoldTime / this.PICKUP_HOLD_TIME
      : 0;

    this.updatePickupPrompt(nearestPickup, holdProgress);
  }

  private updatePickupPrompt(pickup: WeaponPickup | null, holdProgress: number) {
    if (!pickup) {
      if (this.pickupPromptEl) {
        this.pickupPromptEl.style.display = 'none';
      }
      return;
    }

    if (!this.pickupPromptEl) {
      this.pickupPromptEl = document.createElement('div');
      this.pickupPromptEl.style.cssText =
        'position:fixed;bottom:180px;left:50%;transform:translateX(-50%);' +
        'color:#fff;font:14px monospace;z-index:100;' +
        'background:rgba(0,0,0,0.6);padding:6px 14px;border-radius:4px;' +
        'text-align:center;pointer-events:none;';
      document.body.appendChild(this.pickupPromptEl);
    }

    this.pickupPromptEl.style.display = 'block';
    const color = '#' + pickup.weapon.bulletVisuals.color.toString(16).padStart(6, '0');
    const interactKey = keyCodeToLabel(getBindings().embark);
    const progressPct = Math.round(holdProgress * 100);
    const progressBar = `
      <div style="margin-top:6px;width:220px;height:6px;background:rgba(255,255,255,0.15);border-radius:999px;overflow:hidden;">
        <div style="width:${progressPct}%;height:100%;background:${color};"></div>
      </div>
    `;
    this.pickupPromptEl.innerHTML =
      `Hold [${interactKey}] / X to pick up <span style="color:${color}">${pickup.weapon.name}</span>${progressBar}`;
  }

  private updateObjectives(delta: number) {
    switch (this.currentLevel!.type) {
      case LevelType.CAPTURE:
        this.capturePoints.forEach(point => {
          if (this.player.group.position.distanceTo(point.position) < 3) {
            point.captured = true;
            point.timer += delta;
            if (point.timer >= 3) this.capturedTime += delta;
          } else {
            point.captured = false;
          }
        });
        break;

      case LevelType.RACE:
        const playerPos = this.player.group.position;
        for (let i = 0; i < this.checkpoints.length; i++) {
          if (!this.checkpoints[i].completed &&
              playerPos.distanceTo(this.checkpoints[i].position) < 4) {
            this.checkpoints[i].completed = true;
            this.checkpointProgress = i + 1;
            this.addScore(200);
            if (i === this.checkpoints.length - 1) this.stats.objectivesCompleted++;
          }
        }
        break;

      case LevelType.SURVIVAL:
        if (this.enemies.length < this.currentLevel!.enemyCount * 2 &&
            Math.random() < delta * 0.01) {
          this.spawnEnemy();
        }
        break;
    }
  }

  private spawnEnemy() {
    const spawnPoints = [
      new THREE.Vector3(30, 0, -30),
      new THREE.Vector3(-30, 0, -30),
      new THREE.Vector3(30, 0, 30),
      new THREE.Vector3(-30, 0, 30)
    ];

    const point = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];

    const diff = 0.3 + Math.random() * 0.5;
    this.enemies.push(new Enemy(this.scene, this.world, point.clone(), {
      health: 50,
      speed: 1.5 + Math.random() * 1.0,
      aggressive: true,
      attackCooldown: 2 + Math.random() * 2,
      difficulty: diff,
    }));
  }

  private getWorldMeshes(): THREE.Mesh[] {
    return this.scene.children.filter((o) => {
      if (!(o instanceof THREE.Mesh)) return false;
      const mat = o.material;
      if (Array.isArray(mat)) {
        if (mat.some((m) => (m as THREE.Material).transparent)) return false;
      } else if ((mat as THREE.Material).transparent) {
        return false;
      }
      return true;
    }) as THREE.Mesh[];
  }

  private updateEnemies(delta: number) {
    const playerPos = this.player.group.position;
    const cameraPos = this.camera.position;
    const worldMeshes = this.getWorldMeshes();

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];

      // AI update: state machine, movement, shooting
      const playerVel = this.player.getVelocity();
      enemy.update(delta, cameraPos, playerPos, worldMeshes, playerVel);

      // Check enemy bullets hitting player
      for (let j = enemy.bullets.length - 1; j >= 0; j--) {
        const b = enemy.bullets[j];
        const bPos = b.mesh.position;
        const dx = bPos.x - playerPos.x;
        const dy = bPos.y - (playerPos.y + 0.5); // player center
        const dz = bPos.z - playerPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < 0.5 * 0.5) {
          this.player.takeDamage(8, bPos.clone());
          // Dispose this bullet
          this.scene.remove(b.mesh);
          b.mesh.geometry.dispose();
          (b.mesh.material as THREE.Material).dispose();
          if (b.trail) {
            this.scene.remove(b.trail);
            b.trail.geometry.dispose();
            (b.trail.material as THREE.Material).dispose();
          }
          enemy.bullets.splice(j, 1);
        }
      }

      // Check enemy death
      if (enemy.health <= 0) {
        enemy.dispose();
        this.enemies.splice(i, 1);
        this.addScore(100);
        this.stats.kills++;
      }
    }
  }

  addScore(amount: number) {
    this.stats.score += amount * this.scoreMultiplier;
    this.scoreMultiplier = Math.min(2, this.scoreMultiplier + 0.05);
  }

  private checkLevelCompletion() {
    if (!this.currentLevel) return;

    switch (this.currentLevel.type) {
      case LevelType.TRAINING:
        if (this.targets.filter(t => t.health <= 0).length >= this.currentLevel.targetCount) {
          this.completeLevel();
        }
        break;

      case LevelType.CAPTURE:
        if (this.capturedTime >= 30) {
          this.stats.objectivesCompleted++;
          this.completeLevel();
        }
        break;

      case LevelType.RACE:
        if (this.checkpointProgress >= this.checkpoints.length) {
          this.stats.objectivesCompleted++;
          this.completeLevel();
        }
        break;

      case LevelType.SURVIVAL:
        if (this.stats.time >= (this.currentLevel.timeLimit || 0)) {
          this.stats.objectivesCompleted++;
          this.completeLevel();
        }
        break;
    }

    if (this.currentLevel.timeLimit && this.stats.time >= this.currentLevel.timeLimit) {
      if (this.currentLevel.type !== LevelType.SURVIVAL) this.failLevel();
    }

    if (this.player.health <= 0) this.failLevel();
  }

  private completeLevel() {
    this.state = GameState.LEVEL_COMPLETE;
    const nextLevel = this.levels.find(l => l.id === this.currentLevel!.id + 1);
    this.ui.showLevelComplete(
      this.stats,
      () => nextLevel ? this.startGame(nextLevel.id) : this.showMainMenu(),
      () => this.startGame(this.currentLevel!.id),
      () => this.showMainMenu()
    );
  }

  private failLevel() {
    this.state = GameState.GAME_OVER;
    this.ui.showGameOver(
      this.stats,
      () => this.startGame(this.currentLevel!.id),
      () => this.showMainMenu()
    );
  }

  private updateHUD() {
    if (this.state !== GameState.PLAYING || !this.currentLevel) return;
    const isPilotingTitan = !!this.titan &&
      (this.titan.state === TitanState.PILOTING || this.titan.state === TitanState.ENTERING);
    const titanDashMeter = this.titan ? this.titan.getDashMeter() : 100;
    this.ui.updateHUD({
      currentLevel: this.currentLevel,
      stats: this.stats,
      scoreMultiplier: this.scoreMultiplier,
      playerHealth: this.player.health,
      titanDashMeter,
      isPilotingTitan,
      capturePoints: this.capturePoints,
      capturedTime: this.capturedTime,
      checkpoints: this.checkpoints,
      checkpointProgress: this.checkpointProgress,
      enemyCount: this.enemies.length,
      destroyedTargets: this.targets.filter(t => t.health <= 0).length,
      showSniperScope: this.player.shouldShowSniperScope(),
    });
  }

  togglePause() {
    if (this.state === GameState.PLAYING) {
      this.state = GameState.PAUSED;
      document.body.style.cursor = 'auto';
      this.ui.showPause(
        () => this.togglePause(),
        () => this.startGame(this.currentLevel!.id),
        () => this.showMainMenu()
      );
    } else if (this.state === GameState.PAUSED) {
      this.state = GameState.PLAYING;
      this.ui.hidePause();
      this.player.lockPointer();
    }
  }

  showMainMenu() {
    this.state = GameState.MAIN_MENU;
    this.ui.showMainMenu(this.levels, (id) => this.startGame(id));
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate() {
    if (this.state === GameState.PLAYING) {
      const delta = Math.min(this.clock.getDelta(), 0.05);
      this.update(delta);
    } else {
      this.ui.updateMenuNavigation(this.state);
    }

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.animate());
  }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Target } from './target';
import { Enemy } from './enemy';
import { createLevel, updateLevelVisuals } from './level';
import { LevelType, Level, LEVELS } from './levels';
import { Player, createWeaponMesh } from './player';
import { Titan, TitanState } from './titan';
import { GameState, GameStats } from './types';
import { GameUI } from './ui';
import { Weapon, Attachment, ATTACHMENTS, cloneWeapon, EVA8_WEAPON, KRABER_WEAPON, EPG_WEAPON, ALTERNATOR_WEAPON, CAR_WEAPON, FLATLINE_WEAPON, MASTIFF_WEAPON, WINGMAN_WEAPON, LSTAR_WEAPON } from './weapons';
import { getBindings, keyCodeToLabel } from './keybindings';
import { disposeObject3D } from './collision';
import { GraphicsPipeline } from './graphics';
import { GraphicsQuality, getGraphicsQuality, setGraphicsQuality } from './graphicsSettings';

interface WeaponPickup {
  weapon: Weapon;
  mesh: THREE.Group;
  position: THREE.Vector3;
  baseY: number;
  cooldown: number;
}

interface AttachmentPickup {
  attachment: Attachment;
  mesh: THREE.Group;
  position: THREE.Vector3;
  baseY: number;
  taken: boolean;
}

export interface CapturePoint {
  position: THREE.Vector3;
  captured: boolean;
  timer: number;
}

export interface Checkpoint {
  position: THREE.Vector3;
  completed: boolean;
}

/** Seconds a capture point must be held before it starts contributing to the objective. */
const CAPTURE_LOCK_TIME = 3;
/** Total hold time needed to win a capture level. */
const CAPTURE_WIN_TIME = 30;
const CAPTURE_RADIUS = 3;
const CHECKPOINT_RADIUS = 4;
const TITAN_EMBARK_RANGE = 3;
/** Enemy bullet damage applied to the pilot (titan hull takes the same, shields first). */
const ENEMY_BULLET_DAMAGE = 8;
const PLAYER_HITBOX_RADIUS = 0.5;

export class Game {
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  player!: Player;
  world!: CANNON.World;
  clock!: THREE.Clock;
  targets: Target[] = [];
  enemies: Enemy[] = [];
  capturePoints: CapturePoint[] = [];
  checkpoints: Checkpoint[] = [];
  titan: Titan | null = null;
  private weaponPickups: WeaponPickup[] = [];
  private attachmentPickups: AttachmentPickup[] = [];
  private activePickupHoldTime = 0;
  private readonly PICKUP_RANGE = 2;
  private readonly PICKUP_PROMPT_RANGE = 4;
  private readonly TITAN_EMBARK_HOLD_TIME = 0.5;
  private readonly PICKUP_HOLD_TIME = 0.35;

  state: GameState = GameState.MAIN_MENU;
  currentLevel: Level | null = null;
  stats: GameStats;
  scoreMultiplier: number = 1;
  levels: Level[] = LEVELS;

  private gameContainer: HTMLElement;
  /** Scene objects that survive level changes (camera, lights). */
  private persistentObjects = new Set<THREE.Object3D>();
  private ui: GameUI;
  private graphics!: GraphicsPipeline;
  private sunDirection = new THREE.Vector3(-40, 60, -50).normalize();
  /** Health seen last frame, to trigger hit feedback when it drops. */
  private lastPilotHealth = 100;
  private lastTitanHealth = 0;

  private capturedTime = 0;
  private checkpointProgress = 0;
  private survivalSpawnTimer = 0;
  private lastPauseToggle = 0;

  private getTargetSpawnPositions(): THREE.Vector3[] {
    if (!this.currentLevel) return [];

    switch (this.currentLevel.id) {
      case 1:
        return [
          new THREE.Vector3(-5.5, 0.75, 34),
          new THREE.Vector3(5.5, 0.75, 34),
          new THREE.Vector3(-5.5, 0.75, 43),
          new THREE.Vector3(5.5, 0.75, 43),
          new THREE.Vector3(0, 0, 64),
        ];
      case 2:
        return [
          new THREE.Vector3(0, 0, -12),
          new THREE.Vector3(0, 0, -24),
          new THREE.Vector3(0, 0, -36),
          new THREE.Vector3(-6, 0, -46),
          new THREE.Vector3(6, 0, -46),
          new THREE.Vector3(-6, 0, -68),
          new THREE.Vector3(6, 0, -68),
          new THREE.Vector3(12, 0, -56),
        ];
      case 3:
        return [
          new THREE.Vector3(-22, 0, 28),
          new THREE.Vector3(22, 0, 28),
          new THREE.Vector3(0, 0.75, 34),
        ];
      default:
        return Array.from({ length: this.currentLevel.targetCount }, (_, i) =>
          new THREE.Vector3((i % 3) * 8 - 8, 0, Math.floor(i / 3) * 8 + 34)
        );
    }
  }

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
      () => { if (this.state === GameState.PLAYING) this.callTitan(); },
      (quality: GraphicsQuality) => this.setGraphicsQuality(quality)
    );

    // Clicking the canvas re-captures the mouse if pointer lock was lost
    this.renderer.domElement.addEventListener('click', () => {
      if (this.state === GameState.PLAYING && !document.pointerLockElement) {
        this.player?.lockPointer();
      }
    });

    // Losing pointer lock mid-game (Esc, alt-tab) pauses, like any desktop FPS
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === GameState.PLAYING) {
        this.togglePause();
      }
    });

    this.showMainMenu();
    this.animate();
  }

  private initScene() {
    this.clock = new THREE.Clock();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xd0e0e8, 0.005); // Brighter, light blue fog

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 2, 0);
    this.scene.add(this.camera);

    // Anti-aliasing is done in the post-processing chain (MSAA render target or FXAA)
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.gameContainer.appendChild(this.renderer.domElement);

    this.graphics = new GraphicsPipeline(this.renderer, this.scene, this.camera, getGraphicsQuality());

    // Sky dome, also used as the image-based lighting environment
    const sky = this.createSkyDome();
    this.graphics.setEnvironmentFromEquirect(sky, 0.4);

    // Soft sky fill. Most ambient light now comes from the sky environment map.
    const hemiLight = new THREE.HemisphereLight(0xbadcf5, 0xe8eef2, 0.45);
    this.scene.add(hemiLight);

    // Sun: casts the shadows. Its shadow frustum follows the camera (see GraphicsPipeline.updateSun)
    const directionalLight = new THREE.DirectionalLight(0xfff4e6, 2.6);
    directionalLight.position.copy(this.sunDirection).multiplyScalar(90);
    directionalLight.castShadow = true;
    this.scene.add(directionalLight);
    this.graphics.setSun(directionalLight);

    this.persistentObjects = new Set<THREE.Object3D>([this.camera, hemiLight, directionalLight, directionalLight.target]);

    this.world = new CANNON.World();
    this.world.gravity.set(0, 0, 0);

    window.addEventListener('resize', () => this.onWindowResize());
  }

  private createSkyDome(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    // Authored in 1024x512 units; scaled up for a sharper background
    ctx.scale(2, 2);

    // Gradient: bright cyan/teal horizon → light blue → white zenith
    const grad = ctx.createLinearGradient(0, 512, 0, 0);
    grad.addColorStop(0.0, '#a5dff5');   // horizon
    grad.addColorStop(0.2, '#badcf5');  // low
    grad.addColorStop(0.6, '#d0e0e8');  // mid
    grad.addColorStop(1.0, '#ffffff');  // zenith

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);

    // Subtle digital grid in the sky, fading out overhead where equirect lines bunch into arcs
    const gridFade = ctx.createLinearGradient(0, 512, 0, 0);
    gridFade.addColorStop(0.5, 'rgba(0, 255, 204, 0.14)');
    gridFade.addColorStop(0.72, 'rgba(0, 255, 204, 0.04)');
    gridFade.addColorStop(0.85, 'rgba(0, 255, 204, 0)');
    ctx.strokeStyle = gridFade;
    ctx.lineWidth = 1;
    const gridSpacing = 64;
    for (let x = 0; x <= 1024; x += gridSpacing) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 512); ctx.stroke();
    }
    for (let y = 128; y <= 512; y += gridSpacing) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1024, y); ctx.stroke();
    }

    // Add bright "data" particles / squares instead of stars
    for (let i = 0; i < 150; i++) {
      const x = Math.random() * 1024;
      const y = Math.random() * 400;
      const s = Math.random() * 3 + 1;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0, 255, 204, 0.4)' : 'rgba(255, 102, 0, 0.4)';
      ctx.fillRect(x, y, s, s);
    }

    // A few brighter data nodes
    for (let i = 0; i < 15; i++) {
      const x = Math.random() * 1024;
      const y = Math.random() * 256;
      ctx.beginPath();
      ctx.arc(x, y, Math.random() * 3 + 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.6 + Math.random() * 0.4})`;
      ctx.fill();
    }

    // Sun glow, placed where the directional light actually comes from (equirectangular mapping)
    const sun = this.sunDirection;
    const u = Math.atan2(sun.z, sun.x) / (Math.PI * 2) + 0.5;
    const v = Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1)) / Math.PI + 0.5;
    const sunX = u * 1024;
    const sunY = (1 - v) * 512;
    const stretch = 1 / Math.max(0.2, Math.cos(Math.asin(sun.y))); // equirect widens towards the poles
    ctx.save();
    ctx.translate(sunX, sunY);
    ctx.scale(stretch, 1);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 90);
    halo.addColorStop(0, 'rgba(255, 255, 255, 1)');
    halo.addColorStop(0.08, 'rgba(255, 252, 240, 1)');
    halo.addColorStop(0.25, 'rgba(255, 244, 220, 0.55)');
    halo.addColorStop(1, 'rgba(255, 240, 220, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = texture;
    return texture;
  }

  private setGraphicsQuality(quality: GraphicsQuality): void {
    if (quality === this.graphics.getQuality()) return;
    setGraphicsQuality(quality);
    this.graphics.setQuality(quality);
  }

  callTitan(): void {
    if (!this.player || this.stats.titanMeter < 100) return;

    if (this.titan && this.titan.state !== TitanState.INACTIVE && this.titan.state !== TitanState.DESTROYED) {
      return;
    }

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    raycaster.far = 100;

    const intersects = raycaster.intersectObjects(this.getWorldMeshes(), false);
    let spawnPos: THREE.Vector3;

    if (intersects.length > 0) {
      spawnPos = intersects[0].point.clone();
    } else {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      spawnPos = this.player.group.position.clone().add(forward.normalize().multiplyScalar(20));
      spawnPos.y = 0;
    }

    this.createTitanCallAnimation(spawnPos);

    // Replace a previously destroyed titan
    this.titan?.dispose();
    this.titan = new Titan(this.scene, this.world, spawnPos);
    this.titan.call(spawnPos);

    // Reset titan meter in both stats and player
    this.stats.titanMeter = 0;
    this.player.resetTitanMeter();
    this.addScore(500);
  }

  embarkTitan(): void {
    if (!this.player || !this.titan) return;
    if (this.titan.state !== TitanState.READY) return;
    if (this.player.group.position.distanceTo(this.titan.group.position) > TITAN_EMBARK_RANGE) return;

    this.titan.enter();

    // Hide player model and enable piloting mode
    this.player.group.visible = false;
    this.player.setPilotingState(true);
  }

  disembarkTitan(): void {
    if (!this.player || !this.titan) return;

    // Only disembark if currently piloting
    if (this.titan.state !== TitanState.PILOTING) return;

    // Set callback for when fade-out completes (screen is black)
    this.titan.setExitFadedOutCallback(() => {
      if (!this.player || !this.titan) return;
      this.ejectPilot(this.titan, new THREE.Vector3(0, 5, 0));
    });

    // Start the exit sequence (fade out → callback → fade in)
    this.titan.exit();
  }

  /** Put the pilot back on foot next to `titan`, with an optional launch velocity. */
  private ejectPilot(titan: Titan, launch: THREE.Vector3): void {
    const exitOffset = new THREE.Vector3(0, 0, 4).applyAxisAngle(new THREE.Vector3(0, 1, 0), titan.group.rotation.y);
    const titanPos = titan.group.position;
    this.player.body.position.set(titanPos.x + exitOffset.x, titanPos.y + 0.5, titanPos.z + exitOffset.z);

    this.player.group.visible = true;
    this.player.setPilotingState(false);
    this.player.setVelocity(exitOffset.x * 2 + launch.x, launch.y, exitOffset.z * 2 + launch.z);
  }

  private createTitanCallAnimation(position: THREE.Vector3): void {
    const spawnRing = (delayMs: number, spin: number) => {
      const ringGeo = new THREE.RingGeometry(0.5, 1, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00ffcc,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(position.x, 0.1, position.z);
      ring.rotation.x = -Math.PI / 2;
      ring.rotation.z = Math.random() * Math.PI * 2;
      ring.userData.ignoreRaycast = true;

      const duration = 2000;
      let startTime = 0;
      const animateRing = (now: number) => {
        if (!ring.parent) return; // level was torn down
        if (!startTime) startTime = now;
        const progress = (now - startTime) / duration;
        if (progress >= 1) {
          this.scene.remove(ring);
          ringGeo.dispose();
          ringMat.dispose();
          return;
        }
        const scale = 1 + progress * 20;
        ring.scale.set(scale, scale, 1);
        ringMat.opacity = 0.8 * (1 - progress);
        ring.rotation.z += spin;
        requestAnimationFrame(animateRing);
      };

      window.setTimeout(() => {
        this.scene.add(ring);
        requestAnimationFrame(animateRing);
      }, delayMs);
    };

    spawnRing(0, 0.05);
    spawnRing(300, -0.05);
  }

  startGame(levelId: number = 1) {
    this.state = GameState.PLAYING;
    this.currentLevel = this.levels.find(l => l.id === levelId) || this.levels[0];
    this.stats.level = this.currentLevel.id;
    this.stats.score = 0;
    this.stats.kills = 0;
    this.stats.time = 0;
    this.stats.objectivesCompleted = 0;
    this.stats.titanMeter = 100;
    this.stats.health = 100;
    this.scoreMultiplier = 1;
    this.capturedTime = 0;
    this.checkpointProgress = 0;
    this.survivalSpawnTimer = 0;
    this.activePickupHoldTime = 0;

    this.teardownLevel();
    this.lastPilotHealth = 100;
    this.lastTitanHealth = 0;

    createLevel(this.scene, this.world, this.currentLevel);

    this.player = new Player(this.camera, this.scene, this.world);
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
    this.player.setTitanControlCallback((forward, right, lookX, lookY, fire, dash, crouch) => {
      if (this.titan) {
        this.titan.setPilotInput(forward, right, lookX, lookY, fire, dash, crouch);
      }
    });
    this.scene.add(this.player.group);

    this.spawnWeaponPickups();

    if (this.currentLevel.type === LevelType.TRAINING || this.currentLevel.type === LevelType.CAPTURE) {
      for (const position of this.getTargetSpawnPositions()) {
        this.targets.push(new Target(this.scene, this.world, position.x, position.y, position.z));
      }
    }

    this.setupObjectives();
    this.player.lockPointer();

    this.ui.hideMenus();
    this.ui.showEmbarkIndicator(false);
    this.clock.getDelta(); // don't count menu time in the first frame
  }

  /** Remove and free everything belonging to the current level, keeping camera and lights. */
  private teardownLevel(): void {
    this.targets.forEach((target) => target.dispose());
    this.targets = [];
    this.enemies.forEach((enemy) => enemy.dispose());
    this.enemies = [];
    this.capturePoints = [];
    this.checkpoints = [];
    this.weaponPickups = [];
    this.attachmentPickups = [];

    if (this.titan) {
      this.titan.dispose();
      this.titan = null;
    }
    if (this.player) {
      this.player.dispose();
    }

    for (const child of [...this.scene.children]) {
      if (this.persistentObjects.has(child) || this.graphics.getPersistentObjects().includes(child)) continue;
      this.scene.remove(child);
      disposeObject3D(child);
    }
    while (this.world.bodies.length > 0) {
      this.world.removeBody(this.world.bodies[0]);
    }
  }

  private setupObjectives() {
    switch (this.currentLevel!.type) {
      case LevelType.CAPTURE:
        this.setupCapturePoints();
        break;
      case LevelType.RACE:
        this.setupCheckpoints();
        break;
    }
    this.setupEnemies();
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
      // Rings are markers, not geometry: don't let them stop bullets or feet
      mesh.userData.ignoreRaycast = true;
      this.scene.add(mesh);

      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = 'rgba(2, 14, 20, 0.88)';
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(56, 36);
      ctx.lineTo(476, 36);
      ctx.lineTo(456, 220);
      ctx.lineTo(36, 220);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = 'rgba(0, 255, 204, 0.16)';
      ctx.fillRect(64, 52, 384, 36);

      ctx.fillStyle = '#9fffee';
      ctx.font = 'bold 28px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CHECKPOINT', 256, 70);

      ctx.shadowColor = '#00ffcc';
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#00ffcc';
      ctx.font = 'bold 108px Arial';
      ctx.fillText((index + 1).toString(), 256, 154);
      ctx.shadowBlur = 0;

      ctx.strokeStyle = 'rgba(0, 255, 204, 0.35)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(96, 194);
      ctx.lineTo(416, 194);
      ctx.stroke();

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const markerMat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
      const marker = new THREE.Sprite(markerMat);
      marker.position.set(checkpoint.position.x, checkpoint.position.y + 5.1, checkpoint.position.z);
      marker.scale.set(5.6, 2.8, 1);
      this.scene.add(marker);
    });
  }

  /** Starting enemy positions per level type (feet on the ground, y = 0). */
  private getEnemySpawnPositions(type: LevelType): THREE.Vector3[] {
    switch (type) {
      case LevelType.SURVIVAL:
        // Inside the survival arena (walls at x = ±20, back wall at z = -60)
        return [
          new THREE.Vector3(-10, 0, -30), new THREE.Vector3(0, 0, -30), new THREE.Vector3(10, 0, -30),
          new THREE.Vector3(-10, 0, -20), new THREE.Vector3(0, 0, -20), new THREE.Vector3(10, 0, -20),
        ];
      case LevelType.CAPTURE:
        // Guarding the capture points
        return [
          new THREE.Vector3(-15, 0, 38), new THREE.Vector3(15, 0, 38),
          new THREE.Vector3(-8, 0, 44), new THREE.Vector3(8, 0, 44),
        ];
      case LevelType.RACE:
        // Harassing the course, off to the side of the checkpoints
        return [new THREE.Vector3(-12, 0, -40), new THREE.Vector3(12, 0, -65)];
      default:
        return [];
    }
  }

  private setupEnemies() {
    const level = this.currentLevel!;
    const positions = this.getEnemySpawnPositions(level.type);
    for (let i = 0; i < level.enemyCount && positions.length > 0; i++) {
      const position = positions[i % positions.length].clone();
      const diff = 0.3 + Math.random() * 0.4; // 0.3-0.7
      this.enemies.push(new Enemy(this.scene, this.world, position, {
        health: 50,
        speed: 1.5,
        aggressive: level.type !== LevelType.RACE,
        attackCooldown: 2,
        difficulty: diff,
      }));
    }
  }

  update(delta: number) {
    if (!this.player || !this.currentLevel) return;

    this.stats.time += delta;
    this.world.step(1 / 60, delta, 4);

    this.player.update(delta, this.targets, this.enemies);
    this.targets.forEach(target => target.update(delta, this.camera.position));

    // Update level-specific visuals (like pulsing neon strips)
    updateLevelVisuals(performance.now() * 0.001);

    // Update radar with enemy positions
    this.player.updateRadar(this.enemies.map(e => ({ position: e.group.position })));
    this.player.renderRadar();

    this.updateObjectives(delta);
    this.updateEnemies(delta);
    this.updateTitan(delta);

    this.updateInteractions(delta);
    this.updateHUD();
    this.checkLevelCompletion();
  }

  private isPiloting(): boolean {
    return !!this.titan && (this.titan.state === TitanState.PILOTING || this.titan.state === TitanState.ENTERING);
  }

  private updateTitan(delta: number): void {
    const titan = this.titan;
    if (!titan) {
      this.ui.showEmbarkIndicator(false);
      return;
    }

    titan.update(delta, this.targets, this.enemies);
    titan.updatePhysicsPosition();

    // Titan destroyed with the pilot inside: eject
    if (titan.state === TitanState.DESTROYED && this.player.isInTitan()) {
      this.ejectPilot(titan, new THREE.Vector3(0, 12, 0));
      this.camera.fov = 75;
      this.camera.updateProjectionMatrix();
    }

    let titanCockpitActive = false;
    let titanAds = false;

    const distance = this.player.group.position.distanceTo(titan.group.position);
    const canEmbark = titan.state === TitanState.READY && distance <= TITAN_EMBARK_RANGE;
    this.ui.showEmbarkIndicator(canEmbark);
    this.ui.showPilotingIndicator(this.isPiloting());
    if (this.isPiloting()) {
      this.player.syncToTitan(titan.group.position, titan.group.rotation.y);
    }

    // When piloting, sync camera to titan cockpit
    if (titan.state === TitanState.PILOTING) {
      const cockpit = titan.getCockpitCamera();
      this.camera.position.copy(cockpit.position);
      this.camera.rotation.set(cockpit.rotation.x, cockpit.rotation.y, cockpit.rotation.z, 'YXZ');
      titanAds = this.player.isADSActive();
      const targetFov = titanAds ? 58 : 75;
      this.camera.fov += (targetFov - this.camera.fov) * 0.18;
      this.camera.updateProjectionMatrix();
      titanCockpitActive = true;
    } else {
      titan.hideCockpitWeapon();
    }

    const shakeIntensity = titan.getShakeIntensity();
    if (shakeIntensity > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * shakeIntensity * 0.3;
      this.camera.position.y += (Math.random() - 0.5) * shakeIntensity * 0.3;
    }
    if (titanCockpitActive) {
      titan.syncCockpitWeapon(this.camera, titanAds, delta);
    }
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
      // Each pickup owns its own copy so attachments on one never show up on another
      this.weaponPickups.push(this.createPickupMesh(cloneWeapon(def.weapon), def.pos));

      // Randomly spawn an attachment nearby
      if (Math.random() > 0.4) {
        const atts = Object.values(ATTACHMENTS);
        const att = atts[Math.floor(Math.random() * atts.length)];
        const attPos = def.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
        this.createAttachmentPickup(att, attPos);
      }
    }
  }

  private createAttachmentPickup(attachment: Attachment, position: THREE.Vector3): void {
    const group = new THREE.Group();
    const color = 0x00ffcc;

    // Technical Diamond Shape
    const geo = new THREE.OctahedronGeometry(0.2, 0);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 2.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.4;
    group.add(mesh);

    // Aura
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending })
    );
    aura.position.y = 0.4;
    group.add(aura);

    group.position.copy(position);
    this.scene.add(group);

    this.attachmentPickups.push({
      attachment,
      mesh: group,
      position: position.clone(),
      baseY: position.y,
      taken: false,
    });
  }

  private createPickupMesh(weapon: Weapon, position: THREE.Vector3): WeaponPickup {
    const group = new THREE.Group();
    const color = weapon.bulletVisuals.color;

    // Use actual weapon mesh construction
    const gunGroup = createWeaponMesh(weapon, true);
    gunGroup.position.y = 0.5;
    group.add(gunGroup);

    // Add a pulsing holographic "aura" sphere
    const auraGeo = new THREE.SphereGeometry(0.4, 16, 16);
    const auraMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending
    });
    const aura = new THREE.Mesh(auraGeo, auraMat);
    gunGroup.add(aura);

    // Base ring glow - wider and brighter
    const ringGeo = new THREE.TorusGeometry(0.5, 0.04, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    // Vertical light beam - more prominent
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.5, 8);
    const beamMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.y = 1.25;
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

  private removePickupMesh(mesh: THREE.Object3D): void {
    this.scene.remove(mesh);
    disposeObject3D(mesh);
  }

  private rebuildPickupMesh(pickup: WeaponPickup) {
    this.removePickupMesh(pickup.mesh);
    pickup.mesh = this.createPickupMesh(pickup.weapon, pickup.position).mesh;
  }

  private updateInteractions(delta: number) {
    if (!this.player) return;

    const time = performance.now() * 0.001;
    const playerPos = this.player.group.position;
    const piloting = this.isPiloting();

    let nearestWeapon: WeaponPickup | null = null;
    let nearestWeaponDist = Infinity;
    for (const pickup of this.weaponPickups) {
      if (pickup.cooldown > 0) {
        pickup.cooldown -= delta;
        pickup.mesh.visible = pickup.cooldown <= 0;
        if (pickup.cooldown > 0) continue;
      }
      pickup.mesh.rotation.y += 1.5 * delta;
      pickup.mesh.position.y = pickup.baseY + Math.sin(time * 2) * 0.1;
      const dist = playerPos.distanceTo(pickup.position);
      if (dist < this.PICKUP_PROMPT_RANGE && dist < nearestWeaponDist) {
        nearestWeaponDist = dist;
        nearestWeapon = pickup;
      }
    }

    let nearestAtt: AttachmentPickup | null = null;
    let nearestAttDist = Infinity;
    for (const pickup of this.attachmentPickups) {
      if (pickup.taken) continue;
      pickup.mesh.rotation.y += 3.0 * delta;
      pickup.mesh.position.y = pickup.baseY + Math.sin(time * 4) * 0.05;
      const dist = playerPos.distanceTo(pickup.position);
      if (dist < this.PICKUP_PROMPT_RANGE && dist < nearestAttDist) {
        nearestAttDist = dist;
        nearestAtt = pickup;
      }
    }

    let canEmbark = false;
    if (this.titan && this.titan.state === TitanState.READY) {
      canEmbark = playerPos.distanceTo(this.titan.group.position) <= TITAN_EMBARK_RANGE;
    }

    // Prioritization: Titan > Weapon > Attachment. No pickups from inside a titan.
    let bestAction: 'titan' | 'weapon' | 'attachment' | null = null;
    if (canEmbark) {
      bestAction = 'titan';
    } else if (!piloting && nearestWeapon && nearestWeaponDist < this.PICKUP_RANGE) {
      bestAction = 'weapon';
    } else if (!piloting && nearestAtt && nearestAttDist < this.PICKUP_RANGE) {
      bestAction = 'attachment';
    }

    // Interaction Logic
    const isInteracting = !!bestAction && this.player.isInteractHeld() && !this.player.isInteractConsumed();
    const requiredTime = bestAction === 'titan' ? this.TITAN_EMBARK_HOLD_TIME : this.PICKUP_HOLD_TIME;

    if (isInteracting) {
      this.activePickupHoldTime += delta;

      if (this.activePickupHoldTime >= requiredTime) {
        if (bestAction === 'titan') {
          this.embarkTitan();
        } else if (bestAction === 'weapon' && nearestWeapon) {
          this.pickUpWeapon(nearestWeapon);
        } else if (bestAction === 'attachment' && nearestAtt) {
          this.player.equipAttachment(nearestAtt.attachment);
          nearestAtt.taken = true;
          this.removePickupMesh(nearestAtt.mesh);
        }
        this.player.consumeInteractHold();
        this.activePickupHoldTime = 0;
      }
    } else {
      this.activePickupHoldTime = 0;
    }

    // Update Prompts
    if (!bestAction) {
      this.ui.hideInteractionPrompt();
      return;
    }

    const interactKey = keyCodeToLabel(getBindings().embark);
    let label = '';
    let color = '#00ffcc';
    if (bestAction === 'titan') {
      label = `Hold [${interactKey}] to EMBARK`;
      color = '#ff6600';
    } else if (bestAction === 'weapon' && nearestWeapon) {
      const verb = this.player.hasFreeWeaponSlot() ? 'take' : 'swap for';
      label = `Hold [${interactKey}] to ${verb} ${nearestWeapon.weapon.name}`;
      color = '#' + nearestWeapon.weapon.bulletVisuals.color.toString(16).padStart(6, '0');
    } else if (bestAction === 'attachment' && nearestAtt) {
      label = `Hold [${interactKey}] to equip ${nearestAtt.attachment.name}`;
    }
    this.ui.showInteractionPrompt(label, color, this.activePickupHoldTime / requiredTime);
  }

  private pickUpWeapon(pickup: WeaponPickup): void {
    const result = this.player.tryPickupWeapon(pickup.weapon);
    if (!result.pickedUp) return;

    if (result.dropped) {
      // Leave the swapped-out weapon where the new one was
      pickup.weapon = result.dropped;
      this.rebuildPickupMesh(pickup);
      pickup.cooldown = 0.5;
      pickup.mesh.visible = false;
    } else {
      this.removePickupMesh(pickup.mesh);
      this.weaponPickups = this.weaponPickups.filter((p) => p !== pickup);
    }
  }

  private updateObjectives(delta: number) {
    const playerPos = this.player.group.position;
    switch (this.currentLevel!.type) {
      case LevelType.CAPTURE:
        for (const point of this.capturePoints) {
          if (playerPos.distanceTo(point.position) < CAPTURE_RADIUS) {
            point.captured = true;
            point.timer += delta;
            if (point.timer >= CAPTURE_LOCK_TIME) this.capturedTime += delta;
          } else {
            point.captured = false;
          }
        }
        break;

      case LevelType.RACE:
        for (let i = 0; i < this.checkpoints.length; i++) {
          const checkpoint = this.checkpoints[i];
          if (!checkpoint.completed && playerPos.distanceTo(checkpoint.position) < CHECKPOINT_RADIUS) {
            checkpoint.completed = true;
            this.checkpointProgress = this.checkpoints.filter((c) => c.completed).length;
            this.addScore(200);
          }
        }
        break;

      case LevelType.SURVIVAL: {
        // Reinforcements arrive faster the longer you survive
        const maxEnemies = this.currentLevel!.enemyCount * 2;
        const spawnInterval = Math.max(3, 8 - this.stats.time / 10);
        this.survivalSpawnTimer += delta;
        if (this.survivalSpawnTimer >= spawnInterval) {
          this.survivalSpawnTimer = 0;
          if (this.enemies.length < maxEnemies) this.spawnEnemy();
        }
        break;
      }
    }
  }

  private spawnEnemy() {
    // Arena corners, inside the survival walls
    const spawnPoints = [
      new THREE.Vector3(15, 0, -50),
      new THREE.Vector3(-15, 0, -50),
      new THREE.Vector3(15, 0, -5),
      new THREE.Vector3(-15, 0, -5)
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

  /** Opaque, raycastable level geometry (used for line-of-sight and bullet collision). */
  private getWorldMeshes(): THREE.Mesh[] {
    return this.scene.children.filter((o): o is THREE.Mesh => {
      if (!(o instanceof THREE.Mesh)) return false;
      if (o.userData.ignoreRaycast) return false;
      const mat = o.material;
      if (Array.isArray(mat)) return !mat.some((m) => m.transparent);
      return !mat.transparent;
    });
  }

  private updateEnemies(delta: number) {
    const playerPos = this.player.group.position;
    const worldMeshes = this.getWorldMeshes();
    const playerVel = this.player.getVelocity();
    const hitbox = { center: playerPos.clone().add(new THREE.Vector3(0, 0.5, 0)), radius: PLAYER_HITBOX_RADIUS };
    const piloting = this.isPiloting();
    if (piloting && this.titan) {
      // Enemies engage the titan itself, which is a much bigger target than a pilot
      hitbox.center.copy(this.titan.group.position).add(new THREE.Vector3(0, 5, 0));
      hitbox.radius = 3;
    }
    const aimPos = piloting ? hitbox.center : playerPos;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];

      // AI update: state machine, movement, shooting
      const hits = enemy.update(delta, aimPos, worldMeshes, hitbox, playerVel);
      for (const source of hits) {
        if (piloting && this.titan) this.titan.takeDamage(ENEMY_BULLET_DAMAGE);
        else this.player.takeDamage(ENEMY_BULLET_DAMAGE, source);
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
    this.stats.score += Math.round(amount * this.scoreMultiplier);
    this.scoreMultiplier = Math.min(2, this.scoreMultiplier + 0.05);
  }

  private countDestroyedTargets(): number {
    return this.targets.filter((t) => t.destroyed).length;
  }

  private checkLevelCompletion() {
    const level = this.currentLevel;
    if (!level || this.state !== GameState.PLAYING) return;

    if (this.player.health <= 0) {
      this.failLevel();
      return;
    }

    let complete = false;
    switch (level.type) {
      case LevelType.TRAINING:
        complete = this.countDestroyedTargets() >= level.targetCount;
        break;
      case LevelType.CAPTURE:
        complete = this.capturedTime >= CAPTURE_WIN_TIME;
        break;
      case LevelType.RACE:
        complete = this.checkpoints.length > 0 && this.checkpointProgress >= this.checkpoints.length;
        break;
      case LevelType.SURVIVAL:
        complete = this.stats.time >= (level.timeLimit ?? 0);
        break;
    }

    if (complete) {
      if (level.type !== LevelType.TRAINING) this.stats.objectivesCompleted++;
      else this.stats.objectivesCompleted = this.countDestroyedTargets();
      this.completeLevel();
      return;
    }

    if (level.timeLimit && this.stats.time >= level.timeLimit) {
      this.failLevel();
    }
  }

  /** Stop gameplay input and release the mouse so menu buttons can be clicked. */
  private suspendGameplay(): void {
    this.player?.setInputEnabled(false);
    this.ui.hideInteractionPrompt();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private completeLevel() {
    this.state = GameState.LEVEL_COMPLETE;
    this.suspendGameplay();
    const nextLevel = this.levels.find(l => l.id === this.currentLevel!.id + 1);
    this.ui.showLevelComplete(
      this.stats,
      () => nextLevel ? this.startGame(nextLevel.id) : this.showMainMenu(),
      () => this.startGame(this.currentLevel!.id),
      () => this.showMainMenu(),
      !!nextLevel
    );
  }

  private failLevel() {
    this.state = GameState.GAME_OVER;
    this.suspendGameplay();
    this.ui.showGameOver(
      this.stats,
      () => this.startGame(this.currentLevel!.id),
      () => this.showMainMenu()
    );
  }

  private updateHUD() {
    if (this.state !== GameState.PLAYING || !this.currentLevel) return;
    const isPilotingTitan = this.isPiloting();
    const titanDashMeter = this.titan ? this.titan.getDashMeter() : 100;
    const titanHealth = this.titan ? this.titan.getHealth() : 0;
    const titanShield = this.titan ? this.titan.getShield() : 0;
    this.stats.health = this.player.health;
    this.ui.updateHUD({
      currentLevel: this.currentLevel,
      stats: this.stats,
      scoreMultiplier: this.scoreMultiplier,
      playerHealth: this.player.health,
      titanDashMeter,
      isPilotingTitan,
      titanHealth,
      titanShield,
      capturePoints: this.capturePoints,
      capturedTime: this.capturedTime,
      checkpoints: this.checkpoints,
      checkpointProgress: this.checkpointProgress,
      enemyCount: this.enemies.length,
      destroyedTargets: this.countDestroyedTargets(),
      showSniperScope: this.player.shouldShowSniperScope(),
      weapon: this.player.getWeaponHUDData(),
      debug: this.player.getDebugHUDData(),
    });
  }

  togglePause() {
    // Esc can arrive twice (keydown and the pointer-lock release it causes); treat that as one toggle
    const now = performance.now();
    if (now - this.lastPauseToggle < 250) return;
    this.lastPauseToggle = now;

    if (this.state === GameState.PLAYING) {
      this.state = GameState.PAUSED;
      this.suspendGameplay();
      document.body.style.cursor = 'auto';
      this.ui.showPause(
        () => this.togglePause(),
        () => this.startGame(this.currentLevel!.id),
        () => this.showMainMenu()
      );
    } else if (this.state === GameState.PAUSED) {
      this.state = GameState.PLAYING;
      this.ui.hidePause();
      this.player.setInputEnabled(true);
      this.player.lockPointer();
    }
  }

  showMainMenu() {
    this.state = GameState.MAIN_MENU;
    this.suspendGameplay();
    this.ui.hideMenus();
    this.ui.showEmbarkIndicator(false);
    this.ui.showMainMenu(this.levels, (id) => this.startGame(id));
  }

  /** Restart the current level (keyboard shortcut). */
  restartLevel(): void {
    this.startGame(this.currentLevel?.id ?? 1);
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.graphics.setSize(window.innerWidth, window.innerHeight);
  }

  /** Screen feedback (edge flash, desaturation, cockpit tint) driven by pilot/titan health. */
  private updateScreenFeedback(): void {
    const titan = this.titan;
    const piloting = !!titan && titan.state === TitanState.PILOTING;
    this.graphics.setTitanView(piloting);

    const pilotHealth = this.player.health;
    if (pilotHealth < this.lastPilotHealth) this.graphics.registerDamage(this.lastPilotHealth - pilotHealth);
    this.lastPilotHealth = pilotHealth;

    const titanHealth = titan ? titan.getHealth() + titan.getShield() : 0;
    if (piloting && titanHealth < this.lastTitanHealth) this.graphics.registerDamage((this.lastTitanHealth - titanHealth) * 0.5);
    this.lastTitanHealth = titanHealth;

    this.graphics.setHealthFraction(piloting && titan ? titan.getHealth() / 100 : pilotHealth / 100);
  }

  animate() {
    // Always advance the clock so resuming from a menu doesn't produce one huge frame
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (this.state === GameState.PLAYING) {
      this.update(delta);
      this.updateScreenFeedback();
      this.graphics.update(delta, this.camera.position);
    } else {
      this.ui.updateMenuNavigation(this.state);
      this.graphics.update(0, this.camera.position);
    }

    this.graphics.render();
    requestAnimationFrame(() => this.animate());
  }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Target } from './target';
import { createLevel } from './level';
import { Player } from './player';
// import { soundManager } from './sound';

export enum GameState {
  MAIN_MENU = 'main_menu',
  PLAYING = 'playing',
  PAUSED = 'paused',
  LEVEL_COMPLETE = 'level_complete',
  GAME_OVER = 'game_over'
}

export enum LevelType {
  TRAINING = 'training',
  CAPTURE = 'capture',
  RACE = 'race',
  SURVIVAL = 'survival'
}

export interface Level {
  id: number;
  name: string;
  type: LevelType;
  description: string;
  layout: 'open' | 'corridor' | 'maze' | 'arena';
  objective: string;
  targetCount: number;
  enemyCount: number;
  timeLimit: number | null;
  requiredScore: number;
}

export interface GameStats {
  level: number;
  score: number;
  kills: number;
  time: number;
  objectivesCompleted: number;
  titanMeter: number;
  health: number;
}

export class Game {
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  renderer!: THREE.WebGLRenderer;
  player!: Player;
  world!: CANNON.World;
  clock!: THREE.Clock;
  targets: Target[] = [];
  enemies: any[] = [];
  capturePoints: any[] = [];
  checkpoints: any[] = [];
  
  state: GameState = GameState.MAIN_MENU;
  currentLevel: Level | null = null;
  stats: GameStats;
  levelStartTime: number = 0;
  scoreMultiplier: number = 1;
  
  private gameContainer: HTMLElement;
  private ambientLight!: THREE.AmbientLight;
  private directionalLight!: THREE.DirectionalLight;
  private hudElements: { [key: string]: HTMLElement } = {};
  
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
    
    this.initScene();
    this.initUI();
    this.initLevels();
    this.showMainMenu();
  }
  
  private initScene() {
    this.clock = new THREE.Clock();
    
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog = new THREE.Fog(0x1a1a2e, 50, 200);
    
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 2, 0);
    
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gameContainer.appendChild(this.renderer.domElement);
    
    this.ambientLight = new THREE.AmbientLight(0x505080, 0.8);
    this.scene.add(this.ambientLight);
    
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.directionalLight.position.set(0, 80, -30);
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
    
    // Physics world
    this.world = new CANNON.World();
    this.world.gravity.set(0, 0, 0);
    
    window.addEventListener('resize', () => this.onWindowResize());
  }
  
  private initUI() {
    // Create HUD container
    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      pointer-events: none;
      z-index: 100;
      color: #00ffcc;
      font-family: 'Orbitron', sans-serif;
    `;
    document.body.appendChild(hud);
    
    // Level info
    const levelInfo = document.createElement('div');
    levelInfo.id = 'level-info';
    levelInfo.style.cssText = `
      position: absolute;
      top: 20px;
      left: 20px;
      font-size: 16px;
      text-shadow: 0 0 5px #00ffcc;
      background: rgba(0, 0, 0, 0.5);
      padding: 10px;
      border-radius: 5px;
    `;
    hud.appendChild(levelInfo);
    this.hudElements['level-info'] = levelInfo;
    
    // Score
    const scoreDisplay = document.createElement('div');
    scoreDisplay.id = 'score-display';
    scoreDisplay.style.cssText = `
      position: absolute;
      top: 60px;
      left: 20px;
      font-size: 16px;
      text-shadow: 0 0 5px #00ffcc;
    `;
    hud.appendChild(scoreDisplay);
    this.hudElements['score'] = scoreDisplay;
    
    // Objective
    const objectiveDisplay = document.createElement('div');
    objectiveDisplay.id = 'objective-display';
    objectiveDisplay.style.cssText = `
      position: absolute;
      top: 100px;
      left: 20px;
      font-size: 14px;
      text-shadow: 0 0 5px #00ffcc;
      max-width: 300px;
    `;
    hud.appendChild(objectiveDisplay);
    this.hudElements['objective'] = objectiveDisplay;
    
    // Timer
    const timerDisplay = document.createElement('div');
    timerDisplay.id = 'timer-display';
    timerDisplay.style.cssText = `
      position: absolute;
      top: 20px;
      right: 20px;
      font-size: 16px;
      text-shadow: 0 0 5px #00ffcc;
    `;
    hud.appendChild(timerDisplay);
    this.hudElements['timer'] = timerDisplay;
    
    // Stats
    const statsDisplay = document.createElement('div');
    statsDisplay.id = 'stats-display';
    statsDisplay.style.cssText = `
      position: absolute;
      bottom: 20px;
      left: 20px;
      font-size: 14px;
      text-shadow: 0 0 5px #00ffcc;
    `;
    hud.appendChild(statsDisplay);
    this.hudElements['stats'] = statsDisplay;
    
    // Pause overlay
    const pauseOverlay = document.createElement('div');
    pauseOverlay.id = 'pause-overlay';
    pauseOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: none;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      z-index: 200;
      color: #00ffcc;
      font-size: 24px;
    `;
    pauseOverlay.innerHTML = `
      <div>PAUSED</div>
      <div style="margin-top: 20px; font-size: 16px;">
        <div style="margin: 5px;">ESC - Resume</div>
        <div style="margin: 5px;">R - Restart</div>
        <div style="margin: 5px;">M - Main Menu</div>
      </div>
    `;
    document.body.appendChild(pauseOverlay);
    this.hudElements['pause'] = pauseOverlay;
    
    // Level complete overlay
    const levelCompleteOverlay = document.createElement('div');
    levelCompleteOverlay.id = 'level-complete-overlay';
    levelCompleteOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: none;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      z-index: 200;
      color: #00ffcc;
      text-align: center;
    `;
    levelCompleteOverlay.innerHTML = `
      <h1 style="font-size: 48px; margin-bottom: 20px;">LEVEL COMPLETE</h1>
      <div id="level-stats" style="font-size: 18px; margin-bottom: 30px;"></div>
      <div style="display: flex; gap: 20px;">
        <button id="next-level-btn" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Next Level</button>
        <button id="restart-level-btn" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Restart</button>
        <button id="menu-level-btn" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Main Menu</button>
      </div>
    `;
    document.body.appendChild(levelCompleteOverlay);
    this.hudElements['level-complete'] = levelCompleteOverlay;
    
    // Game over overlay
    const gameOverOverlay = document.createElement('div');
    gameOverOverlay.id = 'game-over-overlay';
    gameOverOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: none;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      z-index: 200;
      color: #ff0000;
      text-align: center;
    `;
    gameOverOverlay.innerHTML = `
      <h1 style="font-size: 48px; margin-bottom: 20px;">GAME OVER</h1>
      <div id="final-stats" style="font-size: 18px; margin-bottom: 30px;"></div>
      <div style="display: flex; gap: 20px;">
        <button id="retry-btn" style="padding: 10px 30px; font-size: 16px; background: #ff0000; color: #fff; border: none; border-radius: 5px; cursor: pointer;">Retry</button>
        <button id="menu-gameover-btn" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Main Menu</button>
      </div>
    `;
    document.body.appendChild(gameOverOverlay);
    this.hudElements['game-over'] = gameOverOverlay;
    
    // Add event listeners for pause menu
    document.addEventListener('keydown', (e) => {
      if (this.state === GameState.PLAYING && e.key === 'Escape') {
        this.togglePause();
      }
    });
  }
  
  private initLevels() {
    // Training levels
    this.levels = [
      {
        id: 1,
        name: 'Training: Basics',
        type: LevelType.TRAINING,
        description: 'Learn basic movement and controls',
        layout: 'open',
        objective: 'Destroy 5 targets',
        targetCount: 5,
        enemyCount: 0,
        timeLimit: null,
        requiredScore: 500
      },
      {
        id: 2,
        name: 'Training: Wall Runs',
        type: LevelType.TRAINING,
        description: 'Practice wall running and wall jumps',
        layout: 'corridor',
        objective: 'Destroy 8 targets using wall runs',
        targetCount: 8,
        enemyCount: 0,
        timeLimit: 120,
        requiredScore: 800
      },
      {
        id: 3,
        name: 'Training: Sliding',
        type: LevelType.TRAINING,
        description: 'Master sliding and mantle techniques',
        layout: 'maze',
        objective: 'Complete the slide course',
        targetCount: 3,
        enemyCount: 0,
        timeLimit: 90,
        requiredScore: 600
      },
      {
        id: 4,
        name: 'Capture: Outpost Alpha',
        type: LevelType.CAPTURE,
        description: 'Hold capture points to secure the area',
        layout: 'arena',
        objective: 'Hold capture points for 30 seconds',
        targetCount: 0,
        enemyCount: 4,
        timeLimit: 180,
        requiredScore: 1000
      },
      {
        id: 5,
        name: 'Race: Speed Course',
        type: LevelType.RACE,
        description: 'Complete the course as fast as possible',
        layout: 'corridor',
        objective: 'Reach the finish line',
        targetCount: 0,
        enemyCount: 2,
        timeLimit: 60,
        requiredScore: 1200
      },
      {
        id: 6,
        name: 'Survival: Last Stand',
        type: LevelType.SURVIVAL,
        description: 'Survive against waves of enemies',
        layout: 'open',
        objective: 'Survive for 60 seconds',
        targetCount: 0,
        enemyCount: 6,
        timeLimit: 60,
        requiredScore: 1500
      }
    ];
  }
  
  levels: Level[] = [];
  
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
    
    // Clear existing scene (keep lights)
    const children = [...this.scene.children];
    children.forEach(child => {
      if (child !== this.ambientLight && child !== this.directionalLight) {
        this.scene.remove(child);
      }
    });
    while(this.world.bodies.length > 0) {
      this.world.removeBody(this.world.bodies[0]);
    }
    
    // Create level
    createLevel(this.scene, this.world, this.currentLevel);
    
    // Create player
    this.player = new Player(this.camera, this.scene, this.world);
    this.scene.add(this.player.group);
    
    // Create targets based on level
    if (this.currentLevel.type === LevelType.TRAINING || this.currentLevel.type === LevelType.CAPTURE) {
      for (let i = 0; i < this.currentLevel.targetCount; i++) {
        const x = (i % 3) * 8 - 8;
        const z = Math.floor(i / 3) * 8 + 40;
        this.targets.push(new Target(this.scene, this.world, x, 0, z));
      }
    }
    
    // Set up objectives
    this.setupObjectives();
    
    // Lock pointer
    this.player.lockPointer();
    
    // Hide menu
    document.getElementById('main-menu')?.classList.add('hidden');
    document.getElementById('level-select')?.classList.add('hidden');
    
    // Start animation loop
    this.animate();
  }
  
  private setupObjectives() {
    switch (this.currentLevel!.type) {
      case LevelType.TRAINING:
        this.objectiveText = `Destroy ${this.currentLevel!.targetCount} targets`;
        break;
      case LevelType.CAPTURE:
        this.objectiveText = 'Hold capture points for 30 seconds';
        this.setupCapturePoints();
        break;
      case LevelType.RACE:
        this.objectiveText = 'Reach the finish line';
        this.setupCheckpoints();
        break;
      case LevelType.SURVIVAL:
        this.objectiveText = `Survive for ${this.currentLevel!.timeLimit} seconds`;
        this.setupEnemies();
        break;
    }
    this.updateHUD();
  }
  
  private objectiveText = '';
  private capturedTime = 0;
  private checkpointProgress = 0;
  
  private setupCapturePoints() {
    // Create capture points
    this.capturePoints = [
      { position: new THREE.Vector3(-15, 1, 30), captured: false, timer: 0 },
      { position: new THREE.Vector3(0, 1, 30), captured: false, timer: 0 },
      { position: new THREE.Vector3(15, 1, 30), captured: false, timer: 0 }
    ];
    
    // Visual representation
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
    // Create checkpoints for race
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
      
      // Add number
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
    // Create enemies for survival mode
    const enemyGeo = new THREE.BoxGeometry(1, 1.8, 0.8);
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0x3333ff });
    
    for (let i = 0; i < this.currentLevel!.enemyCount; i++) {
      const x = (i % 3) * 10 - 10;
      const z = Math.floor(i / 3) * 10 - 30;
      const mesh = new THREE.Mesh(enemyGeo, enemyMat);
      mesh.position.set(x, 1.8, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      
      this.enemies.push({
        mesh,
        position: new THREE.Vector3(x, 1.8, z),
        health: 50,
        speed: 1.5,
        aggressive: false,
        attackTimer: 0,
        attackCooldown: 2
      });
    }
  }
  
  update(delta: number) {
    if (!this.player || !this.currentLevel) return;
    
    // advance physics world before processing game logic
    this.world.step(1 / 60, delta, 4);
    
    // Update player
    this.player.update(delta, this.targets);
    
    // Update targets
    this.targets.forEach(target => target.update(delta, this.camera.position));
    
    // Update objectives based on level type
    this.updateObjectives(delta);
    
    // Update enemies
    this.updateEnemies(delta);
    
    // Update HUD
    this.updateHUD();
    
    // Check level completion
    this.checkLevelCompletion();
    
    // Update stats
    this.stats.time = (Date.now() - this.levelStartTime) / 1000;
  }
  
  private updateObjectives(delta: number) {
    switch (this.currentLevel!.type) {
      case LevelType.CAPTURE:
        this.capturePoints.forEach(point => {
          // Simple capture: player near point captures it
          if (this.player.group.position.distanceTo(point.position) < 3) {
            point.captured = true;
            point.timer += delta;
            
            if (point.timer >= 3) {
              this.capturedTime += delta;
            }
          } else {
            point.captured = false;
          }
        });
        break;
      
      case LevelType.RACE:
        // Check if player reached next checkpoint
        const playerPos = this.player.group.position;
        for (let i = 0; i < this.checkpoints.length; i++) {
          if (!this.checkpoints[i].completed && 
              playerPos.distanceTo(this.checkpoints[i].position) < 4) {
            this.checkpoints[i].completed = true;
            this.checkpointProgress = i + 1;
            
            // Add score for checkpoint
            this.addScore(200);
            
            // Check if finished
            if (i === this.checkpoints.length - 1) {
              this.stats.objectivesCompleted++;
            }
          }
        }
        break;
      
      case LevelType.SURVIVAL:
        // Spawn more enemies over time
        if (this.enemies.length < this.currentLevel!.enemyCount * 2 && 
            Math.random() < delta * 0.01) {
          this.spawnEnemy();
        }
        break;
    }
  }
  
  private spawnEnemy() {
    const spawnPoints = [
      new THREE.Vector3(30, 1.8, -30),
      new THREE.Vector3(-30, 1.8, -30),
      new THREE.Vector3(30, 1.8, 30),
      new THREE.Vector3(-30, 1.8, 30)
    ];
    
    const point = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
    const enemyGeo = new THREE.BoxGeometry(1, 1.8, 0.8);
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0x3333ff });
    const mesh = new THREE.Mesh(enemyGeo, enemyMat);
    mesh.position.copy(point);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    
    this.enemies.push({
      mesh,
      position: point.clone(),
      health: 50,
      speed: 1.5 + Math.random() * 1.0,
      aggressive: true,
      attackTimer: 0,
      attackCooldown: 2 + Math.random() * 2
    });
  }
  
  private updateEnemies(delta: number) {
    const playerPos = this.player.group.position;
    
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      
      // Simple AI: move toward player if aggressive
      if (enemy.aggressive) {
        const dir = playerPos.clone().sub(enemy.position).normalize();
        enemy.position.add(dir.multiplyScalar(enemy.speed * delta));
        enemy.mesh.position.copy(enemy.position);
        
        // Attack if close enough
        if (enemy.position.distanceTo(playerPos) < 3) {
          enemy.attackTimer += delta;
          if (enemy.attackTimer >= enemy.attackCooldown) {
            enemy.attackTimer = 0;
            // Damage player
            this.player.takeDamage(5);
          }
        }
      }
      
      // Remove dead enemies
      if (enemy.health <= 0) {
        this.scene.remove(enemy.mesh);
        this.enemies.splice(i, 1);
        this.addScore(100);
        this.stats.kills++;
      }
    }
  }
  
  addScore(amount: number) {
    this.stats.score += amount * this.scoreMultiplier;
    
    // Increase multiplier for consecutive actions
    this.scoreMultiplier = Math.min(2, this.scoreMultiplier + 0.05);
  }
  
  private checkLevelCompletion() {
    if (!this.currentLevel) return;
    
    switch (this.currentLevel.type) {
      case LevelType.TRAINING:
        const destroyedTargets = this.targets.filter(t => t.health <= 0).length;
        if (destroyedTargets >= this.currentLevel.targetCount) {
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
    
    // Check time limit
    if (this.currentLevel.timeLimit && this.stats.time >= this.currentLevel.timeLimit) {
      if (this.currentLevel.type !== LevelType.SURVIVAL) {
        // Failed to complete in time
        this.failLevel();
      }
    }
    
    // Check health
    if (this.player.health <= 0) {
      this.failLevel();
    }
  }
  
  private completeLevel() {
    this.state = GameState.LEVEL_COMPLETE;
    this.hudElements['level-complete'].style.display = 'flex';
    
    // Show stats
    const statsDiv = document.getElementById('level-stats');
    if (statsDiv) {
      statsDiv.innerHTML = `
        Score: ${this.stats.score} <br>
        Kills: ${this.stats.kills} <br>
        Time: ${Math.floor(this.stats.time)}s <br>
        Objects: ${this.stats.objectivesCompleted}
      `;
    }
    
    // Event listeners for buttons
    document.getElementById('next-level-btn')!.onclick = () => {
      const nextLevel = this.currentLevel!.id + 1;
      const availableLevels = this.levels.filter(l => l.id <= nextLevel).sort((a, b) => a.id - b.id);
      const next = availableLevels.find(l => l.id > this.currentLevel!.id);
      if (next) {
        this.startGame(next.id);
      } else {
        this.showMainMenu();
      }
    };
    
    document.getElementById('restart-level-btn')!.onclick = () => {
      this.startGame(this.currentLevel!.id);
    };
    
    document.getElementById('menu-level-btn')!.onclick = () => {
      this.showMainMenu();
    };
  }
  
  private failLevel() {
    this.state = GameState.GAME_OVER;
    this.hudElements['game-over'].style.display = 'flex';
    
    // Show final stats
    const statsDiv = document.getElementById('final-stats');
    if (statsDiv) {
      statsDiv.innerHTML = `
        Level: ${this.stats.level} <br>
        Final Score: ${this.stats.score} <br>
        Kills: ${this.stats.kills} <br>
        Time: ${Math.floor(this.stats.time)}s
      `;
    }
    
    // Event listeners
    document.getElementById('retry-btn')!.onclick = () => {
      this.startGame(this.currentLevel!.id);
    };
    
    document.getElementById('menu-gameover-btn')!.onclick = () => {
      this.showMainMenu();
    };
  }
  
  private updateHUD() {
    if (this.state !== GameState.PLAYING) return;
    
    // Level info
    this.hudElements['level-info'].innerHTML = `
      <strong>LEVEL ${this.currentLevel!.id}</strong><br>
      ${this.currentLevel!.name}
    `;
    
    // Score
    this.hudElements['score'].innerHTML = `
      SCORE: ${this.stats.score}
      <span style="color: #00ffff; font-size: 12px;">×${this.scoreMultiplier.toFixed(1)}</span>
    `;
    
    // Objective
    this.hudElements['objective'].innerHTML = this.objectiveText;
    
    // Timer
    if (this.currentLevel!.timeLimit) {
      const remaining = Math.max(0, this.currentLevel!.timeLimit - this.stats.time);
      this.hudElements['timer'].innerHTML = `
        TIME: ${Math.floor(remaining)}s
        <span style="color: ${remaining < 10 ? '#ff0000' : '#00ffcc'}; font-size: 12px;">
          ${Math.floor(this.stats.time)}s elapsed
        </span>
      `;
    } else {
      this.hudElements['timer'].innerHTML = `TIME: ${Math.floor(this.stats.time)}s`;
    }
    
    // Stats
    let statsText = '';
    switch (this.currentLevel!.type) {
      case LevelType.CAPTURE:
        const capturedCount = this.capturePoints.filter(p => p.captured).length;
        statsText += `CAPTURED: ${capturedCount}/3<br>`;
        statsText += `HOLD TIME: ${Math.floor(this.capturedTime)}s/30s`;
        break;
      case LevelType.RACE:
        statsText += `CHECKPOINTS: ${this.checkpointProgress}/${this.checkpoints.length}<br>`;
        statsText += `ENEMIES: ${this.enemies.length}`;
        break;
      case LevelType.SURVIVAL:
        statsText += `ENEMIES: ${this.enemies.length}<br>`;
        statsText += `TIME: ${Math.floor(this.stats.time)}s/${this.currentLevel!.timeLimit}s`;
        break;
      default:
        statsText += `TARGETS: ${this.targets.filter(t => t.health <= 0).length}/${this.currentLevel!.targetCount}<br>`;
        statsText += `TITAN: ${Math.floor(this.player.titanMeter)}%`;
    }
    
    this.hudElements['stats'].innerHTML = statsText;
  }
  
  togglePause() {
    if (this.state === GameState.PLAYING) {
      this.state = GameState.PAUSED;
      this.hudElements['pause'].style.display = 'flex';
      document.body.style.cursor = 'auto';
    } else if (this.state === GameState.PAUSED) {
      this.state = GameState.PLAYING;
      this.hudElements['pause'].style.display = 'none';
      this.player.lockPointer();
    }
  }
  
  showMainMenu() {
    this.state = GameState.MAIN_MENU;
    
    // Create main menu
    let menu = document.getElementById('main-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'main-menu';
      menu.className = 'menu-overlay';
      menu.innerHTML = `
        <div class="menu-content">
          <h1>TITANFALL 3JS</h1>
          <p style="margin-bottom: 30px; opacity: 0.8;">Advanced Movement FPS</p>
          <button id="start-game-btn" class="menu-button">Start Game</button>
          <button id="level-select-btn" class="menu-button">Level Select</button>
          <div style="margin-top: 30px; font-size: 12px; opacity: 0.6;">
            Arrow keys / WASD to move<br>
            Mouse / Right stick to look<br>
            Space to jump<br>
            Shift to sprint<br>
            Ctrl to slide<br>
            Left click to shoot<br>
            ESC to pause
          </div>
        </div>
      `;
      document.body.appendChild(menu);
    }
    
    menu.classList.remove('hidden');
    document.body.style.cursor = 'auto';
    
    // Level select menu (hidden by default)
    let levelSelect = document.getElementById('level-select');
    if (!levelSelect) {
      levelSelect = document.createElement('div');
      levelSelect.id = 'level-select';
      levelSelect.className = 'menu-overlay hidden';
      levelSelect.innerHTML = `<div class="menu-content"><h1>LEVEL SELECT</h1><div id="level-list"></div><button id="back-to-menu-btn" class="menu-button">Back</button></div>`;
      document.body.appendChild(levelSelect);
      
      // Populate level list
      const levelList = document.getElementById('level-list');
      if (levelList) {
        this.levels.forEach(level => {
          const btn = document.createElement('button');
          btn.className = 'menu-button level-btn';
          btn.textContent = `${level.id}. ${level.name}`;
          btn.onclick = () => this.startGame(level.id);
          levelList.appendChild(btn);
        });
      }
    }
    
    // Event listeners
    document.getElementById('start-game-btn')!.onclick = () => this.startGame(1);
    document.getElementById('level-select-btn')!.onclick = () => {
      menu.classList.add('hidden');
      levelSelect.classList.remove('hidden');
    };
    document.getElementById('back-to-menu-btn')!.onclick = () => {
      levelSelect.classList.add('hidden');
      menu.classList.remove('hidden');
    };
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
    }
    
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(() => this.animate());
  }
}

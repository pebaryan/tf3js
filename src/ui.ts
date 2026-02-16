import { GameState, GameStats } from './types';
import { Level, LevelType } from './levels';
import { Bindings, DEFAULT_BINDINGS, ACTION_LABELS, getBindings, setBindings, keyCodeToLabel } from './keybindings';

export interface HUDUpdateData {
  currentLevel: Level;
  stats: GameStats;
  scoreMultiplier: number;
  playerHealth: number;
  titanDashMeter: number;
  isPilotingTitan: boolean;
  capturePoints: { captured: boolean }[];
  capturedTime: number;
  checkpoints: { completed: boolean }[];
  checkpointProgress: number;
  enemyCount: number;
  destroyedTargets: number;
}

export class GameUI {
  private hudElements: { [key: string]: HTMLElement } = {};

  // Gamepad nav state
  private gamepadIndex: number | null = null;
  private menuFocusIndex = 0;
  private menuButtons: HTMLButtonElement[] = [];
  private gamepadAPrev = false;
  private gamepadBPrev = false;
  private gamepadDpadUpPrev = false;
  private gamepadDpadDownPrev = false;
  private leftStickUpPrev = false;
  private leftStickDownPrev = false;
  private lastMenuState: GameState = GameState.MAIN_MENU;

  // Controls (keybind editor) state
  private isControlsOpen = false;
  private isRebinding = false;
  private controlsRowButtons: Map<string, HTMLButtonElement> = new Map();
  private controlsOnBack: (() => void) | null = null;

  init(onTogglePause: () => void, onCallTitan: () => void): void {
    // HUD container
    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
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
      bottom: 80px;
      left: 20px;
      font-size: 14px;
      text-shadow: 0 0 5px #00ffcc;
    `;
    hud.appendChild(statsDisplay);
    this.hudElements['stats'] = statsDisplay;

    // Health bar container
    const healthContainer = document.createElement('div');
    healthContainer.id = 'health-container';
    healthContainer.style.cssText = `
      position: absolute;
      bottom: 20px;
      left: 20px;
      width: 200px;
      height: 24px;
      background: rgba(0, 0, 0, 0.7);
      border: 2px solid #00ffcc;
      border-radius: 4px;
      padding: 3px;
    `;
    hud.appendChild(healthContainer);

    const healthBar = document.createElement('div');
    healthBar.id = 'health-bar';
    healthBar.style.cssText = `
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #ff0000, #ff6600);
      border-radius: 2px;
      transition: width 0.2s;
    `;
    healthContainer.appendChild(healthBar);

    const healthLabel = document.createElement('div');
    healthLabel.id = 'health-label';
    healthLabel.style.cssText = `
      position: absolute;
      bottom: 45px;
      left: 20px;
      font-size: 12px;
      color: #00ffcc;
      text-shadow: 0 0 5px #00ffcc;
    `;
    healthLabel.textContent = 'HEALTH';
    hud.appendChild(healthLabel);

    // Titan meter container
    const titanContainer = document.createElement('div');
    titanContainer.id = 'titan-container';
    titanContainer.style.cssText = `
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 200px;
      height: 24px;
      background: rgba(0, 0, 0, 0.7);
      border: 2px solid #ff6600;
      border-radius: 4px;
      padding: 3px;
      z-index: 1000;
      visibility: visible !important;
      display: block !important;
    `;
    hud.appendChild(titanContainer);
    console.log('Titan meter created and appended to HUD');

    const titanBar = document.createElement('div');
    titanBar.id = 'titan-bar';
    titanBar.style.cssText = `
      width: 0%;
      min-width: 2px;
      height: 100%;
      background: linear-gradient(90deg, #ff6600, #ffcc00);
      border-radius: 2px;
      transition: width 0.2s;
    `;
    titanContainer.appendChild(titanBar);
    this.hudElements['titanBar'] = titanBar;

    const titanLabel = document.createElement('div');
    titanLabel.id = 'titan-label';
    titanLabel.style.cssText = `
      position: absolute;
      bottom: 45px;
      right: 20px;
      font-size: 12px;
      color: #ff6600;
      text-shadow: 0 0 5px #ff6600;
      z-index: 1000;
      visibility: visible !important;
      display: block !important;
    `;
    titanLabel.textContent = 'TITAN';
    hud.appendChild(titanLabel);
    this.hudElements['titanLabel'] = titanLabel;

    const dashContainer = document.createElement('div');
    dashContainer.id = 'titan-dash-container';
    dashContainer.style.cssText = `
      position: absolute;
      bottom: 60px;
      right: 20px;
      width: 200px;
      height: 12px;
      background: rgba(0, 0, 0, 0.7);
      border: 1px solid #66ccff;
      border-radius: 4px;
      padding: 2px;
      z-index: 1000;
      display: none;
    `;
    hud.appendChild(dashContainer);
    this.hudElements['titanDashContainer'] = dashContainer;

    const dashBar = document.createElement('div');
    dashBar.id = 'titan-dash-bar';
    dashBar.style.cssText = `
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #3399ff, #66ffff);
      border-radius: 2px;
      transition: width 0.08s linear;
    `;
    dashContainer.appendChild(dashBar);
    this.hudElements['titanDashBar'] = dashBar;

    const dashLabel = document.createElement('div');
    dashLabel.id = 'titan-dash-label';
    dashLabel.style.cssText = `
      position: absolute;
      bottom: 76px;
      right: 20px;
      font-size: 11px;
      color: #66ccff;
      text-shadow: 0 0 4px #66ccff;
      z-index: 1000;
      display: none;
    `;
    dashLabel.textContent = 'DASH [SHIFT / A]';
    hud.appendChild(dashLabel);
    this.hudElements['titanDashLabel'] = dashLabel;

    // Embark indicator (shown when near titan)
    const embarkIndicator = document.createElement('div');
    embarkIndicator.id = 'embark-indicator';
    embarkIndicator.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 24px;
      color: #00ffcc;
      text-shadow: 0 0 10px #00ffcc;
      background: rgba(0, 0, 0, 0.8);
      padding: 20px 40px;
      border: 2px solid #00ffcc;
      border-radius: 8px;
      display: none;
      z-index: 200;
      text-align: center;
    `;
    embarkIndicator.innerHTML = 'HOLD [E] TO EMBARK<br><span style="font-size:14px;color:#888;">Or press X on controller</span>';
    hud.appendChild(embarkIndicator);
    this.hudElements['embarkIndicator'] = embarkIndicator;

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
      <div style="margin-top: 20px; font-size: 16px; display: flex; flex-direction: column; gap: 10px;">
        <button id="pause-resume-btn" class="menu-button" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Resume</button>
        <button id="pause-restart-btn" class="menu-button" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Restart</button>
        <button id="pause-controls-btn" class="menu-button" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Controls</button>
        <button id="pause-menu-btn" class="menu-button" style="padding: 10px 30px; font-size: 16px; background: #00ffcc; color: #000; border: none; border-radius: 5px; cursor: pointer;">Main Menu</button>
      </div>
      <div style="margin-top: 15px; font-size: 12px; opacity: 0.7;">
        D-pad: Navigate | A: Select | B: Back
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

    // Keyboard shortcuts (use bound keys)
    document.addEventListener('keydown', (e) => {
      if (this.isRebinding) return;
      const b = getBindings();
      if (e.code === b.pause) onTogglePause();
      else if (e.code === b.callTitan) onCallTitan();
    });

    // Gamepad connection
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
    });
    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) { this.gamepadIndex = i; break; }
    }

    this.buildControlsOverlay();
  }

  updateHUD(data: HUDUpdateData): void {
    const { currentLevel, stats, scoreMultiplier, playerHealth,
            titanDashMeter, isPilotingTitan,
            capturePoints, capturedTime, checkpoints, checkpointProgress,
            enemyCount, destroyedTargets } = data;

    this.hudElements['level-info'].innerHTML = `
      <strong>LEVEL ${currentLevel.id}</strong><br>
      ${currentLevel.name}
    `;

    this.hudElements['score'].innerHTML = `
      SCORE: ${stats.score}
      <span style="color: #00ffff; font-size: 12px;">×${scoreMultiplier.toFixed(1)}</span>
    `;

    this.hudElements['objective'].innerHTML = currentLevel.objective;

    if (currentLevel.timeLimit) {
      const remaining = Math.max(0, currentLevel.timeLimit - stats.time);
      this.hudElements['timer'].innerHTML = `
        TIME: ${Math.floor(remaining)}s
        <span style="color: ${remaining < 10 ? '#ff0000' : '#00ffcc'}; font-size: 12px;">
          ${Math.floor(stats.time)}s elapsed
        </span>
      `;
    } else {
      this.hudElements['timer'].innerHTML = `TIME: ${Math.floor(stats.time)}s`;
    }

    const healthBar = document.getElementById('health-bar');
    if (healthBar) healthBar.style.width = `${playerHealth}%`;

    const titanBar = document.getElementById('titan-bar');
    const titanLabel = document.getElementById('titan-label');
    if (titanBar) titanBar.style.width = `${stats.titanMeter}%`;
    if (titanLabel) {
      if (stats.titanMeter >= 100) {
        titanLabel.textContent = 'TITAN READY [T]';
        titanLabel.style.color = '#ffff00';
        titanLabel.style.textShadow = '0 0 10px #ffff00';
      } else {
        titanLabel.textContent = 'TITAN';
        titanLabel.style.color = '#ff6600';
        titanLabel.style.textShadow = '0 0 5px #ff6600';
      }
    }

    const dashContainer = this.hudElements['titanDashContainer'];
    const dashBar = this.hudElements['titanDashBar'];
    const dashLabel = this.hudElements['titanDashLabel'];
    if (dashContainer && dashBar && dashLabel) {
      dashContainer.style.display = isPilotingTitan ? 'block' : 'none';
      dashLabel.style.display = isPilotingTitan ? 'block' : 'none';
      dashBar.style.width = `${Math.max(0, Math.min(100, titanDashMeter))}%`;
      dashBar.style.filter = titanDashMeter < 40 ? 'saturate(1.8) brightness(1.2)' : 'none';
    }

    let statsText = '';
    switch (currentLevel.type) {
      case LevelType.CAPTURE:
        statsText += `CAPTURED: ${capturePoints.filter(p => p.captured).length}/3<br>`;
        statsText += `HOLD TIME: ${Math.floor(capturedTime)}s/30s`;
        break;
      case LevelType.RACE:
        statsText += `CHECKPOINTS: ${checkpointProgress}/${checkpoints.length}<br>`;
        statsText += `ENEMIES: ${enemyCount}`;
        break;
      case LevelType.SURVIVAL:
        statsText += `ENEMIES: ${enemyCount}<br>`;
        statsText += `TIME: ${Math.floor(stats.time)}s/${currentLevel.timeLimit}s`;
        break;
      default:
        statsText += `TARGETS: ${destroyedTargets}/${currentLevel.targetCount}`;
    }
    this.hudElements['stats'].innerHTML = statsText;
  }

  showMainMenu(levels: Level[], onStartGame: (id: number) => void): void {
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
          <button id="controls-btn" class="menu-button">Controls</button>
        </div>
      `;
      document.body.appendChild(menu);
    }

    menu.classList.remove('hidden');
    document.body.style.cursor = 'auto';

    this.menuButtons = Array.from(menu.querySelectorAll('button'));
    this.menuFocusIndex = 0;
    this.lastMenuState = GameState.MAIN_MENU;
    this.updateMenuFocus();

    let levelSelect = document.getElementById('level-select');
    if (!levelSelect) {
      levelSelect = document.createElement('div');
      levelSelect.id = 'level-select';
      levelSelect.className = 'menu-overlay hidden';
      levelSelect.innerHTML = `<div class="menu-content"><h1>LEVEL SELECT</h1><div id="level-list"></div><button id="back-to-menu-btn" class="menu-button">Back</button></div>`;
      document.body.appendChild(levelSelect);

      const levelList = document.getElementById('level-list');
      if (levelList) {
        levels.forEach(level => {
          const btn = document.createElement('button');
          btn.className = 'menu-button level-btn';
          btn.textContent = `${level.id}. ${level.name}`;
          btn.onclick = () => onStartGame(level.id);
          levelList.appendChild(btn);
        });
      }
    }

    const menuEl = menu;
    const levelSelectEl = levelSelect;

    document.getElementById('start-game-btn')!.onclick = () => onStartGame(1);
    document.getElementById('level-select-btn')!.onclick = () => {
      menuEl.classList.add('hidden');
      levelSelectEl.classList.remove('hidden');
      this.menuButtons = Array.from(levelSelectEl.querySelectorAll('button'));
      this.menuFocusIndex = 0;
      this.updateMenuFocus();
    };
    document.getElementById('back-to-menu-btn')!.onclick = () => {
      levelSelectEl.classList.add('hidden');
      menuEl.classList.remove('hidden');
      this.menuButtons = Array.from(menuEl.querySelectorAll('button'));
      this.menuFocusIndex = 0;
      this.updateMenuFocus();
    };

    document.getElementById('controls-btn')!.onclick = () => {
      menuEl.classList.add('hidden');
      this.showControls(() => {
        menuEl.classList.remove('hidden');
        this.menuButtons = Array.from(menuEl.querySelectorAll('button'));
        this.menuFocusIndex = 0;
        this.updateMenuFocus();
      });
    };
  }

  hideMenus(): void {
    document.getElementById('main-menu')?.classList.add('hidden');
    document.getElementById('level-select')?.classList.add('hidden');
  }

  showPause(onResume: () => void, onRestart: () => void, onMenu: () => void): void {
    this.hudElements['pause'].style.display = 'flex';
    document.getElementById('pause-resume-btn')!.onclick = onResume;
    document.getElementById('pause-restart-btn')!.onclick = onRestart;
    document.getElementById('pause-menu-btn')!.onclick = onMenu;
    document.getElementById('pause-controls-btn')!.onclick = () => {
      this.hudElements['pause'].style.display = 'none';
      this.showControls(() => {
        this.hudElements['pause'].style.display = 'flex';
        this.menuButtons = Array.from(this.hudElements['pause'].querySelectorAll('button'));
        this.menuFocusIndex = 0;
        this.updateMenuFocus();
      });
    };
    this.menuButtons = Array.from(this.hudElements['pause'].querySelectorAll('button'));
    this.menuFocusIndex = 0;
    this.lastMenuState = GameState.PAUSED;
    this.updateMenuFocus();
  }

  hidePause(): void {
    this.hudElements['pause'].style.display = 'none';
  }

  showLevelComplete(stats: GameStats, onNext: () => void, onRestart: () => void, onMenu: () => void): void {
    this.hudElements['level-complete'].style.display = 'flex';
    this.menuButtons = Array.from(this.hudElements['level-complete'].querySelectorAll('button'));
    this.menuFocusIndex = 0;
    this.lastMenuState = GameState.LEVEL_COMPLETE;
    this.updateMenuFocus();

    const statsDiv = document.getElementById('level-stats');
    if (statsDiv) {
      statsDiv.innerHTML = `
        Score: ${stats.score} <br>
        Kills: ${stats.kills} <br>
        Time: ${Math.floor(stats.time)}s <br>
        Objects: ${stats.objectivesCompleted}
      `;
    }

    document.getElementById('next-level-btn')!.onclick = onNext;
    document.getElementById('restart-level-btn')!.onclick = onRestart;
    document.getElementById('menu-level-btn')!.onclick = onMenu;
  }

  showGameOver(stats: GameStats, onRetry: () => void, onMenu: () => void): void {
    this.hudElements['game-over'].style.display = 'flex';
    this.menuButtons = Array.from(this.hudElements['game-over'].querySelectorAll('button'));
    this.menuFocusIndex = 0;
    this.lastMenuState = GameState.GAME_OVER;
    this.updateMenuFocus();

    const statsDiv = document.getElementById('final-stats');
    if (statsDiv) {
      statsDiv.innerHTML = `
        Level: ${stats.level} <br>
        Final Score: ${stats.score} <br>
        Kills: ${stats.kills} <br>
        Time: ${Math.floor(stats.time)}s
      `;
    }

    document.getElementById('retry-btn')!.onclick = onRetry;
    document.getElementById('menu-gameover-btn')!.onclick = onMenu;
  }

  updateMenuNavigation(state: GameState): void {
    if (this.gamepadIndex === null) return;
    if (this.isRebinding) return;

    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;

    // While controls overlay is open, navigate Reset/Back with gamepad
    // (key-row buttons require keyboard and are mouse-only)
    if (this.isControlsOpen) {
      const overlay = document.getElementById('controls-overlay');
      if (!overlay || overlay.classList.contains('hidden')) return;
      const resetBtn = document.getElementById('controls-reset-btn') as HTMLButtonElement | null;
      const backBtn  = document.getElementById('controls-back-btn')  as HTMLButtonElement | null;
      this.menuButtons = [resetBtn, backBtn].filter(Boolean) as HTMLButtonElement[];
      this.runMenuNavigation(gp, false);
      return;
    }

    let menuEl: HTMLElement | null = null;
    if (state === GameState.MAIN_MENU) {
      const levelSelect = document.getElementById('level-select');
      if (levelSelect && !levelSelect.classList.contains('hidden')) {
        menuEl = levelSelect;
      } else {
        menuEl = document.getElementById('main-menu');
      }
    } else if (state === GameState.PAUSED) {
      menuEl = this.hudElements['pause'];
    } else if (state === GameState.LEVEL_COMPLETE) {
      menuEl = this.hudElements['level-complete'];
    } else if (state === GameState.GAME_OVER) {
      menuEl = this.hudElements['game-over'];
    }

    if (!menuEl || menuEl.style.display === 'none' || menuEl.classList.contains('hidden')) return;

    if (this.lastMenuState !== state) {
      this.menuButtons = Array.from(menuEl.querySelectorAll('button'));
      this.menuFocusIndex = 0;
      this.lastMenuState = state;
      this.updateMenuFocus();
    }

    if (this.menuButtons.length === 0) return;

    this.runMenuNavigation(gp, state === GameState.MAIN_MENU);
  }

  private runMenuNavigation(gp: Gamepad, allowBBack: boolean): void {
    if (this.menuButtons.length === 0) return;

    const dpadUp    = gp.buttons[12]?.pressed ?? false;
    const dpadDown  = gp.buttons[13]?.pressed ?? false;
    const aButton   = gp.buttons[0]?.pressed  ?? false;
    const bButton   = gp.buttons[1]?.pressed  ?? false;
    const leftStickY    = gp.axes[1] ?? 0;
    const leftStickUp   = leftStickY < -0.5;
    const leftStickDown = leftStickY > 0.5;

    if ((dpadUp && !this.gamepadDpadUpPrev) || (leftStickUp && !this.leftStickUpPrev)) {
      this.menuFocusIndex = (this.menuFocusIndex - 1 + this.menuButtons.length) % this.menuButtons.length;
      this.updateMenuFocus();
    }

    if ((dpadDown && !this.gamepadDpadDownPrev) || (leftStickDown && !this.leftStickDownPrev)) {
      this.menuFocusIndex = (this.menuFocusIndex + 1) % this.menuButtons.length;
      this.updateMenuFocus();
    }

    if (aButton && !this.gamepadAPrev) {
      this.menuButtons[this.menuFocusIndex].click();
    }

    if (allowBBack && bButton && !this.gamepadBPrev) {
      const backBtn = document.getElementById('back-to-menu-btn');
      if (backBtn && !document.getElementById('level-select')?.classList.contains('hidden')) {
        backBtn.click();
      }
    }

    this.gamepadDpadUpPrev   = dpadUp;
    this.gamepadDpadDownPrev = dpadDown;
    this.gamepadAPrev        = aButton;
    this.gamepadBPrev        = bButton;
    this.leftStickUpPrev     = leftStickUp;
    this.leftStickDownPrev   = leftStickDown;
  }

  private updateMenuFocus(): void {
    this.menuButtons.forEach((btn, index) => {
      if (index === this.menuFocusIndex) {
        btn.style.outline = '3px solid #00ffcc';
        btn.style.boxShadow = '0 0 15px #00ffcc';
      } else {
        btn.style.outline = 'none';
        btn.style.boxShadow = 'none';
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Controls / keybinding editor                                       */
  /* ------------------------------------------------------------------ */

  private buildControlsOverlay(): void {
    const overlay = document.createElement('div');
    overlay.id = 'controls-overlay';
    overlay.className = 'menu-overlay hidden';
    overlay.innerHTML = `
      <div class="menu-content" style="max-width:480px;width:90%;max-height:85vh;overflow-y:auto;">
        <h1>CONTROLS</h1>
        <div id="controls-list" style="margin:16px 0;display:flex;flex-direction:column;gap:8px;"></div>
        <div style="display:flex;gap:12px;justify-content:center;margin-top:8px;">
          <button id="controls-reset-btn" class="menu-button" style="width:auto;padding:10px 20px;font-size:14px;">Reset Defaults</button>
          <button id="controls-back-btn" class="menu-button" style="width:auto;padding:10px 20px;font-size:14px;">Back</button>
        </div>
        <div style="margin-top:12px;font-size:11px;opacity:0.6;">Click a key to rebind | ESC cancels</div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('controls-reset-btn')!.onclick = () => {
      setBindings({ ...DEFAULT_BINDINGS });
      this.rebuildControlsList();
    };
    document.getElementById('controls-back-btn')!.onclick = () => {
      this.hideControls();
    };
  }

  private rebuildControlsList(): void {
    const list = document.getElementById('controls-list');
    if (!list) return;
    list.innerHTML = '';
    this.controlsRowButtons.clear();

    const b = getBindings();
    for (const action of Object.keys(ACTION_LABELS) as (keyof Bindings)[]) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';

      const label = document.createElement('span');
      label.textContent = ACTION_LABELS[action];
      label.style.cssText = 'font-size:14px;color:#00ffcc;min-width:160px;text-align:left;flex-shrink:0;';

      const bindingsContainer = document.createElement('div');
      bindingsContainer.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';

      // Keyboard binding button
      const keyBtn = document.createElement('button');
      keyBtn.className = 'menu-button';
      keyBtn.style.cssText = 'width:100px;margin:0;padding:8px;font-size:13px;font-family:monospace;';
      keyBtn.textContent = `[ ${keyCodeToLabel(b[action])} ]`;
      keyBtn.onclick = () => this.startRebinding(action, keyBtn);

      // Controller binding display
      const controllerLabel = document.createElement('div');
      controllerLabel.style.cssText = 'width:80px;margin:0;padding:8px;font-size:12px;font-family:monospace;background:rgba(0,0,0,0.5);border:1px solid #666;border-radius:4px;color:#888;text-align:center;';
      controllerLabel.textContent = this.getControllerLabel(action);

      this.controlsRowButtons.set(action, keyBtn);
      bindingsContainer.appendChild(keyBtn);
      bindingsContainer.appendChild(controllerLabel);
      row.appendChild(label);
      row.appendChild(bindingsContainer);
      list.appendChild(row);
    }
  }

  private getControllerLabel(action: keyof Bindings): string {
    const controllerMap: Record<string, string> = {
      'forward': 'L-Stick',
      'backward': 'L-Stick',
      'left': 'L-Stick',
      'right': 'L-Stick',
      'jump': 'LB',
      'sprint': 'L-Stick',
      'crouch': 'RB',
      'fire': 'RT',
      'callTitan': 'D-Pad↓',
      'embark': 'X / Hold X',
      'pause': 'Menu',
      'restart': '—',
      'mainMenu': '—'
    };
    return controllerMap[action] || '—';
  }

  private startRebinding(action: keyof Bindings, btn: HTMLButtonElement): void {
    if (this.isRebinding) return;
    this.isRebinding = true;
    btn.textContent = 'PRESS KEY...';
    btn.style.background = '#333';
    btn.style.color = '#ffff00';

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        setBindings({ ...getBindings(), [action]: e.code });
      }
      btn.textContent = `[ ${keyCodeToLabel(getBindings()[action])} ]`;
      btn.style.background = '';
      btn.style.color = '';
      this.isRebinding = false;
    };
    document.addEventListener('keydown', handler, { once: true, capture: true });
  }

  showControls(onBack: () => void): void {
    this.isControlsOpen = true;
    this.controlsOnBack = onBack;
    this.rebuildControlsList();
    const overlay = document.getElementById('controls-overlay')!;
    overlay.classList.remove('hidden');
    // Gamepad navigates only Reset/Back; key-row buttons are mouse-only
    const resetBtn = document.getElementById('controls-reset-btn') as HTMLButtonElement | null;
    const backBtn  = document.getElementById('controls-back-btn')  as HTMLButtonElement | null;
    this.menuButtons = [resetBtn, backBtn].filter(Boolean) as HTMLButtonElement[];
    this.menuFocusIndex = 0;
    this.updateMenuFocus();
  }

  hideControls(): void {
    this.isControlsOpen = false;
    document.getElementById('controls-overlay')?.classList.add('hidden');
    const cb = this.controlsOnBack;
    this.controlsOnBack = null;
    if (cb) cb();
  }

  showEmbarkIndicator(show: boolean): void {
    const indicator = document.getElementById('embark-indicator');
    if (indicator) {
      indicator.style.display = show ? 'block' : 'none';
    }
  }

  showPilotingIndicator(show: boolean): void {
    // Check if indicator exists, create if not
    let indicator = document.getElementById('piloting-indicator');
    if (!indicator && show) {
      indicator = document.createElement('div');
      indicator.id = 'piloting-indicator';
      indicator.style.cssText = `
        position: absolute;
        top: 20%;
        left: 50%;
        transform: translateX(-50%);
        font-size: 32px;
        color: #00ffcc;
        text-shadow: 0 0 20px #00ffcc;
        background: rgba(0, 0, 0, 0.8);
        padding: 20px 40px;
        border: 3px solid #00ffcc;
        border-radius: 10px;
        z-index: 300;
        text-align: center;
        font-family: 'Orbitron', sans-serif;
        animation: pulse 1s infinite;
      `;
      indicator.innerHTML = '⚡ PILOTING TITAN ⚡<br><span style="font-size:16px;color:#888;">Hold [E] or X to disembark</span>';
      
      // Add pulse animation
      const style = document.createElement('style');
      style.textContent = `
        @keyframes pulse {
          0%, 100% { transform: translateX(-50%) scale(1); }
          50% { transform: translateX(-50%) scale(1.05); }
        }
      `;
      document.head.appendChild(style);
      
      const hud = document.getElementById('game-hud');
      if (hud) hud.appendChild(indicator);
    }
    
    if (indicator) {
      indicator.style.display = show ? 'block' : 'none';
    }
  }
}

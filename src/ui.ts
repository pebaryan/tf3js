import { DebugHUDData, GameState, GameStats, WeaponHUDData } from './types';
import { Level, LevelType } from './levels';
import { Bindings, DEFAULT_BINDINGS, ACTION_LABELS, getBindings, setBindings, keyCodeToLabel, AimCurve, AIM_CURVE_LABELS, getAimCurve, setAimCurve } from './keybindings';

export interface HUDUpdateData {
  currentLevel: Level;
  stats: GameStats;
  scoreMultiplier: number;
  playerHealth: number;
  titanDashMeter: number;
  isPilotingTitan: boolean;
  titanHealth: number;
  titanShield: number;
  capturePoints: { captured: boolean }[];
  capturedTime: number;
  checkpoints: { completed: boolean }[];
  checkpointProgress: number;
  enemyCount: number;
  destroyedTargets: number;
  showSniperScope: boolean;
  weapon: WeaponHUDData;
  debug: DebugHUDData;
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

  // Titan visor state
  private _wasPiloting = false;
  private visorOverlay: HTMLElement | null = null;

  // Controls (keybind editor) state
  private isControlsOpen = false;
  private isRebinding = false;
  private controlsRowButtons: Map<string, HTMLButtonElement> = new Map();
  private controlsOnBack: (() => void) | null = null;

  init(onTogglePause: () => void, onCallTitan: () => void): void {
    // Global Visor Container
    const visor = document.createElement('div');
    visor.id = 'visor-container';
    visor.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 100;
      perspective: 1000px;
      overflow: hidden;
    `;
    document.body.appendChild(visor);

    // Visor Overlay (Scanlines + Vignette)
    const visorOverlay = document.createElement('div');
    visorOverlay.style.cssText = `
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at center, transparent 50%, rgba(0, 20, 20, 0.4) 100%),
        repeating-linear-gradient(rgba(0, 255, 204, 0.03) 0, rgba(0, 255, 204, 0.03) 1px, transparent 1px, transparent 4px);
      pointer-events: none;
      z-index: 10;
      transition: background 0.4s ease;
    `;
    visor.appendChild(visorOverlay);
    this.visorOverlay = visorOverlay;

    // HUD Content Wrapper (The curved part)
    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.cssText = `
      position: absolute;
      inset: 5%;
      color: #00ffcc;
      font-family: 'Orbitron', sans-serif;
      transform-style: preserve-3d;
    `;
    visor.appendChild(hud);

    // Left elements (Curved Left)
    const hudLeft = document.createElement('div');
    hudLeft.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      width: 300px;
      transform: rotateY(15deg);
      transform-origin: left center;
    `;
    hud.appendChild(hudLeft);

    // Right elements (Curved Right)
    const hudRight = document.createElement('div');
    hudRight.style.cssText = `
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 300px;
      transform: rotateY(-15deg);
      transform-origin: right center;
    `;
    hud.appendChild(hudRight);

    // Top elements (Center)
    const hudTop = document.createElement('div');
    hudTop.style.cssText = `
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%) rotateX(-10deg);
      transform-origin: center top;
      text-align: center;
    `;
    hud.appendChild(hudTop);

    // Level info
    const levelInfo = document.createElement('div');
    levelInfo.id = 'level-info';
    levelInfo.style.cssText = `
      margin-bottom: 10px;
      font-size: 16px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 10px rgba(0, 0, 0, 0.8);
      background: linear-gradient(90deg, rgba(0, 255, 204, 0.1), transparent);
      padding: 8px 15px;
      border-left: 3px solid #00ffcc;
      clip-path: polygon(0 0, 100% 0, 90% 100%, 0% 100%);
    `;
    hudLeft.appendChild(levelInfo);
    this.hudElements['level-info'] = levelInfo;

    // Score
    const scoreDisplay = document.createElement('div');
    scoreDisplay.id = 'score-display';
    scoreDisplay.style.cssText = `
      margin-top: 5px;
      margin-left: 15px;
      font-size: 18px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px rgba(0, 0, 0, 0.8);
      letter-spacing: 2px;
    `;
    hudLeft.appendChild(scoreDisplay);
    this.hudElements['score'] = scoreDisplay;

    // Objective
    const objectiveDisplay = document.createElement('div');
    objectiveDisplay.id = 'objective-display';
    objectiveDisplay.style.cssText = `
      margin-top: 20px;
      margin-left: 15px;
      font-size: 13px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px rgba(0, 0, 0, 0.8);
      max-width: 250px;
      opacity: 0.8;
      border-bottom: 1px solid rgba(0, 255, 204, 0.3);
      padding-bottom: 5px;
    `;
    hudLeft.appendChild(objectiveDisplay);
    this.hudElements['objective'] = objectiveDisplay;

    // Timer
    const timerDisplay = document.createElement('div');
    timerDisplay.id = 'timer-display';
    timerDisplay.style.cssText = `
      font-size: 20px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 12px rgba(0, 0, 0, 0.9);
      background: rgba(0, 0, 0, 0.4);
      padding: 10px 30px;
      border-bottom: 2px solid #00ffcc;
      clip-path: polygon(0 0, 100% 0, 90% 100%, 10% 100%);
    `;
    hudTop.appendChild(timerDisplay);
    this.hudElements['timer'] = timerDisplay;

    // Stats
    const statsDisplay = document.createElement('div');
    statsDisplay.id = 'stats-display';
    statsDisplay.style.cssText = `
      position: absolute;
      bottom: 100px;
      left: 0;
      font-size: 14px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px rgba(0, 0, 0, 0.8);
      background: rgba(0, 40, 40, 0.3);
      padding: 10px;
      border-left: 2px solid #00ffcc;
    `;
    hudLeft.appendChild(statsDisplay);
    this.hudElements['stats'] = statsDisplay;

    // Health bar container
    const healthContainer = document.createElement('div');
    healthContainer.id = 'health-container';
    healthContainer.style.cssText = `
      position: absolute;
      bottom: 20px;
      left: 0;
      width: 240px;
      height: 30px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(0, 255, 204, 0.5);
      clip-path: polygon(0 0, 95% 0, 99% 100%, 0 100%);
      padding: 4px;
    `;
    hudLeft.appendChild(healthContainer);

    const healthBar = document.createElement('div');
    healthBar.id = 'health-bar';
    healthBar.style.cssText = `
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #00ffcc, #008866);
      box-shadow: 0 0 15px rgba(0, 255, 204, 0.4);
      transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    `;
    healthContainer.appendChild(healthBar);

    const healthLabel = document.createElement('div');
    healthLabel.style.cssText = `
      position: absolute;
      bottom: 55px;
      left: 5px;
      font-size: 11px;
      color: #00ffcc;
      letter-spacing: 1px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px #000;
    `;
    healthLabel.textContent = 'VITALS // SYSTEM STABLE';
    hudLeft.appendChild(healthLabel);
    this.hudElements['healthLabel'] = healthLabel;
    this.hudElements['healthBar'] = healthBar;
    this.hudElements['healthContainer'] = healthContainer;

    // Titan shield bar (shown only when piloting titan)
    const shieldContainer = document.createElement('div');
    shieldContainer.id = 'shield-container';
    shieldContainer.style.cssText = `
      position: absolute;
      bottom: 70px;
      left: 0;
      width: 200px;
      height: 14px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(100, 180, 255, 0.5);
      clip-path: polygon(0 0, 95% 0, 99% 100%, 0 100%);
      padding: 2px;
      display: none;
    `;
    hudLeft.appendChild(shieldContainer);
    this.hudElements['shieldContainer'] = shieldContainer;

    const shieldBar = document.createElement('div');
    shieldBar.id = 'shield-bar';
    shieldBar.style.cssText = `
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #4488ff, #88ccff);
      box-shadow: 0 0 10px rgba(68, 136, 255, 0.4);
      transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    `;
    shieldContainer.appendChild(shieldBar);
    this.hudElements['shieldBar'] = shieldBar;

    const shieldLabel = document.createElement('div');
    shieldLabel.style.cssText = `
      position: absolute;
      bottom: 88px;
      left: 5px;
      font-size: 10px;
      color: #4488ff;
      letter-spacing: 1px;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px #000;
      display: none;
    `;
    shieldLabel.textContent = 'SHIELD MATRIX';
    hudLeft.appendChild(shieldLabel);
    this.hudElements['shieldLabel'] = shieldLabel;

    // Titan meter container
    const titanContainer = document.createElement('div');
    titanContainer.id = 'titan-container';
    titanContainer.style.cssText = `
      position: absolute;
      bottom: 20px;
      right: 0;
      width: 240px;
      height: 30px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 102, 0, 0.5);
      clip-path: polygon(5% 0, 100% 0, 100% 100%, 1% 100%);
      padding: 4px;
    `;
    hudRight.appendChild(titanContainer);

    const titanBar = document.createElement('div');
    titanBar.id = 'titan-bar';
    titanBar.style.cssText = `
      width: 0%;
      height: 100%;
      background: linear-gradient(90deg, #ff6600, #ffcc00);
      box-shadow: 0 0 15px rgba(255, 102, 0, 0.4);
      transition: width 0.3s;
    `;
    titanContainer.appendChild(titanBar);
    this.hudElements['titanBar'] = titanBar;

    const titanLabel = document.createElement('div');
    titanLabel.id = 'titan-label';
    titanLabel.style.cssText = `
      position: absolute;
      bottom: 55px;
      right: 5px;
      font-size: 11px;
      color: #ff6600;
      letter-spacing: 1px;
      text-align: right;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px #000;
    `;
    titanLabel.textContent = 'NEURAL LINK // SYNCING';
    hudRight.appendChild(titanLabel);
    this.hudElements['titanLabel'] = titanLabel;

    const dashContainer = document.createElement('div');
    dashContainer.id = 'titan-dash-container';
    dashContainer.style.cssText = `
      position: absolute;
      bottom: 65px;
      right: 0;
      width: 180px;
      height: 10px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(102, 204, 255, 0.4);
      padding: 2px;
      display: none;
    `;
    hudRight.appendChild(dashContainer);
    this.hudElements['titanDashContainer'] = dashContainer;

    const dashBar = document.createElement('div');
    dashBar.id = 'titan-dash-bar';
    dashBar.style.cssText = `
      width: 100%;
      height: 100%;
      background: #66ccff;
      transition: width 0.1s linear;
    `;
    dashContainer.appendChild(dashBar);
    this.hudElements['titanDashBar'] = dashBar;

    const dashLabel = document.createElement('div');
    dashLabel.id = 'titan-dash-label';
    dashLabel.style.cssText = `
      position: absolute;
      bottom: 80px;
      right: 0;
      font-size: 10px;
      color: #66ccff;
      display: none;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 8px #000;
    `;
    dashLabel.textContent = 'DASH SYSTEMS';
    hudRight.appendChild(dashLabel);
    this.hudElements['titanDashLabel'] = dashLabel;

    const debugPanel = document.createElement('div');
    debugPanel.id = 'debug-panel';
    debugPanel.style.cssText = `
      position: absolute;
      top: 0;
      right: 0;
      width: 240px;
      padding: 12px 16px 12px 22px;
      background: linear-gradient(270deg, rgba(0, 0, 0, 0.64), rgba(0, 28, 36, 0.2));
      border-right: 2px solid rgba(102, 255, 214, 0.7);
      border-top: 1px solid rgba(102, 255, 214, 0.25);
      border-bottom: 1px solid rgba(102, 255, 214, 0.2);
      clip-path: polygon(3% 0, 100% 0, 100% 100%, 15% 100%);
      text-align: right;
      box-shadow: 0 0 16px rgba(0, 255, 204, 0.1);
    `;
    hudRight.appendChild(debugPanel);
    this.hudElements['debugPanel'] = debugPanel;

    const debugLabel = document.createElement('div');
    debugLabel.style.cssText = `
      font-size: 10px;
      letter-spacing: 2px;
      color: rgba(180, 255, 240, 0.7);
      margin-bottom: 8px;
    `;
    debugLabel.textContent = 'PILOT TELEMETRY';
    debugPanel.appendChild(debugLabel);
    this.hudElements['debugLabel'] = debugLabel;

    const debugState = document.createElement('div');
    debugState.id = 'debug-state';
    debugState.style.cssText = `
      font-size: 20px;
      letter-spacing: 1.5px;
      color: #8affea;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 10px rgba(0, 0, 0, 0.8);
    `;
    debugPanel.appendChild(debugState);
    this.hudElements['debugState'] = debugState;

    const debugSpeed = document.createElement('div');
    debugSpeed.id = 'debug-speed';
    debugSpeed.style.cssText = `
      margin-top: 4px;
      font-size: 30px;
      line-height: 1;
      color: #f5fffd;
    `;
    debugPanel.appendChild(debugSpeed);
    this.hudElements['debugSpeed'] = debugSpeed;

    const debugVelocity = document.createElement('div');
    debugVelocity.id = 'debug-velocity';
    debugVelocity.style.cssText = `
      margin-top: 8px;
      font-size: 11px;
      line-height: 1.5;
      letter-spacing: 1px;
      color: rgba(220, 255, 250, 0.78);
    `;
    debugPanel.appendChild(debugVelocity);
    this.hudElements['debugVelocity'] = debugVelocity;

    const debugFlags = document.createElement('div');
    debugFlags.id = 'debug-flags';
    debugFlags.style.cssText = `
      margin-top: 8px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    `;
    debugPanel.appendChild(debugFlags);
    this.hudElements['debugFlags'] = debugFlags;

    const weaponPanel = document.createElement('div');
    weaponPanel.id = 'weapon-panel';
    weaponPanel.style.cssText = `
      position: absolute;
      bottom: 115px;
      right: 0;
      width: 250px;
      padding: 14px 18px 12px 24px;
      background: linear-gradient(270deg, rgba(0, 0, 0, 0.68), rgba(0, 48, 40, 0.18));
      border-right: 3px solid #00ffcc;
      border-top: 1px solid rgba(0, 255, 204, 0.25);
      border-bottom: 1px solid rgba(0, 255, 204, 0.25);
      clip-path: polygon(5% 0, 100% 0, 100% 100%, 5% 100%);
      box-shadow: 0 0 18px rgba(0, 255, 204, 0.12);
    `;
    hudRight.appendChild(weaponPanel);
    this.hudElements['weaponPanel'] = weaponPanel;

    const weaponLabel = document.createElement('div');
    weaponLabel.style.cssText = `
      font-size: 10px;
      letter-spacing: 2px;
      color: rgba(180, 255, 240, 0.7);
      margin-bottom: 6px;
      text-align: right;
    `;
    weaponLabel.textContent = 'ARMAMENT STATUS';
    weaponPanel.appendChild(weaponLabel);
    this.hudElements['weaponLabel'] = weaponLabel;

    const weaponName = document.createElement('div');
    weaponName.id = 'weapon-name';
    weaponName.style.cssText = `
      font-size: 22px;
      letter-spacing: 1.5px;
      text-align: right;
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 10px rgba(0, 0, 0, 0.9);
    `;
    weaponPanel.appendChild(weaponName);
    this.hudElements['weaponName'] = weaponName;

    const ammoRow = document.createElement('div');
    ammoRow.style.cssText = `
      display: flex;
      justify-content: flex-end;
      align-items: baseline;
      gap: 8px;
      margin-top: 8px;
    `;
    weaponPanel.appendChild(ammoRow);

    const ammoCount = document.createElement('div');
    ammoCount.id = 'ammo-count';
    ammoCount.style.cssText = `
      font-size: 34px;
      line-height: 1;
      font-weight: 700;
      text-shadow: 0 0 14px rgba(0, 255, 204, 0.2);
    `;
    ammoRow.appendChild(ammoCount);
    this.hudElements['ammoCount'] = ammoCount;

    const ammoMeta = document.createElement('div');
    ammoMeta.id = 'ammo-meta';
    ammoMeta.style.cssText = `
      font-size: 11px;
      line-height: 1.4;
      letter-spacing: 1px;
      text-align: right;
      color: rgba(220, 255, 250, 0.75);
    `;
    ammoRow.appendChild(ammoMeta);
    this.hudElements['ammoMeta'] = ammoMeta;

    const ammoBarFrame = document.createElement('div');
    ammoBarFrame.style.cssText = `
      width: 100%;
      height: 8px;
      margin-top: 10px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(0, 255, 204, 0.2);
      overflow: hidden;
    `;
    weaponPanel.appendChild(ammoBarFrame);

    const ammoBar = document.createElement('div');
    ammoBar.id = 'ammo-bar';
    ammoBar.style.cssText = `
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #00ffcc, #8affea);
      transition: width 0.12s linear;
    `;
    ammoBarFrame.appendChild(ammoBar);
    this.hudElements['ammoBar'] = ammoBar;

    const ammoPips = document.createElement('div');
    ammoPips.id = 'ammo-pips';
    ammoPips.style.cssText = `
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      gap: 4px;
      margin-top: 10px;
    `;
    weaponPanel.appendChild(ammoPips);
    this.hudElements['ammoPips'] = ammoPips;

    const weaponSlots = document.createElement('div');
    weaponSlots.id = 'weapon-slots';
    weaponSlots.style.cssText = `
      margin-top: 12px;
      display: grid;
      gap: 4px;
      font-size: 11px;
      letter-spacing: 1px;
    `;
    weaponPanel.appendChild(weaponSlots);
    this.hudElements['weaponSlots'] = weaponSlots;

    const weaponAttachments = document.createElement('div');
    weaponAttachments.id = 'weapon-attachments';
    weaponAttachments.style.cssText = `
      margin-top: 10px;
      font-size: 10px;
      line-height: 1.5;
      text-align: right;
      color: rgba(190, 220, 220, 0.75);
      min-height: 30px;
    `;
    weaponPanel.appendChild(weaponAttachments);
    this.hudElements['weaponAttachments'] = weaponAttachments;

    const utilityRow = document.createElement('div');
    utilityRow.id = 'weapon-utility';
    utilityRow.style.cssText = `
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(0, 255, 204, 0.18);
      font-size: 11px;
      line-height: 1.6;
      text-align: right;
    `;
    weaponPanel.appendChild(utilityRow);
    this.hudElements['weaponUtility'] = utilityRow;

    const sniperScope = document.createElement('div');
    sniperScope.id = 'sniper-scope';
    sniperScope.style.cssText = `
      position: absolute;
      inset: 0;
      display: none;
      pointer-events: none;
      z-index: 150;
    `;
    sniperScope.innerHTML = `
      <div style="
        position:absolute;
        top:50%;
        left:50%;
        width:min(72vw, 72vh);
        height:min(72vw, 72vh);
        transform:translate(-50%, -50%);
        border:2px solid rgba(180, 255, 255, 0.9);
        border-radius:50%;
        box-shadow:0 0 0 200vmax rgba(0, 0, 0, 0.88), 0 0 30px rgba(120, 255, 255, 0.25);
      "></div>
      <div style="
        position:absolute;
        top:50%;
        left:50%;
        width:1px;
        height:min(72vw, 72vh);
        transform:translate(-50%, -50%);
        background:rgba(180, 255, 255, 0.75);
      "></div>
      <div style="
        position:absolute;
        top:50%;
        left:50%;
        width:min(72vw, 72vh);
        height:1px;
        transform:translate(-50%, -50%);
        background:rgba(180, 255, 255, 0.75);
      "></div>
      <div style="
        position:absolute;
        top:50%;
        left:50%;
        width:10px;
        height:10px;
        transform:translate(-50%, -50%);
        border:1px solid rgba(180, 255, 255, 0.95);
        border-radius:50%;
        box-shadow:0 0 8px rgba(180, 255, 255, 0.45);
      "></div>
    `;
    hud.appendChild(sniperScope);
    this.hudElements['sniperScope'] = sniperScope;

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
      text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 12px rgba(0, 0, 0, 0.9);
      background: rgba(0, 0, 0, 0.8);
      padding: 20px 40px;
      border: 2px solid #00ffcc;
      border-radius: 8px;
      display: none;
      z-index: 200;
      text-align: center;
    `;
    embarkIndicator.innerHTML = 'HOLD [E] TO EMBARK<br><span style="font-size:14px;color:#888;">Or hold X on controller</span>';
    hud.appendChild(embarkIndicator);
    this.hudElements['embarkIndicator'] = embarkIndicator;

    // Pause overlay
    const pauseOverlay = document.createElement('div');
    pauseOverlay.id = 'pause-overlay';
    pauseOverlay.className = 'menu-overlay';
    pauseOverlay.style.display = 'none';
    pauseOverlay.innerHTML = `
      <div class="scanline"></div>
      <div class="menu-content">
        <h1>PAUSED</h1>
        <div class="menu-subtitle">System Status: Suspended // Neural Link Standby</div>
        <div style="margin-top: 20px; display: flex; flex-direction: column; gap: 10px;">
          <button id="pause-resume-btn" class="menu-button">Resume Mission</button>
          <button id="pause-restart-btn" class="menu-button">Restart Session</button>
          <button id="pause-controls-btn" class="menu-button">Configurations</button>
          <button id="pause-menu-btn" class="menu-button">Abort to Hub</button>
        </div>
        <div style="margin-top: 20px; font-size: 12px; opacity: 0.5; color: #00ffcc; letter-spacing: 1px;">
          DPAD: NAVIGATE | A: SELECT | B: BACK
        </div>
      </div>
    `;
    document.body.appendChild(pauseOverlay);
    this.hudElements['pause'] = pauseOverlay;

    // Level complete overlay
    const levelCompleteOverlay = document.createElement('div');
    levelCompleteOverlay.id = 'level-complete-overlay';
    levelCompleteOverlay.className = 'menu-overlay';
    levelCompleteOverlay.style.display = 'none';
    levelCompleteOverlay.innerHTML = `
      <div class="scanline"></div>
      <div class="menu-content">
        <h1>MISSION COMPLETE</h1>
        <div class="menu-subtitle">Objectives Secured // Performance Analysis</div>
        <div id="level-stats" style="font-size: 18px; margin: 30px 0; color: #00ffcc; line-height: 1.6; letter-spacing: 1px; text-transform: uppercase;"></div>
        <div style="display: flex; gap: 20px; justify-content: center;">
          <button id="next-level-btn" class="menu-button" style="width: 200px;">Next Mission</button>
          <button id="restart-level-btn" class="menu-button" style="width: 200px;">Re-run</button>
          <button id="menu-level-btn" class="menu-button" style="width: 200px;">Return</button>
        </div>
      </div>
    `;
    document.body.appendChild(levelCompleteOverlay);
    this.hudElements['level-complete'] = levelCompleteOverlay;

    // Game over overlay
    const gameOverOverlay = document.createElement('div');
    gameOverOverlay.id = 'game-over-overlay';
    gameOverOverlay.className = 'menu-overlay';
    gameOverOverlay.style.display = 'none';
    gameOverOverlay.style.color = '#ff4444'; // Overriding the default cyan
    gameOverOverlay.innerHTML = `
      <div class="scanline"></div>
      <div class="menu-content" style="border-color: rgba(255, 68, 68, 0.5); box-shadow: 0 0 40px rgba(255, 0, 0, 0.2);">
        <h1 style="color: #ff4444; text-shadow: 0 0 20px rgba(255, 68, 68, 0.7);">PILOT DOWN</h1>
        <div class="menu-subtitle" style="color: #ff4444;">Neural Link Severed // Mission Failed</div>
        <div id="final-stats" style="font-size: 18px; margin: 30px 0; color: #ff4444; line-height: 1.6; letter-spacing: 1px; text-transform: uppercase;"></div>
        <div style="display: flex; gap: 20px; justify-content: center;">
          <button id="retry-btn" class="menu-button" style="width: 200px; color: #ff4444; border-color: rgba(255, 68, 68, 0.5);">Retry</button>
          <button id="menu-gameover-btn" class="menu-button" style="width: 200px;">Return</button>
        </div>
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

  private applyVisorTheme(titan: boolean): void {
    // Visor overlay
    if (this.visorOverlay) {
      this.visorOverlay.style.background = titan
        ? `radial-gradient(circle at center, transparent 40%, rgba(20, 10, 0, 0.55) 100%),
           repeating-linear-gradient(rgba(255, 140, 0, 0.04) 0, rgba(255, 140, 0, 0.04) 1px, transparent 1px, transparent 3px)`
        : `radial-gradient(circle at center, transparent 50%, rgba(0, 20, 20, 0.4) 100%),
           repeating-linear-gradient(rgba(0, 255, 204, 0.03) 0, rgba(0, 255, 204, 0.03) 1px, transparent 1px, transparent 4px)`;
    }

    const accent = titan ? '#ff6600' : '#00ffcc';
    const accentRgba = titan ? 'rgba(255, 102, 0,' : 'rgba(0, 255, 204,';

    // Level info
    const levelInfo = this.hudElements['level-info'];
    if (levelInfo) {
      levelInfo.style.background = `linear-gradient(90deg, ${accentRgba} 0.1), transparent)`;
      levelInfo.style.borderLeftColor = accent;
    }

    // Timer
    const timer = this.hudElements['timer'];
    if (timer) timer.style.borderBottomColor = accent;

    // Stats
    const stats = this.hudElements['stats'];
    if (stats) stats.style.borderLeftColor = accent;

    // Health bar area
    const healthContainer = this.hudElements['healthContainer'];
    if (healthContainer) {
      healthContainer.style.borderColor = titan ? 'rgba(255, 102, 0, 0.5)' : 'rgba(0, 255, 204, 0.5)';
    }
    const healthBar = this.hudElements['healthBar'];
    if (healthBar) {
      healthBar.style.background = titan
        ? 'linear-gradient(90deg, #ff6600, #cc4400)'
        : 'linear-gradient(90deg, #00ffcc, #008866)';
      healthBar.style.boxShadow = titan
        ? '0 0 15px rgba(255, 102, 0, 0.4)'
        : '0 0 15px rgba(0, 255, 204, 0.4)';
    }
    const healthLabel = this.hudElements['healthLabel'];
    if (healthLabel) {
      healthLabel.textContent = titan ? 'HULL INTEGRITY' : 'VITALS // SYSTEM STABLE';
      healthLabel.style.color = accent;
    }

    // Shield bar (titan only)
    const shieldContainer = this.hudElements['shieldContainer'];
    if (shieldContainer) shieldContainer.style.display = titan ? 'block' : 'none';
    const shieldLabel = this.hudElements['shieldLabel'];
    if (shieldLabel) shieldLabel.style.display = titan ? 'block' : 'none';

    // Titan meter (hide when piloting — you're already in the titan)
    const titanContainer = document.getElementById('titan-container');
    if (titanContainer) titanContainer.style.display = titan ? 'none' : 'block';
    const titanLabel = this.hudElements['titanLabel'];
    if (titanLabel) titanLabel.style.display = titan ? 'none' : 'block';

    // Debug panel
    const debugPanel = this.hudElements['debugPanel'];
    if (debugPanel) {
      debugPanel.style.borderRightColor = titan ? 'rgba(255, 160, 60, 0.7)' : 'rgba(102, 255, 214, 0.7)';
      debugPanel.style.borderTopColor = titan ? 'rgba(255, 160, 60, 0.25)' : 'rgba(102, 255, 214, 0.25)';
      debugPanel.style.borderBottomColor = titan ? 'rgba(255, 160, 60, 0.2)' : 'rgba(102, 255, 214, 0.2)';
      debugPanel.style.background = titan
        ? 'linear-gradient(270deg, rgba(0, 0, 0, 0.64), rgba(36, 18, 0, 0.2))'
        : 'linear-gradient(270deg, rgba(0, 0, 0, 0.64), rgba(0, 28, 36, 0.2))';
      debugPanel.style.boxShadow = titan ? '0 0 16px rgba(255, 102, 0, 0.1)' : '0 0 16px rgba(0, 255, 204, 0.1)';
    }
    const debugLabel = this.hudElements['debugLabel'];
    if (debugLabel) {
      debugLabel.textContent = titan ? 'TITAN OS v3.2' : 'PILOT TELEMETRY';
      debugLabel.style.color = titan ? 'rgba(255, 200, 140, 0.7)' : 'rgba(180, 255, 240, 0.7)';
    }
    const debugState = this.hudElements['debugState'];
    if (debugState) debugState.style.color = titan ? '#ffcc88' : '#8affea';
    const debugSpeed = this.hudElements['debugSpeed'];
    if (debugSpeed) debugSpeed.style.color = titan ? '#fff0e0' : '#f5fffd';
    const debugVelocity = this.hudElements['debugVelocity'];
    if (debugVelocity) debugVelocity.style.color = titan ? 'rgba(255, 220, 180, 0.78)' : 'rgba(220, 255, 250, 0.78)';

    // Weapon panel
    const weaponPanel = this.hudElements['weaponPanel'];
    if (weaponPanel) {
      weaponPanel.style.borderRightColor = titan ? '#ff6600' : '#00ffcc';
      weaponPanel.style.borderTopColor = titan ? 'rgba(255, 102, 0, 0.25)' : 'rgba(0, 255, 204, 0.25)';
      weaponPanel.style.borderBottomColor = titan ? 'rgba(255, 102, 0, 0.25)' : 'rgba(0, 255, 204, 0.25)';
      weaponPanel.style.background = titan
        ? 'linear-gradient(270deg, rgba(0, 0, 0, 0.68), rgba(48, 24, 0, 0.18))'
        : 'linear-gradient(270deg, rgba(0, 0, 0, 0.68), rgba(0, 48, 40, 0.18))';
    }
    const weaponLabel = this.hudElements['weaponLabel'];
    if (weaponLabel) {
      weaponLabel.textContent = titan ? 'TITAN ARMAMENT' : 'ARMAMENT STATUS';
      weaponLabel.style.color = titan ? 'rgba(255, 200, 140, 0.7)' : 'rgba(180, 255, 240, 0.7)';
    }

    // Dash container accent
    const dashContainer = this.hudElements['titanDashContainer'];
    if (dashContainer) {
      dashContainer.style.borderColor = titan ? 'rgba(255, 160, 60, 0.4)' : 'rgba(102, 204, 255, 0.4)';
    }
    const dashBar = this.hudElements['titanDashBar'];
    if (dashBar) dashBar.style.background = titan ? '#ff8844' : '#66ccff';
    const dashLabel = this.hudElements['titanDashLabel'];
    if (dashLabel) dashLabel.style.color = titan ? '#ff8844' : '#66ccff';
  }

  updateHUD(data: HUDUpdateData): void {
    const { currentLevel, stats, scoreMultiplier, playerHealth,
            titanDashMeter, isPilotingTitan, titanHealth, titanShield,
            capturePoints, capturedTime, checkpoints, checkpointProgress,
            enemyCount, destroyedTargets, showSniperScope, weapon, debug } = data;

    // Theme switch on state change
    if (isPilotingTitan !== this._wasPiloting) {
      this._wasPiloting = isPilotingTitan;
      this.applyVisorTheme(isPilotingTitan);
    }

    const accent = isPilotingTitan ? '#ff6600' : '#00ffcc';

    this.hudElements['level-info'].innerHTML = isPilotingTitan
      ? `<strong>TITAN ACTIVE</strong><br>${currentLevel.name}`
      : `<strong>LEVEL ${currentLevel.id}</strong><br>${currentLevel.name}`;

    this.hudElements['score'].innerHTML = `
      SCORE: ${stats.score}
      <span style="color: ${isPilotingTitan ? '#ffaa44' : '#00ffff'}; font-size: 12px;">&times;${scoreMultiplier.toFixed(1)}</span>
    `;

    this.hudElements['objective'].innerHTML = currentLevel.objective;

    if (currentLevel.timeLimit) {
      const remaining = Math.max(0, currentLevel.timeLimit - stats.time);
      this.hudElements['timer'].innerHTML = `
        TIME: ${Math.floor(remaining)}s
        <span style="color: ${remaining < 10 ? '#ff0000' : accent}; font-size: 12px;">
          ${Math.floor(stats.time)}s elapsed
        </span>
      `;
    } else {
      this.hudElements['timer'].innerHTML = `TIME: ${Math.floor(stats.time)}s`;
    }

    // Health: show titan hull when piloting, pilot health otherwise
    const healthBar = this.hudElements['healthBar'];
    if (healthBar) healthBar.style.width = `${isPilotingTitan ? titanHealth : playerHealth}%`;

    // Shield bar (titan only)
    const shieldBar = this.hudElements['shieldBar'];
    if (shieldBar) shieldBar.style.width = `${titanShield}%`;

    // Titan call meter (hidden when piloting)
    if (!isPilotingTitan) {
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
    }

    // Dash meter (titan only)
    const dashContainer = this.hudElements['titanDashContainer'];
    const dashBar = this.hudElements['titanDashBar'];
    const dashLabel = this.hudElements['titanDashLabel'];
    if (dashContainer && dashBar && dashLabel) {
      dashContainer.style.display = isPilotingTitan ? 'block' : 'none';
      dashLabel.style.display = isPilotingTitan ? 'block' : 'none';
      dashBar.style.width = `${Math.max(0, Math.min(100, titanDashMeter))}%`;
      dashBar.style.filter = titanDashMeter < 40 ? 'saturate(1.8) brightness(1.2)' : 'none';
    }

    // Debug / telemetry
    const debugState = this.hudElements['debugState'];
    if (debugState) debugState.textContent = isPilotingTitan ? 'PILOTING' : debug.movementState;

    const debugSpeed = this.hudElements['debugSpeed'];
    if (debugSpeed) debugSpeed.textContent = `${debug.speed.toFixed(1)}`;

    const debugVelocity = this.hudElements['debugVelocity'];
    if (debugVelocity) {
      debugVelocity.innerHTML = isPilotingTitan
        ? `HULL ${Math.round(titanHealth)}%<br>SHIELD ${Math.round(titanShield)}%`
        : `VEL ${debug.velocity.x.toFixed(1)} / ${debug.velocity.y.toFixed(1)} / ${debug.velocity.z.toFixed(1)}<br>JUMPS ${debug.jumpCount}`;
    }

    const debugFlags = this.hudElements['debugFlags'];
    if (debugFlags) {
      const renderFlag = (label: string, active: boolean, activeColor: string) => `
        <span style="
          padding: 2px 7px;
          border: 1px solid ${active ? activeColor : 'rgba(255,255,255,0.12)'};
          color: ${active ? activeColor : 'rgba(200,230,230,0.45)'};
          background: ${active ? `${activeColor}14` : 'rgba(255,255,255,0.03)'};
          font-size: 10px;
          letter-spacing: 1px;
        ">${label}</span>
      `;

      debugFlags.innerHTML = isPilotingTitan
        ? [
            renderFlag('DASH', titanDashMeter >= 40, '#ff8844'),
            renderFlag('SHIELD', titanShield > 0, '#4488ff'),
          ].join('')
        : [
            renderFlag('SPRINT', debug.sprinting, '#66ff99'),
            renderFlag('CROUCH', debug.crouching, '#ffaa55'),
          ].join('');
    }

    // Weapon panel
    const weaponPanel = this.hudElements['weaponPanel'];
    if (weaponPanel && isPilotingTitan) {
      weaponPanel.style.borderRightColor = '#ff6600';
      weaponPanel.style.boxShadow = '0 0 18px rgba(255, 102, 0, 0.13)';
    } else if (weaponPanel) {
      weaponPanel.style.borderRightColor = weapon.accentColor;
      weaponPanel.style.boxShadow = `0 0 18px ${weapon.accentColor}22`;
    }

    const weaponName = this.hudElements['weaponName'];
    if (weaponName) {
      weaponName.textContent = isPilotingTitan ? 'XO-16 Chaingun' : weapon.weaponName;
      weaponName.style.color = isPilotingTitan ? '#ff8844' : weapon.accentColor;
    }

    const ammoCount = this.hudElements['ammoCount'];
    if (ammoCount) {
      if (isPilotingTitan) {
        ammoCount.textContent = '\u221E';
        ammoCount.style.color = '#fff0e0';
      } else {
        ammoCount.textContent = weapon.isReloading ? 'RLD' : `${weapon.ammo}`;
        ammoCount.style.color = weapon.isReloading
          ? '#ffaa00'
          : weapon.ammo === 0
            ? '#ff5555'
            : '#f5fffd';
      }
    }

    const ammoMeta = this.hudElements['ammoMeta'];
    if (ammoMeta) {
      if (isPilotingTitan) {
        ammoMeta.innerHTML = 'INFINITE MAG<br>AUTO-FEED';
      } else {
        const percent = Math.round(weapon.reloadProgress * 100);
        ammoMeta.innerHTML = weapon.isReloading
          ? `RELOADING<br>${percent}%`
          : `MAG ${weapon.magazineSize}<br>LIVE ROUNDS`;
      }
    }

    const ammoBar = this.hudElements['ammoBar'];
    if (ammoBar) {
      if (isPilotingTitan) {
        ammoBar.style.width = '100%';
        ammoBar.style.background = 'linear-gradient(90deg, #ff6600, #ffaa44)';
      } else {
        const ammoRatio = weapon.magazineSize > 0 ? weapon.ammo / weapon.magazineSize : 0;
        ammoBar.style.width = `${Math.max(0, Math.min(100, ammoRatio * 100))}%`;
        ammoBar.style.background = weapon.isReloading
          ? 'linear-gradient(90deg, #ffaa00, #ffe08a)'
          : `linear-gradient(90deg, ${weapon.accentColor}, #f5fffd)`;
      }
    }

    const ammoPips = this.hudElements['ammoPips'];
    if (ammoPips) {
      if (isPilotingTitan) {
        ammoPips.innerHTML = '';
      } else {
        const pipCount = Math.min(Math.max(weapon.magazineSize, 1), 24);
        const filledPips = weapon.isReloading
          ? Math.max(1, Math.round(weapon.reloadProgress * pipCount))
          : Math.round((weapon.ammo / Math.max(weapon.magazineSize, 1)) * pipCount);
        ammoPips.innerHTML = Array.from({ length: pipCount }, (_, index) => {
          const active = index < filledPips;
          const color = weapon.isReloading ? '#ffaa00' : weapon.accentColor;
          return `<span style="
            display:block;
            height:6px;
            background:${active ? color : 'rgba(255,255,255,0.08)'};
            box-shadow:${active ? `0 0 8px ${color}66` : 'none'};
            opacity:${active ? '1' : '0.45'};
          "></span>`;
        }).join('');
      }
    }

    const weaponSlots = this.hudElements['weaponSlots'];
    if (weaponSlots) {
      if (isPilotingTitan) {
        weaponSlots.innerHTML = `
          <div style="display:flex;justify-content:space-between;color:#ff8844;border-right:2px solid #ff6600;padding-right:8px;">
            <span>01</span><span>XO-16 Chaingun</span>
          </div>`;
      } else {
        weaponSlots.innerHTML = weapon.weaponSlots.map((slot) => `
          <div style="
            display:flex;
            justify-content:space-between;
            color:${slot.active ? weapon.accentColor : 'rgba(200, 230, 230, 0.55)'};
            border-right:${slot.active ? `2px solid ${weapon.accentColor}` : '2px solid transparent'};
            padding-right:8px;
          ">
            <span>0${slot.index + 1}</span>
            <span>${slot.name}</span>
          </div>
        `).join('');
      }
    }

    const weaponAttachments = this.hudElements['weaponAttachments'];
    if (weaponAttachments) {
      weaponAttachments.innerHTML = isPilotingTitan
        ? 'SYS // TITAN-CLASS ORDNANCE'
        : weapon.attachments.length > 0
          ? `MODS // ${weapon.attachments.join(' // ')}`
          : 'MODS // STOCK CONFIG';
    }

    const weaponUtility = this.hudElements['weaponUtility'];
    if (weaponUtility) {
      if (isPilotingTitan) {
        weaponUtility.innerHTML = `
          <div style="color:#ff8844;">DASH ${Math.round(titanDashMeter)}%</div>
          <div style="width:100%;height:4px;background:rgba(255,255,255,0.08);margin-top:4px;">
            <div style="width:${Math.max(0, Math.min(100, titanDashMeter))}%;height:100%;background:#ff8844;transition:width 0.1s linear;"></div>
          </div>
        `;
      } else {
        weaponUtility.innerHTML = `
          <div style="color:${weapon.grenadeCount > 0 ? '#88cc88' : '#ff5555'};">FRAG ${weapon.grenadeCount}</div>
          <div style="color:${weapon.grappleColor};">GRAPPLE ${weapon.grappleLabel}</div>
          <div style="width:100%;height:4px;background:rgba(255,255,255,0.08);margin-top:4px;">
            <div style="width:${Math.max(0, Math.min(100, weapon.grappleProgress * 100))}%;height:100%;background:${weapon.grappleColor};transition:width 0.1s linear;"></div>
          </div>
        `;
      }
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

    const sniperScope = this.hudElements['sniperScope'];
    if (sniperScope) {
      sniperScope.style.display = showSniperScope ? 'block' : 'none';
    }

    const crosshair = document.getElementById('crosshair');
    if (crosshair) {
      crosshair.style.display = showSniperScope ? 'none' : 'block';
    }
  }

  showMainMenu(levels: Level[], onStartGame: (id: number) => void): void {
    let menu = document.getElementById('main-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'main-menu';
      menu.className = 'menu-overlay';
      menu.innerHTML = `
        <div class="scanline"></div>
        <div class="menu-content">
          <h1>TITANFALL 3JS</h1>
          <div class="menu-subtitle">System: Advanced Movement FPS // Neural Link Active</div>
          <button id="start-game-btn" class="menu-button">Start Mission</button>
          <button id="level-select-btn" class="menu-button">Select Area</button>
          <button id="controls-btn" class="menu-button">Configurations</button>
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
      levelSelect.innerHTML = `
        <div class="scanline"></div>
        <div class="menu-content">
          <h1>AREA SELECTION</h1>
          <div class="menu-subtitle">Operational Theaters // Choose Drop Point</div>
          <div id="level-list"></div>
          <button id="back-to-menu-btn" class="menu-button" style="margin-top: 20px;">Return to Hub</button>
        </div>
      `;
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
        btn.classList.add('focused');
      } else {
        btn.classList.remove('focused');
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
      <div class="scanline"></div>
      <div class="menu-content" style="max-width:650px;width:95%;max-height:85vh;padding: 30px; display: flex; flex-direction: column; overflow: hidden;">
        <div style="flex-shrink: 0; margin-bottom: 10px;">
          <h1 style="font-size:40px;">CONFIGURATIONS</h1>
          <div class="menu-subtitle">Neural Link Mapping // Input Calibration</div>
        </div>

        <div id="controls-list" style="overflow-y: auto; padding-right: 15px; margin: 10px 0; display: flex; flex-direction: column; gap: 8px; flex-grow: 1; min-height: 0;"></div>
        
        <div style="flex-shrink: 0; display: flex; flex-direction: column; align-items: center;">
          <div style="display: flex; gap: 15px; justify-content: center; margin-top: 15px;">
            <button id="controls-reset-btn" class="menu-button" style="width:auto;padding:12px 25px;font-size:13px;margin:0;">Factory Reset</button>
            <button id="controls-back-btn" class="menu-button" style="width:auto;padding:12px 25px;font-size:13px;margin:0;">Save & Exit</button>
          </div>
          <div style="margin-top: 15px; font-size: 11px; opacity: 0.5; letter-spacing: 1px; color: #00ffcc;">[ CLICK KEY TO REBIND | ESC TO CANCEL ]</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('controls-reset-btn')!.onclick = () => {
      setBindings({ ...DEFAULT_BINDINGS });
      setAimCurve('classic');
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
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:15px;padding: 5px 0;border-bottom: 1px solid rgba(0,255,204,0.1);';

      const label = document.createElement('span');
      label.textContent = ACTION_LABELS[action];
      label.style.cssText = 'font-size:15px;color:#00ffcc;min-width:180px;text-align:left;flex-shrink:0;letter-spacing:1px;';

      const bindingsContainer = document.createElement('div');
      bindingsContainer.style.cssText = 'display:flex;gap:10px;flex-shrink:0;';

      // Keyboard binding button
      const keyBtn = document.createElement('button');
      keyBtn.className = 'menu-button';
      keyBtn.style.cssText = 'width:120px;margin:0;padding:8px;font-size:13px;font-family:monospace;clip-path: polygon(5% 0, 100% 0, 100% 70%, 95% 100%, 0 100%, 0 30%);';
      keyBtn.textContent = keyCodeToLabel(b[action]);
      keyBtn.onclick = () => this.startRebinding(action, keyBtn);

      // Controller binding display
      const controllerLabel = document.createElement('div');
      controllerLabel.style.cssText = 'width:90px;margin:0;padding:8px;font-size:12px;font-family:monospace;background:rgba(0,255,204,0.05);border:1px solid rgba(0,255,204,0.2);border-radius:2px;color:#00ffcc;text-align:center;opacity:0.6;';
      controllerLabel.textContent = this.getControllerLabel(action);

      this.controlsRowButtons.set(action, keyBtn);
      bindingsContainer.appendChild(keyBtn);
      bindingsContainer.appendChild(controllerLabel);
      row.appendChild(label);
      row.appendChild(bindingsContainer);
      list.appendChild(row);
    }

    // Aim curve selector (gamepad only)
    const curveRow = document.createElement('div');
    curveRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:15px;margin-top:20px;padding-top:20px;border-top: 1px solid rgba(0,255,204,0.3);';

    const curveLabel = document.createElement('span');
    curveLabel.textContent = 'Aim Response Curve';
    curveLabel.style.cssText = 'font-size:15px;color:#00ffcc;min-width:180px;text-align:left;flex-shrink:0;letter-spacing:1px;';

    const curveSelect = document.createElement('div');
    curveSelect.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

    const currentCurve = getAimCurve();
    for (const key of Object.keys(AIM_CURVE_LABELS) as AimCurve[]) {
      const btn = document.createElement('button');
      btn.className = 'menu-button';
      const isActive = key === currentCurve;
      btn.style.cssText = `width:auto;margin:0;padding:8px 12px;font-size:12px;clip-path: polygon(10% 0, 100% 0, 100% 70%, 90% 100%, 0 100%, 0 30%);${isActive ? 'background:rgba(0,255,204,0.3);color:#fff;border-color:#00ffcc;' : 'background:rgba(0,0,0,0.3);color:#888;border:1px solid rgba(0,255,204,0.1);'}`;
      btn.textContent = AIM_CURVE_LABELS[key];
      btn.onclick = () => {
        setAimCurve(key);
        this.rebuildControlsList();
      };
      curveSelect.appendChild(btn);
    }

    curveRow.appendChild(curveLabel);
    curveRow.appendChild(curveSelect);
    list.appendChild(curveRow);
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
      'embark': 'Hold X',
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

  showPilotingIndicator(_show: boolean): void {
    // Titan visor is now handled entirely by the HUD theme switcher in updateHUD/applyVisorTheme.
    // Remove the old floating overlay if it still exists.
    const old = document.getElementById('piloting-indicator');
    if (old) old.remove();
  }
}

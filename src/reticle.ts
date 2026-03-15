export type ReticleStyle = 
  | 'cross' | 'brackets' | 'precision' | 'diamond' | 'chevrons' | 'tshape' | 'circle' | 'ring' | 'corners';

interface ReticleConfig {
  style: ReticleStyle;
  color: string;
  size: number;
  spread: number;
}

const WEAPON_RETICLES: Record<string, ReticleConfig> = {
  'R-201': { style: 'cross', color: '#00ffcc', size: 16, spread: 4 },
  'EVA-8': { style: 'brackets', color: '#ff8844', size: 18, spread: 8 },
  'Kraber': { style: 'precision', color: '#ff2266', size: 24, spread: 2 },
  'EPG-1': { style: 'diamond', color: '#44aaff', size: 20, spread: 3 },
  'Alternator': { style: 'chevrons', color: '#ffaa00', size: 14, spread: 5 },
  'CAR': { style: 'chevrons', color: '#66ffcc', size: 14, spread: 4 },
  'Flatline': { style: 'tshape', color: '#ff4400', size: 16, spread: 4 },
  'Mastiff': { style: 'brackets', color: '#88ccff', size: 20, spread: 10 },
  'Wingman': { style: 'circle', color: '#ff6644', size: 18, spread: 3 },
  'L-STAR': { style: 'ring', color: '#22ff44', size: 18, spread: 5 },
  'XO-16': { style: 'corners', color: '#ff6600', size: 24, spread: 3 },
};

export class ReticleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentWeapon: string = 'R-201';
  private dynamicSpread: number = 0;
  private hitmarkerOpacity: number = 0;
  private hitmarkerScale: number = 1;
  private hitmarkerIsKill: boolean = false;
  private lastTime: number = performance.now();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'reticle-canvas';
    this.canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1000;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.hideDefaultCrosshair();
  }

  private hideDefaultCrosshair(): void {
    const defaultCrosshair = document.getElementById('crosshair');
    if (defaultCrosshair) {
      defaultCrosshair.remove();
    }
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  setWeapon(weaponName: string): void {
    this.currentWeapon = weaponName;
  }

  setSpread(spread: number): void {
    this.dynamicSpread = spread;
  }

  showHitmarker(isKill: boolean = false): void {
    this.hitmarkerOpacity = 1;
    this.hitmarkerScale = 0.5;
    this.hitmarkerIsKill = isKill;
  }

  private drawHitmarker(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    if (this.hitmarkerOpacity <= 0) return;

    const size = 12 * this.hitmarkerScale;
    const gap = 6 * this.hitmarkerScale;
    const thickness = 2.5;

    ctx.save();
    ctx.globalAlpha = this.hitmarkerOpacity;
    ctx.strokeStyle = this.hitmarkerIsKill ? '#ff4444' : '#ffffff';
    ctx.fillStyle = this.hitmarkerIsKill ? '#ff4444' : '#ffffff';
    ctx.lineWidth = thickness;
    ctx.shadowColor = this.hitmarkerIsKill ? '#ff0000' : '#000000';
    ctx.shadowBlur = 4;

    ctx.beginPath();
    ctx.moveTo(cx - gap - size, cy - gap - size);
    ctx.lineTo(cx - gap, cy - gap);
    ctx.moveTo(cx + gap, cy + gap);
    ctx.lineTo(cx + gap + size, cy + gap + size);
    ctx.moveTo(cx - gap - size, cy + gap + size);
    ctx.lineTo(cx - gap, cy + gap);
    ctx.moveTo(cx + gap, cy - gap);
    ctx.lineTo(cx + gap + size, cy - gap - size);
    ctx.stroke();

    if (this.hitmarkerIsKill) {
      ctx.beginPath();
      ctx.arc(cx, cy, 4 * this.hitmarkerScale, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  render(): void {
    const now = performance.now();
    const delta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (this.hitmarkerOpacity > 0) {
      this.hitmarkerOpacity -= delta * 4;
      this.hitmarkerScale += delta * 3;
      if (this.hitmarkerOpacity < 0) this.hitmarkerOpacity = 0;
    }

    const ctx = this.ctx;
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    const config = WEAPON_RETICLES[this.currentWeapon] || WEAPON_RETICLES['R-201'];
    const totalSpread = config.spread + this.dynamicSpread;
    
    ctx.strokeStyle = config.color;
    ctx.fillStyle = config.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = config.color;
    ctx.shadowBlur = 4;
    ctx.globalAlpha = 0.9;

    switch (config.style) {
      case 'cross':
        this.drawCross(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'brackets':
        this.drawBrackets(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'precision':
        this.drawPrecision(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'diamond':
        this.drawDiamond(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'chevrons':
        this.drawChevrons(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'tshape':
        this.drawTShape(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'circle':
        this.drawCircle(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'ring':
        this.drawRing(ctx, cx, cy, totalSpread, config.size);
        break;
      case 'corners':
        this.drawCorners(ctx, cx, cy, totalSpread, config.size);
        break;
    }

    this.drawHitmarker(ctx, cx, cy);

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  private drawCross(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy - gap - size);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + gap + size);
    ctx.moveTo(cx - gap - size, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + gap + size, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // "< + >" style - brackets that spread with movement
  private drawBrackets(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 12;
    const innerSize = 8;
    const outerLen = size;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Left bracket [ on LEFT side, opening toward center
    ctx.moveTo(cx - gap, cy - outerLen);
    ctx.lineTo(cx - gap - outerLen, cy - outerLen);
    ctx.lineTo(cx - gap - outerLen, cy + outerLen);
    ctx.lineTo(cx - gap, cy + outerLen);
    // Right bracket ] on RIGHT side, opening toward center  
    ctx.moveTo(cx + gap, cy - outerLen);
    ctx.lineTo(cx + gap + outerLen, cy - outerLen);
    ctx.lineTo(cx + gap + outerLen, cy + outerLen);
    ctx.lineTo(cx + gap, cy + outerLen);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - innerSize, cy);
    ctx.lineTo(cx + innerSize, cy);
    ctx.moveTo(cx, cy - innerSize);
    ctx.lineTo(cx, cy + innerSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Precision scope style - thin cross with center circle
  private drawPrecision(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 8;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - gap - size, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + gap + size, cy);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - gap - size * 0.7);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + gap + size * 0.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4 + spread * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Diamond "<> + °" style for EPG
  private drawDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 18;
    const diamondSize = size * 0.9;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx - gap, cy - diamondSize);
    ctx.lineTo(cx - gap - diamondSize * 0.7, cy);
    ctx.lineTo(cx - gap, cy + diamondSize);
    ctx.lineTo(cx - gap + diamondSize * 0.7, cy);
    ctx.closePath();
    ctx.moveTo(cx + gap, cy - diamondSize);
    ctx.lineTo(cx + gap + diamondSize * 0.7, cy);
    ctx.lineTo(cx + gap, cy + diamondSize);
    ctx.lineTo(cx + gap - diamondSize * 0.7, cy);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // "< + >" chevron SMG style - chevrons point away from center
  private drawChevrons(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 10;
    const chevLen = size * 0.8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Left side: < pointing left (away from center)
    ctx.moveTo(cx - gap, cy - chevLen * 0.6);
    ctx.lineTo(cx - gap - chevLen, cy);
    ctx.lineTo(cx - gap, cy + chevLen * 0.6);
    // Right side: > pointing right (away from center)
    ctx.moveTo(cx + gap, cy - chevLen * 0.6);
    ctx.lineTo(cx + gap + chevLen, cy);
    ctx.lineTo(cx + gap, cy + chevLen * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // "|- -|" T-shape for Flatline (vertical line on sides, horizontal tips)
  private drawTShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 10;
    const lineLen = size;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - gap - lineLen, cy - lineLen * 0.4);
    ctx.lineTo(cx - gap - lineLen, cy + lineLen * 0.4);
    ctx.moveTo(cx - gap, cy);
    ctx.lineTo(cx - gap - lineLen * 0.6, cy);
    ctx.moveTo(cx + gap + lineLen, cy - lineLen * 0.4);
    ctx.lineTo(cx + gap + lineLen, cy + lineLen * 0.4);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + gap + lineLen * 0.6, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - gap - lineLen);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + gap + lineLen);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Circle with cross for Wingman ("O + [small cross]")
  private drawCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 6;
    const radius = size * 0.7;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + gap * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - gap - size * 0.5, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + gap + size * 0.5, cy);
    ctx.moveTo(cx, cy - gap - size * 0.5);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + gap + size * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ring with animated dashes for L-STAR
  private drawRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const radius = spread + size * 0.6;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // "[+]" corner brackets for XO-16 titan weapon
  private drawCorners(ctx: CanvasRenderingContext2D, cx: number, cy: number, spread: number, size: number): void {
    const gap = spread + 16;
    const cornerLen = size;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - gap, cy - gap - cornerLen);
    ctx.lineTo(cx - gap, cy - gap);
    ctx.lineTo(cx - gap - cornerLen, cy - gap);
    ctx.moveTo(cx + gap, cy - gap - cornerLen);
    ctx.lineTo(cx + gap, cy - gap);
    ctx.lineTo(cx + gap + cornerLen, cy - gap);
    ctx.moveTo(cx - gap, cy + gap + cornerLen);
    ctx.lineTo(cx - gap, cy + gap);
    ctx.lineTo(cx - gap - cornerLen, cy + gap);
    ctx.moveTo(cx + gap, cy + gap + cornerLen);
    ctx.lineTo(cx + gap, cy + gap);
    ctx.lineTo(cx + gap + cornerLen, cy + gap);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

show(): void {
    this.canvas.style.display = 'block';
    this.hideDefaultCrosshair();
  }

  hide(): void {
    this.canvas.style.display = 'none';
  }

  destroy(): void {
    this.canvas.remove();
  }
}
import * as THREE from 'three';

interface DamageIndicator {
  angle: number;
  opacity: number;
  startTime: number;
}

interface EnemyMarker {
  angle: number;
  distance: number;
  opacity: number;
  isMoving: boolean;
}

export class RadarRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private damageIndicators: DamageIndicator[] = [];
  private enemyMarkers: EnemyMarker[] = [];
  private readonly DAMAGE_DURATION = 1500;
  private readonly ENEMY_DETECTION_RANGE = 20;
  private readonly ENEMY_FOOTSTEP_RANGE = 15;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'radar-canvas';
    this.canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 99;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  showDamageDirection(sourcePosition: THREE.Vector3, playerPosition: THREE.Vector3, playerRotation: number): void {
    const dx = sourcePosition.x - playerPosition.x;
    const dz = sourcePosition.z - playerPosition.z;
    // atan2(dx, -dz) gives angle where 0 = front, π/2 = right, π = back, -π/2 = left
    const worldAngle = Math.atan2(dx, -dz);
    // Add player rotation to convert from world space to screen space
    const relativeAngle = worldAngle + playerRotation;
    
    this.damageIndicators.push({
      angle: relativeAngle,
      opacity: 1,
      startTime: performance.now(),
    });
  }

  updateEnemies(enemies: { position: THREE.Vector3; velocity?: THREE.Vector3 }[], playerPosition: THREE.Vector3, playerRotation: number): void {
    this.enemyMarkers = [];
    
    for (const enemy of enemies) {
      const dx = enemy.position.x - playerPosition.x;
      const dz = enemy.position.z - playerPosition.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      
      if (distance < this.ENEMY_DETECTION_RANGE) {
        // atan2(dx, -dz) gives angle where 0 = front, π/2 = right, π = back, -π/2 = left
        const worldAngle = Math.atan2(dx, -dz);
        // Add player rotation to convert from world space to screen space
        const relativeAngle = worldAngle + playerRotation;
        
        const speed = enemy.velocity ? Math.sqrt(enemy.velocity.x ** 2 + enemy.velocity.z ** 2) : 0;
        const isMoving = speed > 0.5;
        
        if (distance < this.ENEMY_FOOTSTEP_RANGE || isMoving) {
          const opacity = 1 - (distance / this.ENEMY_DETECTION_RANGE);
          
          this.enemyMarkers.push({
            angle: relativeAngle,
            distance,
            opacity: Math.max(0.3, opacity),
            isMoving,
          });
        }
      }
    }
  }

  render(): void {
    const now = performance.now();
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.updateDamageIndicators(now);

    for (const indicator of this.damageIndicators) {
      this.drawDamageArrow(cx, cy, indicator);
    }

    for (const marker of this.enemyMarkers) {
      this.drawEnemyMarker(cx, cy, marker);
    }
  }

  private updateDamageIndicators(now: number): void {
    for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
      const elapsed = now - this.damageIndicators[i].startTime;
      if (elapsed > this.DAMAGE_DURATION) {
        this.damageIndicators.splice(i, 1);
      } else {
        this.damageIndicators[i].opacity = 1 - (elapsed / this.DAMAGE_DURATION);
      }
    }
  }

  private drawDamageArrow(cx: number, cy: number, indicator: DamageIndicator): void {
    const distance = 200;
    const size = 30;
    
    // Normalize angle to -π to π
    let angle = indicator.angle;
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    
    const x = cx + Math.sin(angle) * distance;
    const y = cy - Math.cos(angle) * distance;
    
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(angle);
    this.ctx.globalAlpha = indicator.opacity;
    
    this.ctx.strokeStyle = '#ff4444';
    this.ctx.fillStyle = '#ff4444';
    this.ctx.lineWidth = 3;
    this.ctx.shadowColor = '#ff0000';
    this.ctx.shadowBlur = 10;
    
    // Draw arrow pointing outward (toward the source of damage)
    this.ctx.beginPath();
    this.ctx.moveTo(0, -size / 2);  // tip
    this.ctx.lineTo(size / 2.5, size / 3);  // right corner
    this.ctx.lineTo(-size / 2.5, size / 3);  // left corner
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    
    this.ctx.restore();
  }

  private drawEnemyMarker(cx: number, cy: number, marker: EnemyMarker): void {
    const distance = 180;
    const size = marker.isMoving ? 12 : 8;
    
    const x = cx + Math.sin(marker.angle) * distance;
    const y = cy - Math.cos(marker.angle) * distance;
    
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.globalAlpha = marker.opacity;
    
    if (marker.isMoving) {
      this.ctx.fillStyle = '#ff8800';
      this.ctx.shadowColor = '#ff8800';
      this.ctx.shadowBlur = 8;
      
      this.ctx.beginPath();
      this.ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      this.ctx.fill();
      
      this.ctx.strokeStyle = '#ffcc00';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, size / 2 + 4, 0, Math.PI * 2);
      this.ctx.stroke();
    } else {
      this.ctx.fillStyle = '#ffaa00';
      this.ctx.shadowColor = '#ffaa00';
      this.ctx.shadowBlur = 5;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      this.ctx.fill();
    }
    
    this.ctx.restore();
  }

  show(): void {
    this.canvas.style.display = 'block';
  }

  hide(): void {
    this.canvas.style.display = 'none';
  }

  destroy(): void {
    this.canvas.remove();
  }
}
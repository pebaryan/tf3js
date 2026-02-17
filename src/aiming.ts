import * as THREE from 'three';

export interface IAimingSystem {
  compensateRecoil: (mouseMovement: {x: number, y: number}) => void;
  assistAiming: (mouseMovement: {x: number, y: number}) => void;
  drawCrosshair: () => void;
  drawTargetReticle: (targetPosition: THREE.Vector3) => void;
}

export class AimingSystem implements IAimingSystem {
  private recoilHistory: {x: number, y: number, timestamp: number}[] = [];
  private recoilCompensation: ((movement: {x: number, y: number}) => void) | undefined;

  public setRecoilCompensation(compensationFunc: (movement: {x: number, y: number}) => void) {
    this.recoilCompensation = compensationFunc;
  }

  public drawCrosshair(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'white';
    context.lineWidth = 2;
    context.setLineDash([3, 3]);

    // Draw crosshair lines
    context.beginPath();
    context.moveTo(20, 0);
    context.lineTo(20, 15);
    context.moveTo(20, 25);
    context.lineTo(20, 40);
    context.moveTo(0, 20);
    context.lineTo(15, 20);
    context.moveTo(25, 20);
    context.lineTo(40, 20);
    context.setLineDash([]);
    context.stroke();
  }

  public drawTargetReticle(targetPosition: THREE.Vector3): void {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);

    // Draw reticle circle
    context.strokeStyle = 'white';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(20, 20, 15, 0, Math.PI * 2);
    context.stroke();

    // Draw crosshair lines
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(20, 0);
    context.lineTo(20, 15);
    context.moveTo(20, 25);
    context.lineTo(20, 40);
    context.moveTo(0, 20);
    context.lineTo(15, 20);
    context.moveTo(25, 20);
    context.lineTo(40, 20);
    context.setLineDash([]);
    context.stroke();

    // Draw line to target offset
    context.strokeStyle = 'rgba(255, 255, 0, 0.5)';
    context.beginPath();
    context.moveTo(20, 20);
    context.lineTo(20 + targetPosition.x * 20, 20 - targetPosition.y * 20);
    context.stroke();
  }

  public compensateRecoil(mouseMovement: {x: number, y: number}): void {
    this.recoilHistory.push({
      x: mouseMovement.x,
      y: mouseMovement.y,
      timestamp: Date.now()
    });

    // Keep last 10 entries
    if (this.recoilHistory.length > 10) {
      this.recoilHistory.shift();
    }

    let sumX = 0, sumY = 0;
    for (const rec of this.recoilHistory) {
      sumX += rec.x;
      sumY += rec.y;
    }

    const avgRecoil = new THREE.Vector2(sumX / this.recoilHistory.length, sumY / this.recoilHistory.length);
    const avgRecoilNorm = avgRecoil.length();

    if (avgRecoilNorm > 0.1 && this.recoilCompensation) {
      const recoilDirection = avgRecoil.clone().normalize().multiplyScalar(0.2);
      this.recoilCompensation({
        x: mouseMovement.x * recoilDirection.x * 0.2,
        y: mouseMovement.y * recoilDirection.y * 0.2
      });
    }
  }

  public assistAiming(mouseMovement: {x: number, y: number}): void {
    this.aimAssistance({ x: mouseMovement.x * 0.7, y: mouseMovement.y * 0.7 });
  }

  private aimAssistance(mouseMovement: {x: number, y: number}): void {
    if (this.recoilCompensation) {
      this.recoilCompensation({ x: -mouseMovement.x * 0.3, y: -mouseMovement.y * 0.3 });
    }
  }
}

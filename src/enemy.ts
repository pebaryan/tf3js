import * as THREE from 'three';
import * as CANNON from 'cannon-es';

interface DamageNumber {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class Enemy {
  scene: THREE.Scene;
  world: CANNON.World;
  mesh: THREE.Mesh;
  body?: CANNON.Body;
  
  private maxHealth = 50;
  health = 50;
  speed: number;
  aggressive: boolean;
  attackTimer = 0;
  attackCooldown: number;
  private damageNumbers: DamageNumber[] = [];
  private isFlashing = false;
  private flashTimer = 0;
  private flashMesh?: THREE.Mesh;
  
  private readonly DAMAGE_NUMBER_LIFE = 1.0;
  
  constructor(
    scene: THREE.Scene, 
    world: CANNON.World, 
    position: THREE.Vector3,
    options?: {
      health?: number;
      speed?: number;
      aggressive?: boolean;
      attackCooldown?: number;
    }
  ) {
    this.scene = scene;
    this.world = world;
    
    this.maxHealth = options?.health ?? 50;
    this.health = this.maxHealth;
    this.speed = options?.speed ?? 1.5;
    this.aggressive = options?.aggressive ?? true;
    this.attackCooldown = options?.attackCooldown ?? 2;
    
    // Create enemy mesh
    const enemyGeo = new THREE.BoxGeometry(0.6, 1.8, 0.4);
    const enemyMat = new THREE.MeshStandardMaterial({ color: 0x3333ff });
    this.mesh = new THREE.Mesh(enemyGeo, enemyMat);
    this.mesh.position.copy(position);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    
    // Flash overlay for hit feedback
    const flashGeo = new THREE.BoxGeometry(0.62, 1.82, 0.42);
    const flashMat = new THREE.MeshBasicMaterial({ 
      color: 0xffffff, 
      transparent: true, 
      opacity: 0,
      side: THREE.DoubleSide
    });
    this.flashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.mesh.add(this.flashMesh);
  }
  
  updatePosition(position: THREE.Vector3): void {
    this.mesh.position.copy(position);
  }
  
  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    this.health = Math.max(0, this.health - amount);
    
    // Flash white
    this.isFlashing = true;
    this.flashTimer = 0.1;
    if (this.flashMesh) {
      (this.flashMesh.material as THREE.MeshBasicMaterial).opacity = 0.5;
    }
    
    // Spawn damage number
    const spawnPoint = hitPoint || this.mesh.position.clone().add(new THREE.Vector3(0, 1, 0));
    this.spawnDamageNumber(amount, spawnPoint);
  }
  
  private spawnDamageNumber(damage: number, position: THREE.Vector3): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    
    // Draw damage text
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 128, 128);
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = '#ff0000';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = Math.round(damage).toString();
    ctx.strokeText(text, 64, 64);
    ctx.fillText(text, 64, 64);
    
    const texture = new THREE.CanvasTexture(canvas);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ 
      map: texture, 
      transparent: true,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geo, mat);
    
    // Position slightly above hit point
    mesh.position.copy(position).add(new THREE.Vector3(0, 0.5, 0));
    // Face camera (will be updated in update)
    mesh.lookAt(this.scene.position);
    
    this.scene.add(mesh);
    
    this.damageNumbers.push({
      mesh,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        1 + Math.random() * 0.5,
        (Math.random() - 0.5) * 0.5
      ),
      life: this.DAMAGE_NUMBER_LIFE,
      maxLife: this.DAMAGE_NUMBER_LIFE
    });
  }
  
  update(delta: number, cameraPosition: THREE.Vector3): void {
    // Update flash
    if (this.isFlashing && this.flashMesh) {
      this.flashTimer -= delta;
      const mat = this.flashMesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, this.flashTimer * 5);
      if (this.flashTimer <= 0) {
        this.isFlashing = false;
        mat.opacity = 0;
      }
    }
    
    // Update damage numbers
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.life -= delta;
      
      // Move up
      dn.mesh.position.add(dn.velocity.clone().multiplyScalar(delta));
      // Face camera
      dn.mesh.lookAt(cameraPosition);
      
      // Fade out
      const alpha = dn.life / dn.maxLife;
      (dn.mesh.material as THREE.MeshBasicMaterial).opacity = alpha;
      
      if (dn.life <= 0) {
        this.scene.remove(dn.mesh);
        dn.mesh.geometry.dispose();
        const mat = dn.mesh.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
        this.damageNumbers.splice(i, 1);
      }
    }
  }
  
  checkBulletHit(bulletPos: THREE.Vector3): boolean {
    const targetPos = this.mesh.position;
    const dx = bulletPos.x - targetPos.x;
    const dz = bulletPos.z - targetPos.z;
    const dy = bulletPos.y - targetPos.y;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq < 1.2 * 1.2; // Hit radius for enemy
  }
  
  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    
    // Clean up damage numbers
    this.damageNumbers.forEach(dn => {
      this.scene.remove(dn.mesh);
      dn.mesh.geometry.dispose();
      const mat = dn.mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    });
    this.damageNumbers = [];
  }
}

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

interface DamageNumber {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class Target {
  scene: THREE.Scene;
  world: CANNON.World;
  mesh: THREE.Mesh;
  body: CANNON.Body;
  
  private maxHealth = 100;
  private health = 100;
  private healthBar: THREE.Mesh;
  private healthBarBg: THREE.Mesh;
  private damageNumbers: DamageNumber[] = [];
  private flashMesh: THREE.Mesh;
  private isFlashing = false;
  private flashTimer = 0;
  
  private readonly DAMAGE_NUMBER_LIFE = 1.0;
  
  constructor(scene: THREE.Scene, world: CANNON.World, x: number, y: number, z: number) {
    this.scene = scene;
    this.world = world;
    
    // Create target mesh (cylinder)
    const geo = new THREE.CylinderGeometry(0.8, 0.8, 2, 32);
    const mat = new THREE.MeshStandardMaterial({ 
      color: 0xff4444,
      metalness: 0.3,
      roughness: 0.4
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(x, y + 1, z);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    
    // Physics body
    const shape = new CANNON.Cylinder(0.8, 0.8, 2, 16);
    const quat = new CANNON.Quaternion();
    quat.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    this.body = new CANNON.Body({ mass: 0 });
    this.body.addShape(shape, new CANNON.Vec3(0, 0, 0), quat);
    this.body.position.set(x, y + 1, z);
    world.addBody(this.body);
    
    // Health bar background
    const bgGeo = new THREE.PlaneGeometry(2, 0.2);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.healthBarBg = new THREE.Mesh(bgGeo, bgMat);
    this.healthBarBg.position.set(0, 1.5, 0);
    this.mesh.add(this.healthBarBg);
    
    // Health bar fill
    const fillGeo = new THREE.PlaneGeometry(1.9, 0.15);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    this.healthBar = new THREE.Mesh(fillGeo, fillMat);
    this.healthBar.position.set(0, 0, 0.01);
    this.healthBarBg.add(this.healthBar);
    
    // Flash overlay (for hit feedback)
    const flashGeo = new THREE.CylinderGeometry(0.82, 0.82, 2.02, 32);
    const flashMat = new THREE.MeshBasicMaterial({ 
      color: 0xffffff, 
      transparent: true, 
      opacity: 0,
      side: THREE.DoubleSide
    });
    this.flashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.mesh.add(this.flashMesh);
  }
  
  takeDamage(amount: number, hitPoint: THREE.Vector3) {
    this.health = Math.max(0, this.health - amount);
    
    // Flash white
    this.isFlashing = true;
    this.flashTimer = 0.1;
    (this.flashMesh.material as THREE.MeshBasicMaterial).opacity = 0.5;
    
    // Update health bar
    const healthPercent = this.health / this.maxHealth;
    this.healthBar.scale.x = healthPercent;
    // Color based on health
    const mat = this.healthBar.material as THREE.MeshBasicMaterial;
    if (healthPercent > 0.5) {
      mat.color.setHex(0x00ff00);
    } else if (healthPercent > 0.25) {
      mat.color.setHex(0xffff00);
    } else {
      mat.color.setHex(0xff0000);
    }
    
    // Spawn damage number
    this.spawnDamageNumber(amount, hitPoint);
    
    // Reset health if destroyed
    if (this.health <= 0) {
      setTimeout(() => {
        this.health = this.maxHealth;
        this.healthBar.scale.x = 1;
        (this.healthBar.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
      }, 2000);
    }
  }
  
  private spawnDamageNumber(damage: number, position: THREE.Vector3) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    
    // Draw damage text
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 128, 128);
    ctx.font = 'bold 48px Arial';
    ctx.fillStyle = '#ffff00';
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
    // Face camera
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
  
  update(delta: number, cameraPosition: THREE.Vector3) {
    // Update flash
    if (this.isFlashing) {
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
    return distSq < 1.5 * 1.5; // Hit radius
  }
}

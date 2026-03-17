import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export class Target {
  scene: THREE.Scene;
  world: CANNON.World;
  mesh: THREE.Group;
  group: THREE.Group; // alias for mesh (for compatibility with damage code)
  body: CANNON.Body;
  
  private maxHealth = 100;
  health = 100;
  private healthBarGroup: THREE.Group;
  private healthBar: THREE.Mesh;
  private healthBarBg: THREE.Mesh;
  private flashMesh: THREE.Mesh;
  private isFlashing = false;
  private flashTimer = 0;
  private readonly BASE_OFFSET_Y = 0.4;
  
  constructor(scene: THREE.Scene, world: CANNON.World, x: number, y: number, z: number) {
    this.scene = scene;
    this.world = world;

    const armorMat = new THREE.MeshStandardMaterial({
      color: 0xc95c4c,
      metalness: 0.35,
      roughness: 0.5,
    });
    const undersuitMat = new THREE.MeshStandardMaterial({
      color: 0x1b1f2a,
      metalness: 0.15,
      roughness: 0.7,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x00ffcc,
      emissive: 0x00ffcc,
      emissiveIntensity: 0.18,
      metalness: 0.2,
      roughness: 0.35,
    });
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x30343d,
      metalness: 0.45,
      roughness: 0.55,
    });

    this.mesh = new THREE.Group();
    this.mesh.position.set(x, y + this.BASE_OFFSET_Y, z);
    this.mesh.rotation.y = Math.PI;

    const setShadow = (object: THREE.Object3D) => {
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
    };

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.16, 24), baseMat);
    base.position.set(0, -0.32, 0);
    this.mesh.add(base);

    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.28), armorMat);
    pelvis.position.set(0, 0.72, 0);
    this.mesh.add(pelvis);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.95, 0.38), armorMat);
    torso.position.set(0, 1.42, 0);
    this.mesh.add(torso);

    const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.56, 0.08), accentMat);
    chestPlate.position.set(0, 1.48, 0.2);
    this.mesh.add(chestPlate);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 18, 16), undersuitMat);
    head.position.set(0, 2.22, 0.02);
    this.mesh.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.08), accentMat);
    visor.position.set(0, 2.2, 0.2);
    this.mesh.add(visor);

    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.16), undersuitMat);
    leftArm.position.set(-0.48, 1.45, 0);
    leftArm.rotation.z = 0.08;
    this.mesh.add(leftArm);

    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, 0.16), undersuitMat);
    rightArm.position.set(0.48, 1.45, 0);
    rightArm.rotation.z = -0.08;
    this.mesh.add(rightArm);

    const leftForearm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.62, 0.14), armorMat);
    leftForearm.position.set(-0.5, 0.95, 0.02);
    leftForearm.rotation.z = 0.04;
    this.mesh.add(leftForearm);

    const rightForearm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.62, 0.14), armorMat);
    rightForearm.position.set(0.5, 0.95, 0.02);
    rightForearm.rotation.z = -0.04;
    this.mesh.add(rightForearm);

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.9, 0.2), undersuitMat);
    leftLeg.position.set(-0.18, 0.27, 0);
    this.mesh.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.9, 0.2), undersuitMat);
    rightLeg.position.set(0.18, 0.27, 0);
    this.mesh.add(rightLeg);

    const leftShin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.74, 0.16), armorMat);
    leftShin.position.set(-0.18, -0.02, 0.03);
    this.mesh.add(leftShin);

    const rightShin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.74, 0.16), armorMat);
    rightShin.position.set(0.18, -0.02, 0.03);
    this.mesh.add(rightShin);

    setShadow(this.mesh);
    scene.add(this.mesh);
    
    this.group = this.mesh; // alias for compatibility
    
    // Physics body
    const shape = new CANNON.Cylinder(0.7, 0.7, 2.4, 16);
    const quat = new CANNON.Quaternion();
    quat.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    this.body = new CANNON.Body({ mass: 0 });
    this.body.addShape(shape, new CANNON.Vec3(0, 0, 0), quat);
    this.body.position.set(x, y + this.BASE_OFFSET_Y + 1.2, z);
    world.addBody(this.body);
    
    // Health bar background
    const bgGeo = new THREE.PlaneGeometry(2, 0.2);
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    this.healthBarGroup = new THREE.Group();
    this.healthBarGroup.position.set(x, y + this.BASE_OFFSET_Y + 3.7, z);
    scene.add(this.healthBarGroup);

    this.healthBarBg = new THREE.Mesh(bgGeo, bgMat);
    this.healthBarGroup.add(this.healthBarBg);
    
    // Health bar fill
    const fillGeo = new THREE.PlaneGeometry(1.9, 0.15);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
    this.healthBar = new THREE.Mesh(fillGeo, fillMat);
    this.healthBar.position.set(0, 0, 0.01);
    this.healthBarBg.add(this.healthBar);
    
    // Flash overlay (for hit feedback)
    const flashGeo = new THREE.CylinderGeometry(0.76, 0.82, 2.45, 24);
    const flashMat = new THREE.MeshBasicMaterial({ 
      color: 0xffffff, 
      transparent: true, 
      opacity: 0,
      side: THREE.DoubleSide
    });
    this.flashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.flashMesh.position.set(0, 1.2, 0);
    this.mesh.add(this.flashMesh);
  }
  
  takeDamage(amount: number, _hitPoint: THREE.Vector3) {
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
    
    // Reset health if destroyed
    if (this.health <= 0) {
      setTimeout(() => {
        this.health = this.maxHealth;
        this.healthBar.scale.x = 1;
        (this.healthBar.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
      }, 2000);
    }
  }
  
  update(delta: number, cameraPosition: THREE.Vector3) {
    this.healthBarGroup.position.set(this.group.position.x, this.group.position.y + 3.1, this.group.position.z);
    this.healthBarGroup.lookAt(cameraPosition);

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
  }
  
  checkBulletHit(bulletPos: THREE.Vector3): boolean {
    const targetPos = this.body.position;
    const dx = bulletPos.x - targetPos.x;
    const dz = bulletPos.z - targetPos.z;
    const dy = bulletPos.y - targetPos.y;
    const horizontalDistSq = dx * dx + dz * dz;
    return horizontalDistSq < 0.85 * 0.85 && Math.abs(dy) < 1.35;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.scene.remove(this.healthBarGroup);
    this.world.removeBody(this.body);
    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
    this.healthBarBg.geometry.dispose();
    (this.healthBarBg.material as THREE.Material).dispose();
    this.healthBar.geometry.dispose();
    (this.healthBar.material as THREE.Material).dispose();
  }
}

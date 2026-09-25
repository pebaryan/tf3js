import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { bevelBox } from './geometryUtils';

/** Bullseye decal for the dummy's chest plate. */
function makeBullseyeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  const rings = ['#ff7a1a', '#f4f1ea', '#ff7a1a', '#f4f1ea', '#ff7a1a'];
  rings.forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(64, 64, 60 - i * 12, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  ctx.fillStyle = '#1d2229';
  ctx.fillRect(62, 4, 4, 120);
  ctx.fillRect(4, 62, 120, 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Training dummy: a white-and-orange robot mannequin on a glowing pedestal,
 * deliberately unlike the red enemy grunts. Built in the target's local space
 * (front +z, pedestal at y ≈ -0.33, helmet top at y ≈ 2.35).
 */
function buildTrainingDummy(root: THREE.Group): void {
  const shell = new THREE.MeshStandardMaterial({ color: 0xe9e5dc, metalness: 0.25, roughness: 0.45 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, metalness: 0.3, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262c, metalness: 0.5, roughness: 0.55 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x30343d, metalness: 0.6, roughness: 0.4 });
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x33ffe0).multiplyScalar(2.5) });
  const decal = new THREE.MeshStandardMaterial({ map: makeBullseyeTexture(), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    root.add(m);
    return m;
  };
  const limb = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
    const dir = b.clone().sub(a);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, dir.length() - 2 * r), 4, 10), mat);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    m.position.copy(a).add(b).multiplyScalar(0.5);
    root.add(m);
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Pedestal with a glowing ring
  add(new THREE.CylinderGeometry(0.5, 0.58, 0.14, 32), frame, 0, -0.33, 0);
  const ring = add(new THREE.TorusGeometry(0.52, 0.018, 8, 48), glow, 0, -0.255, 0, Math.PI / 2);
  ring.castShadow = false;

  // Legs
  for (const sx of [-1, 1]) {
    limb(v(sx * 0.2, 0.9, 0), v(sx * 0.21, 0.36, 0.03), 0.1, shell);            // thigh
    add(bevelBox(0.17, 0.18, 0.1, 0.04), orange, sx * 0.21, 0.36, 0.1);        // knee pad
    limb(v(sx * 0.21, 0.33, 0.03), v(sx * 0.21, -0.14, 0), 0.085, shell);      // shin
    add(bevelBox(0.18, 0.13, 0.34, 0.04), dark, sx * 0.21, -0.2, 0.05);        // boot
  }

  // Torso
  add(bevelBox(0.52, 0.26, 0.32, 0.06), dark, 0, 0.95, 0);                     // pelvis
  add(bevelBox(0.54, 0.06, 0.34, 0.02), orange, 0, 1.06, 0);                   // belt
  add(bevelBox(0.42, 0.28, 0.28, 0.06), dark, 0, 1.22, 0);                     // abdomen
  add(bevelBox(0.72, 0.55, 0.4, 0.1), shell, 0, 1.56, 0);                      // chest
  add(bevelBox(0.5, 0.42, 0.08, 0.04), shell, 0, 1.55, 0.22);                  // chest plate
  add(new THREE.PlaneGeometry(0.34, 0.34), decal, 0, 1.55, 0.262);             // bullseye
  add(bevelBox(0.3, 0.3, 0.12, 0.04), frame, 0, 1.5, -0.24);                   // back module
  add(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 12), dark, 0, 1.89, 0);     // neck

  // Arms
  for (const sx of [-1, 1]) {
    add(bevelBox(0.26, 0.16, 0.3, 0.05), orange, sx * 0.47, 1.8, 0, 0, 0, sx * -0.25); // shoulder pad
    limb(v(sx * 0.44, 1.72, 0), v(sx * 0.5, 1.25, 0.02), 0.075, dark);          // upper arm
    add(new THREE.SphereGeometry(0.08, 12, 10), dark, sx * 0.5, 1.24, 0.02);   // elbow
    limb(v(sx * 0.5, 1.24, 0.02), v(sx * 0.48, 0.82, 0.08), 0.07, shell);       // forearm
    add(bevelBox(0.1, 0.14, 0.1, 0.03), dark, sx * 0.48, 0.77, 0.09);          // hand
  }

  // Helmet with glowing visor
  const helmet = new THREE.SphereGeometry(0.2, 24, 16);
  helmet.scale(1, 1.08, 1.1);
  add(helmet, shell, 0, 2.12, 0);
  add(bevelBox(0.22, 0.1, 0.14, 0.04), dark, 0, 1.99, 0.08);                   // jaw
  add(bevelBox(0.27, 0.08, 0.06, 0.03), glow, 0, 2.13, 0.2);                   // visor
  add(bevelBox(0.06, 0.05, 0.3, 0.02), orange, 0, 2.33, -0.02);                // crest
}

export class Target {
  scene: THREE.Scene;
  world: CANNON.World;
  mesh: THREE.Group;
  group: THREE.Group; // alias for mesh (for compatibility with damage code)
  body: CANNON.Body;
  
  private maxHealth = 100;
  health = 100;
  /** True once the target has been knocked down. Destroyed targets stay down and ignore hits. */
  destroyed = false;
  private knockdown = 0;
  private knockdownAxis: THREE.Vector3 | null = null;
  private readonly baseQuaternion = new THREE.Quaternion();
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

    buildTrainingDummy(this.mesh);
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
      side: THREE.DoubleSide,
      depthWrite: false, // invisible most of the time; must not hide the chest decal inside it
    });
    this.flashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.flashMesh.position.set(0, 1.2, 0);
    this.mesh.add(this.flashMesh);
  }
  
  takeDamage(amount: number, _hitPoint?: THREE.Vector3) {
    if (this.destroyed) return;
    this.health = Math.max(0, this.health - amount);

    // Flash white
    this.isFlashing = true;
    this.flashTimer = 0.1;
    (this.flashMesh.material as THREE.MeshBasicMaterial).opacity = 0.5;

    // Update health bar
    const healthPercent = this.health / this.maxHealth;
    this.healthBar.scale.x = Math.max(0.001, healthPercent);
    // Color based on health
    const mat = this.healthBar.material as THREE.MeshBasicMaterial;
    if (healthPercent > 0.5) {
      mat.color.setHex(0x00ff00);
    } else if (healthPercent > 0.25) {
      mat.color.setHex(0xffff00);
    } else {
      mat.color.setHex(0xff0000);
    }

    if (this.health <= 0) {
      this.destroyed = true;
      this.healthBarGroup.visible = false;
      // The fallen target should no longer block movement
      this.world.removeBody(this.body);
    }
  }

  update(delta: number, cameraPosition: THREE.Vector3) {
    // Knocked-down targets tip over, away from the shooter
    if (this.destroyed && this.knockdown < 1) {
      if (!this.knockdownAxis) {
        const away = this.mesh.position.clone().sub(cameraPosition);
        away.y = 0;
        if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
        away.normalize();
        this.knockdownAxis = new THREE.Vector3(0, 1, 0).cross(away).normalize();
        this.baseQuaternion.copy(this.mesh.quaternion);
      }
      this.knockdown = Math.min(1, this.knockdown + delta * 3);
      const eased = 1 - (1 - this.knockdown) * (1 - this.knockdown);
      const tip = new THREE.Quaternion().setFromAxisAngle(this.knockdownAxis, eased * (Math.PI / 2 - 0.15));
      this.mesh.quaternion.copy(tip.multiply(this.baseQuaternion));
    }

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
    if (this.destroyed) return false;
    const targetPos = this.body.position;
    const dx = bulletPos.x - targetPos.x;
    const dz = bulletPos.z - targetPos.z;
    const dy = bulletPos.y - targetPos.y;
    const horizontalDistSq = dx * dx + dz * dz;
    return horizontalDistSq < 0.85 * 0.85 && Math.abs(dy) < 1.35;
  }

  dispose(): void {
    this.world.removeBody(this.body);
    this.scene.remove(this.mesh);
    this.scene.remove(this.healthBarGroup);
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

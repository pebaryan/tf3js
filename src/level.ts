import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// --- Procedural grid texture (1m squares) for measuring displacement ---
function makeGridTexture(gridColor: number, bgColor: number, size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#' + bgColor.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, 256, 256);

  // Grid lines
  ctx.strokeStyle = '#' + gridColor.toString(16).padStart(6, '0');
  ctx.lineWidth = 2;
  const step = 256 / size;
  for (let i = 0; i <= size; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
  }

  // Center cross
  ctx.strokeStyle = '#' + gridColor.toString(16).padStart(6, '0');
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.4;
  for (let i = 0; i <= size; i++) {
    for (let j = 0; j <= size; j++) {
      const cx = (i + 0.5) * step;
      const cy = (j + 0.5) * step;
      ctx.beginPath(); ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// All textures: 1 canvas tile = 1 meter (gridSize=1 means 1 cell per tile)
const floorTex = makeGridTexture(0x334466, 0x1a1a2e, 1);
floorTex.repeat.set(100, 100); // 200m plane, 1m per tile

const wallTex = makeGridTexture(0x445577, 0x2a2a4a, 1);
wallTex.repeat.set(1, 1);

const platTex = makeGridTexture(0x556688, 0x3a3a5a, 1);
platTex.repeat.set(1, 1);

const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0xaaaacc,
  map: wallTex,
  metalness: 0.3,
  roughness: 0.6,
});

const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0x8888aa,
  map: floorTex,
  metalness: 0.2,
  roughness: 0.8,
});

const platformMaterial = new THREE.MeshStandardMaterial({
  color: 0x9999bb,
  map: platTex,
  metalness: 0.3,
  roughness: 0.6,
});

const accentMaterial = new THREE.MeshStandardMaterial({
  color: 0x00ffcc,
  emissive: 0x00ffcc,
  emissiveIntensity: 0.3,
});

export function createLevel(scene: THREE.Scene, world: CANNON.World) {
  const floorGeo = new THREE.PlaneGeometry(200, 200);
  const floor = new THREE.Mesh(floorGeo, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const floorShape = new CANNON.Plane();
  const floorBody = new CANNON.Body({ mass: 0 });
  floorBody.addShape(floorShape);
  floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floorBody);

  // Wall run training area - parallel walls
  createWall(0, 8, -40, 0.5, 50, scene, world);  // Center divider
  createWall(-8, 8, -40, 0.5, 50, scene, world); // Left wall
  createWall(8, 8, -40, 0.5, 50, scene, world);  // Right wall
  
  // Long walls for wall running
  createWall(-15, 6, -60, 0.5, 30, scene, world);
  createWall(15, 6, -60, 0.5, 30, scene, world);
  
  // Staggered platforms for parkour
  createPlatform(0, 1, 5, 6, 0.5, 6, scene, world);
  createPlatform(0, 2.5, 12, 4, 0.5, 4, scene, world);
  createPlatform(0, 4, 19, 4, 0.5, 4, scene, world);
  createPlatform(0, 5.5, 26, 4, 0.5, 4, scene, world);
  
  // Side platforms
  createPlatform(-10, 2, 0, 5, 0.5, 5, scene, world);
  createPlatform(10, 2, 0, 5, 0.5, 5, scene, world);
  createPlatform(-15, 4, -10, 5, 0.5, 5, scene, world);
  createPlatform(15, 4, -10, 5, 0.5, 5, scene, world);
  
  // Wall run test - wall with platform at end
  createWall(-20, 10, -30, 0.5, 15, scene, world);
  createPlatform(-25, 3, -25, 4, 0.5, 4, scene, world);
  
  createWall(20, 10, -30, 0.5, 15, scene, world);
  createPlatform(25, 3, -25, 4, 0.5, 4, scene, world);
  
  // Vertical wall run practice
  createWall(0, 15, -20, 8, 0.5, scene, world);
  
  // Mantle boxes (various heights to test)
  createWall(-5, 1.5, 0, 2, 2, scene, world);   // low - easy mantle
  createWall(-5, 2.2, -5, 2, 2, scene, world);   // medium
  createWall(-5, 3.0, -10, 2, 2, scene, world);  // high - needs jump first
  createWall(5, 1.5, 0, 2, 2, scene, world);
  createWall(5, 2.2, -5, 2, 2, scene, world);
  createWall(5, 3.0, -10, 2, 2, scene, world);
  
  // Mantle chain - staircase of boxes
  createWall(0, 1.2, -50, 3, 3, scene, world);
  createWall(0, 2.4, -54, 3, 3, scene, world);
  createWall(0, 3.6, -58, 3, 3, scene, world);
  createWall(0, 4.8, -62, 3, 3, scene, world);
  
  // Boundary walls
  createWall(0, 5, -90, 100, 10, scene, world);
  createWall(-50, 5, -40, 0.5, 100, scene, world);
  createWall(50, 5, -40, 0.5, 100, scene, world);
  
  addAccentLines(scene);
}

function makeBoxMaterial(w: number, h: number, d: number, baseMat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial[] {
  if (!baseMat.map) return [baseMat, baseMat, baseMat, baseMat, baseMat, baseMat];
  // Box faces: +x, -x, +y, -y, +z, -z
  // Each face gets UV repeat matching its real-world size in meters
  const faces: [number, number][] = [
    [d, h], // +x
    [d, h], // -x
    [w, d], // +y (top)
    [w, d], // -y (bottom)
    [w, h], // +z
    [w, h], // -z
  ];
  return faces.map(([u, v]) => {
    const tex = baseMat.map!.clone();
    tex.repeat.set(u, v);
    tex.needsUpdate = true;
    const mat = baseMat.clone();
    mat.map = tex;
    return mat;
  });
}

function createWall(x: number, height: number, z: number, width: number, depth: number, scene: THREE.Scene, world: CANNON.World) {
  const geo = new THREE.BoxGeometry(width, height, depth);
  const mat = makeBoxMaterial(width, height, depth, wallMaterial);
  const wall = new THREE.Mesh(geo, mat);
  wall.position.set(x, height / 2, z);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);

  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, height / 2, z);
  world.addBody(body);
}

function createPlatform(x: number, y: number, z: number, width: number, height: number, depth: number, scene: THREE.Scene, world: CANNON.World) {
  const geo = new THREE.BoxGeometry(width, height, depth);
  const mat = makeBoxMaterial(width, height, depth, platformMaterial);
  const platform = new THREE.Mesh(geo, mat);
  platform.position.set(x, y, z);
  platform.castShadow = true;
  platform.receiveShadow = true;
  scene.add(platform);

  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, y, z);
  world.addBody(body);
}

function addAccentLines(scene: THREE.Scene) {
  const lineGeo = new THREE.BoxGeometry(200, 0.05, 0.1);
  const line1 = new THREE.Mesh(lineGeo, accentMaterial);
  line1.position.set(0, 0.025, 0);
  scene.add(line1);

  // Wall run guide lines
  const guideGeo = new THREE.BoxGeometry(0.1, 0.05, 50);
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    const guide = new THREE.Mesh(guideGeo, accentMaterial);
    guide.position.set(i * 8, 0.025, -40);
    scene.add(guide);
  }
}
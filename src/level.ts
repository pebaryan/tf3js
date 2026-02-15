import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// --- Procedural grid texture (1m squares) for measuring displacement ---
function makeGridTexture(gridColor: number, bgColor: number, size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#' + bgColor.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = '#' + gridColor.toString(16).padStart(6, '0');
  ctx.lineWidth = 2;
  const step = 256 / size;
  for (let i = 0; i <= size; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(256, p); ctx.stroke();
  }

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

// All textures: 1 canvas tile = 1 meter
const floorTex = makeGridTexture(0x334466, 0x1a1a2e, 1);
floorTex.repeat.set(100, 100);

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

const slideRampMaterial = new THREE.MeshStandardMaterial({
  color: 0xffaa44,
  map: platTex,
  metalness: 0.2,
  roughness: 0.5,
});

export function createLevel(scene: THREE.Scene, world: CANNON.World, levelConfig?: { layout: string, type: string }) {
  const config = levelConfig || { layout: 'open', type: 'training' };
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

  // === SECTION 1: WALL RUN CORRIDOR (6m wide) ===
  // Long straight walls for practicing wall runs and wall jumps (6m apart)
  createWall(-3.25, 12, -20, 0.5, 40, scene, world);  // Left wall
  createWall(3.25, 12, -20, 0.5, 40, scene, world);   // Right wall

  // Wall jump landing platforms
  createPlatform(-7, 1, -35, 3, 0.5, 3, scene, world);
  createPlatform(7, 1, -35, 3, 0.5, 3, scene, world);
  createPlatform(-7, 1, -10, 3, 0.5, 3, scene, world);
  createPlatform(7, 1, -10, 3, 0.5, 3, scene, world);

  // === SECTION 1b: NARROW WALL RUN CORRIDOR (4m wide) ===
  // Narrow corridor for tight wall runs (single jump only)
  createWall(-2.25, 12, -55, 0.5, 40, scene, world);  // Left wall
  createWall(2.25, 12, -55, 0.5, 40, scene, world);   // Right wall

  // Landing platforms for narrow corridor
  createPlatform(-6, 1, -70, 3, 0.5, 3, scene, world);
  createPlatform(6, 1, -70, 3, 0.5, 3, scene, world);
  createPlatform(-6, 1, -45, 3, 0.5, 3, scene, world);
  createPlatform(6, 1, -45, 3, 0.5, 3, scene, world);
  
  // === SECTION 2: CORNER WALL RUNS ===
  // L-shaped walls for corner wall runs
  createWall(-15, 10, -35, 0.5, 10, scene, world);
  createWall(-20, 10, -40, 10, 0.5, scene, world);
  createWall(15, 10, -35, 0.5, 10, scene, world);
  createWall(20, 10, -40, 10, 0.5, scene, world);

  // === SECTION 3: SLIDE RAMPS ===
  // Sloped surfaces for slide practice
  createSlideRamp(0, 0, 10, 10, 4, 0, scene, world);     // Forward ramp
  createSlideRamp(-15, 0, 10, 8, 3, 0, scene, world);    // Left ramp
  createSlideRamp(15, 0, 10, 8, 3, 0, scene, world);     // Right ramp
  
  // Landing area after slides
  createPlatform(0, 0.5, 20, 15, 0.5, 10, scene, world);
  createPlatform(-15, 0.5, 20, 10, 0.5, 8, scene, world);
  createPlatform(15, 0.5, 20, 10, 0.5, 8, scene, world);

  // === SECTION 4: MANTLE PRACTICE ===
  // Progressive heights for mantle training
  // Easy (1m)
  createWall(-25, 1, -5, 3, 3, scene, world);
  createWall(-25, 1, 0, 3, 3, scene, world);
  createWall(-25, 1, 5, 3, 3, scene, world);
  
  // Medium (2m)
  createWall(-30, 2, -5, 3, 3, scene, world);
  createWall(-30, 2, 0, 3, 3, scene, world);
  createWall(-30, 2, 5, 3, 3, scene, world);
  
  // Hard (3m) - requires jump first
  createWall(-35, 3, -5, 3, 3, scene, world);
  createWall(-35, 3, 0, 3, 3, scene, world);
  createWall(-35, 3, 5, 3, 3, scene, world);

  // === SECTION 5: PLATFORM PARKOUR ===
  // Stepping stones for double jump practice
  createPlatform(20, 1, 0, 3, 0.5, 3, scene, world);
  createPlatform(25, 2, -5, 3, 0.5, 3, scene, world);
  createPlatform(30, 1, 0, 3, 0.5, 3, scene, world);
  createPlatform(35, 3, -5, 3, 0.5, 3, scene, world);
  createPlatform(40, 2, 0, 3, 0.5, 3, scene, world);
  createPlatform(45, 4, -5, 3, 0.5, 3, scene, world);
  
  // High platform challenge
  createPlatform(35, 6, 10, 8, 0.5, 8, scene, world);
  createWall(35, 8, 10, 0.5, 8, scene, world);  // Wall on high platform

  // === SECTION 6: SPRINT / SLIDE COURSE ===
  // Long straightaways for speed testing
  createWall(-40, 3, 0, 0.5, 60, scene, world);
  createWall(-40, 3, -20, 0.5, 60, scene, world);
  createWall(-40, 3, -40, 0.5, 60, scene, world);
  
  // Obstacles to slide under
  createWall(-42, 2, -10, 4, 0.5, scene, world);
  createWall(-42, 2, -30, 4, 0.5, scene, world);

  // === SECTION 7: WALL RUN CHAIN ===
  // Series of walls for chaining wall runs
  createWall(0, 8, -60, 4, 0.5, scene, world);    // Wall 1
  createPlatform(0, 4, -65, 4, 0.5, 4, scene, world);
  createWall(8, 8, -65, 0.5, 4, scene, world);     // Wall 2
  createPlatform(8, 4, -70, 4, 0.5, 4, scene, world);
  createWall(0, 8, -70, 4, 0.5, scene, world);     // Wall 3
  createPlatform(0, 4, -75, 4, 0.5, 4, scene, world);
  createWall(-8, 8, -75, 0.5, 4, scene, world);    // Wall 4

  // === SHOOTING TARGETS AREA ===
  // Open area with targets at various distances
  createPlatform(0, 0.5, 40, 20, 0.5, 20, scene, world);
  createWall(0, 4, 45, 0.5, 10, scene, world);
  createWall(-8, 3, 50, 0.5, 8, scene, world);
  createWall(8, 5, 55, 0.5, 12, scene, world);
  
  // Distance markers
  for (let i = 10; i <= 50; i += 10) {
    createDistanceMarker(-12, 0.1, 40 + i, i.toString(), scene);
  }

  // === BOUNDARY WALLS ===
  createWall(0, 5, -100, 200, 10, scene, world);
  createWall(-80, 5, 0, 0.5, 200, scene, world);
  createWall(80, 5, 0, 0.5, 200, scene, world);
  createWall(0, 5, 80, 200, 10, scene, world);
  
  // Level-specific additions
  if (config.type === 'capture') {
    // Create capture point platforms
    createPlatform(-15, 0.5, 30, 6, 0.5, 6, scene, world);
    createPlatform(0, 0.5, 30, 6, 0.5, 6, scene, world);
    createPlatform(15, 0.5, 30, 6, 0.5, 6, scene, world);
  } else if (config.type === 'race') {
    // Create race finish line
    const finishGeo = new THREE.BoxGeometry(10, 0.5, 6);
    const finishMat = new THREE.MeshStandardMaterial({ color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.5 });
    const finish = new THREE.Mesh(finishGeo, finishMat);
    finish.position.set(0, 2.5, -85);
    finish.castShadow = true;
    finish.receiveShadow = true;
    scene.add(finish);
    
    // Add finish sign
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#00ffcc';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', 128, 64);
    
    const tex = new THREE.CanvasTexture(canvas);
    const signGeo = new THREE.PlaneGeometry(8, 4);
    const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(0, 5, -85);
    scene.add(sign);
  } else if (config.type === 'survival') {
    // Create survival arena with higher walls
    createWall(-20, 8, -20, 0.5, 60, scene, world);
    createWall(20, 8, -20, 0.5, 60, scene, world);
    createWall(0, 8, -60, 40, 0.5, scene, world);
  }
  
  addAccentLines(scene);
  addSignage(scene, config.type);
}

function makeBoxMaterial(w: number, h: number, d: number, baseMat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial[] {
  if (!baseMat.map) return [baseMat, baseMat, baseMat, baseMat, baseMat, baseMat];
  const faces: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
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

function createSlideRamp(x: number, y: number, z: number, width: number, length: number, rotation: number, scene: THREE.Scene, world: CANNON.World) {
  // Create a sloped ramp using a rotated box
  const height = 3;
  const geo = new THREE.BoxGeometry(width, height, length);
  const mat = makeBoxMaterial(width, height, length, slideRampMaterial);
  const ramp = new THREE.Mesh(geo, mat);
  
  ramp.position.set(x, y + height / 2, z);
  ramp.rotation.x = -Math.PI / 6; // 30 degree slope
  ramp.rotation.y = rotation;
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);

  // Cannon box shape (simpler than rotated trimesh)
  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, length / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, y + height / 2, z);
  body.quaternion.setFromEuler(-Math.PI / 6, rotation, 0);
  world.addBody(body);
}

function createDistanceMarker(x: number, y: number, z: number, text: string, scene: THREE.Scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = '#00ffcc';
  ctx.font = 'bold 32px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text + 'm', 64, 32);
  
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.PlaneGeometry(2, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y + 0.5, z);
  mesh.rotation.x = -Math.PI / 2;
  scene.add(mesh);
}

function addSignage(scene: THREE.Scene, levelType: string) {
  if (levelType === 'training') {
    // Wall Run sign
    createSign(0, 3, -5, "WALL RUN\nCORRIDOR", 0, scene);
    
    // Mantle sign
    createSign(-30, 3, 10, "MANTLE\nPRACTICE", 0, scene);
    
    // Slide sign
    createSign(0, 3, 5, "SLIDE\nRAMPS", 0, scene);
    
    // Parkour sign
    createSign(30, 3, 10, "PLATFORM\nPARKOUR", 0, scene);
    
    // Sprint sign
    createSign(-40, 3, 5, "SPRINT\nCOURSE", Math.PI / 2, scene);
    
    // Targets sign
    createSign(0, 3, 35, "SHOOTING\nRANGE", 0, scene);
  } else if (levelType === 'capture') {
    createSign(0, 3, 35, "CAPTURE\nPOINTS", 0, scene);
  } else if (levelType === 'race') {
    createSign(0, 3, 35, "RACE\nCOURSE", 0, scene);
  } else if (levelType === 'survival') {
    createSign(0, 3, 35, "SURVIVAL\nARENA", 0, scene);
  }
}

function createSign(x: number, y: number, z: number, text: string, rotation: number, scene: THREE.Scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#00ffcc';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 124);
  
  ctx.fillStyle = '#00ffcc';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    ctx.fillText(line, 128, 40 + i * 35);
  });
  
  const tex = new THREE.CanvasTexture(canvas);
  const geo = new THREE.PlaneGeometry(4, 2);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotation;
  scene.add(mesh);
}

function addAccentLines(scene: THREE.Scene) {
  const lineGeo = new THREE.BoxGeometry(200, 0.05, 0.1);
  const line1 = new THREE.Mesh(lineGeo, accentMaterial);
  line1.position.set(0, 0.025, 0);
  scene.add(line1);

  // Perpendicular guide lines every 10m
  for (let i = -80; i <= 80; i += 10) {
    if (i === 0) continue;
    const guideGeo = new THREE.BoxGeometry(0.1, 0.05, 200);
    const guide = new THREE.Mesh(guideGeo, accentMaterial);
    guide.position.set(i, 0.025, 0);
    scene.add(guide);
  }
}

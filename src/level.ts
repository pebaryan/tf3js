import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { bevelBox, mergeAndDispose, placedBox } from './geometryUtils';

// --- Procedural grid texture (1m squares) for measuring displacement ---
function makeGridTexture(gridColor: number, bgColor: number, size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  // Base background
  ctx.fillStyle = '#' + bgColor.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, 512, 512);

  // Add subtle digital "circuitry" noise
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#ffffff';
  for (let i = 0; i < 20; i++) {
    const x = Math.floor(Math.random() * 8) * 64;
    const y = Math.floor(Math.random() * 8) * 64;
    ctx.strokeRect(x, y, 64, 64);
  }
  ctx.globalAlpha = 1;

  // Draw grid lines
  ctx.strokeStyle = '#' + gridColor.toString(16).padStart(6, '0');
  ctx.lineWidth = 2;
  const step = 512 / size;
  for (let i = 0; i <= size; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(512, p); ctx.stroke();
  }

  // Digital "scanline" effect
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  for (let i = 0; i < 512; i += 4) {
    ctx.fillRect(0, i, 512, 1);
  }

  // Crosshairs / Technical markers
  ctx.strokeStyle = '#' + gridColor.toString(16).padStart(6, '0');
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.4;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const cx = (i + 0.5) * step;
      const cy = (j + 0.5) * step;
      const r = 15;
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// All textures: 1 canvas tile = 1 meter
// War Games Palette: Sharp White, Dark Navy Blue Grid (0x001133), High-Intensity Cyan (0x00ffff)
const floorTex = makeGridTexture(0x001133, 0xf0f0f0, 1);
floorTex.repeat.set(100, 100);

const wallTex = makeGridTexture(0x00081a, 0xffffff, 1);
wallTex.repeat.set(1, 1);

const platTex = makeGridTexture(0x00081a, 0xe0e0e0, 1);
platTex.repeat.set(1, 1);

const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: wallTex,
  metalness: 0.15,
  roughness: 0.6,
});

const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: floorTex,
  metalness: 0.1,
  roughness: 0.8,
});

const platformMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: platTex,
  metalness: 0.15,
  roughness: 0.6,
});

const accentMaterial = new THREE.MeshStandardMaterial({
  color: 0x00ffff,
  emissive: 0x00ffff,
  emissiveIntensity: 3.0,
});

const neonMaterial = new THREE.MeshStandardMaterial({
  color: 0x00ffff,
  emissive: 0x00ffff,
  emissiveIntensity: 6.0,
  transparent: true,
  opacity: 0.95
});

const slideRampMaterial = new THREE.MeshStandardMaterial({
  color: 0xff6600,
  map: platTex,
  metalness: 0.15,
  roughness: 0.5,
});

// Structural trim: machined gunmetal for copings, plinths, ribs and platform edges
const trimMaterial = new THREE.MeshStandardMaterial({
  color: 0x2b333d,
  metalness: 0.75,
  roughness: 0.35,
});

// Recessed panel seams on large wall faces
const seamMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa6b2,
  metalness: 0.3,
  roughness: 0.55,
});

/** Height of the metal coping that caps every wall (kept inside the wall's collision height). */
const COPING_HEIGHT = 0.16;
/** Height of the dark plinth at the foot of walls. */
const PLINTH_HEIGHT = 0.28;
/** Spacing of the vertical ribs along long walls. */
const RIB_SPACING = 4;

let neonStrips: THREE.Mesh[] = [];

export function updateLevelVisuals(time: number) {
  const pulse = 0.5 + Math.sin(time * 2) * 0.5;
  neonMaterial.emissiveIntensity = 1.0 + pulse * 2.0;
  neonMaterial.opacity = 0.6 + pulse * 0.4;
}

/**
 * Thin glowing strips wrapped around a block. `topInset` pushes the upper strip
 * down so it sits below a coping or edge band instead of being hidden by it.
 */
function addNeonAccents(mesh: THREE.Mesh, w: number, h: number, d: number, topInset = 0, bottom = true) {
  const stripHeight = 0.05;

  if (h - topInset > stripHeight * 4) {
    const topStrip = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, stripHeight, d + 0.02), neonMaterial);
    topStrip.position.y = h / 2 - topInset - stripHeight;
    mesh.add(topStrip);
    neonStrips.push(topStrip);
  }

  if (bottom) {
    const botStrip = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, stripHeight, d + 0.02), neonMaterial);
    botStrip.position.y = -h / 2 + stripHeight;
    mesh.add(botStrip);
    neonStrips.push(botStrip);
  }
}

/**
 * Decorative architecture for a wall block: a metal coping on top, a plinth at
 * the base and, on long thin walls, vertical ribs and a horizontal panel seam.
 * Everything is merged into one child mesh per material (one draw call each).
 *
 * These are children of the wall, so gameplay raycasts (which only test the
 * scene's top-level meshes) and physics are unaffected.
 */
function addWallDetail(wall: THREE.Mesh, width: number, height: number, depth: number) {
  const trim: THREE.BufferGeometry[] = [];
  const seams: THREE.BufferGeometry[] = [];
  const top = height / 2;
  const bottom = -height / 2;

  // Coping: slightly proud of the faces, flush with the top so feet never clip it
  const copingH = Math.min(COPING_HEIGHT, height * 0.2);
  trim.push(placedBox(width + 0.1, copingH, depth + 0.1, 0, top - copingH / 2 + 0.005, 0));

  // Plinth
  if (height > 1.2) {
    const plinthH = Math.min(PLINTH_HEIGHT, height * 0.15);
    trim.push(placedBox(width + 0.08, plinthH, depth + 0.08, 0, bottom + plinthH / 2, 0));
  }

  // Ribs and seams only on long, thin walls (corridors, boundaries)
  const alongX = width >= depth;
  const length = alongX ? width : depth;
  const thickness = alongX ? depth : width;
  if (length > 6 && thickness < 1.5 && height > 2) {
    const ribH = height - copingH - PLINTH_HEIGHT;
    const ribY = bottom + PLINTH_HEIGHT + ribH / 2;
    const count = Math.max(1, Math.floor(length / RIB_SPACING));
    const start = -((count - 1) * RIB_SPACING) / 2;
    for (let i = 0; i < count; i++) {
      const along = start + i * RIB_SPACING;
      for (const side of [-1, 1]) {
        const off = side * (thickness / 2 + 0.03);
        trim.push(alongX
          ? placedBox(0.28, ribH, 0.06, along, ribY, off)
          : placedBox(0.06, ribH, 0.28, off, ribY, along));
      }
    }

    // Horizontal seam band at roughly door-frame height
    const seamY = Math.min(bottom + 3, top - copingH - 0.6);
    for (const side of [-1, 1]) {
      const off = side * (thickness / 2 + 0.008);
      seams.push(alongX
        ? placedBox(length - 0.2, 0.06, 0.016, 0, seamY, off)
        : placedBox(0.016, 0.06, length - 0.2, off, seamY, 0));
    }
  }

  const trimGeo = mergeAndDispose(trim);
  if (trimGeo) {
    const trimMesh = new THREE.Mesh(trimGeo, trimMaterial);
    trimMesh.castShadow = true;
    trimMesh.receiveShadow = true;
    wall.add(trimMesh);
  }
  const seamGeo = mergeAndDispose(seams);
  if (seamGeo) {
    const seamMesh = new THREE.Mesh(seamGeo, seamMaterial);
    seamMesh.receiveShadow = true;
    wall.add(seamMesh);
  }
}

/** Metal edge band around the top of a platform, plus corner brackets underneath. */
function addPlatformDetail(platform: THREE.Mesh, width: number, height: number, depth: number) {
  const trim: THREE.BufferGeometry[] = [];
  const bandH = Math.min(0.14, height * 0.4);
  const bandY = height / 2 - bandH / 2 + 0.004;
  const t = 0.05;
  // Four sides of the band, just outside the platform faces (never above the walkable top)
  trim.push(placedBox(width + 2 * t, bandH, t, 0, bandY, depth / 2 + t / 2));
  trim.push(placedBox(width + 2 * t, bandH, t, 0, bandY, -depth / 2 - t / 2));
  trim.push(placedBox(t, bandH, depth, width / 2 + t / 2, bandY, 0));
  trim.push(placedBox(t, bandH, depth, -width / 2 - t / 2, bandY, 0));

  // Underside corner brackets for raised platforms
  const bracket = Math.min(0.35, width * 0.12, depth * 0.12);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      trim.push(placedBox(bracket, 0.08, bracket, sx * (width / 2 - bracket / 2), -height / 2 - 0.04, sz * (depth / 2 - bracket / 2)));
    }
  }

  const geo = mergeAndDispose(trim);
  if (!geo) return;
  const mesh = new THREE.Mesh(geo, trimMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  platform.add(mesh);
}

/** Glowing chevrons painted on a slide ramp's top face, pointing down the slope. */
const chevronTexture = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 14;
  ctx.lineCap = 'square';
  for (const y of [30, 78]) {
    ctx.beginPath();
    ctx.moveTo(20, y);
    ctx.lineTo(64, y + 30);
    ctx.lineTo(108, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const chevronMaterial = new THREE.MeshBasicMaterial({
  map: chevronTexture,
  color: new THREE.Color(0xffd0a0).multiplyScalar(2.2), // HDR so it blooms
  transparent: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
});

function addRampChevrons(ramp: THREE.Mesh, width: number, height: number, length: number) {
  const count = Math.max(1, Math.floor(length / 1.5));
  for (let i = 0; i < count; i++) {
    const chevron = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(1.4, width * 0.3), 1.2), chevronMaterial);
    chevron.rotation.x = -Math.PI / 2;
    // Ramp's local +z points down the slope (it's tilted by -30° about X)
    chevron.position.set(0, height / 2 + 0.01, -length / 2 + (i + 0.5) * (length / count));
    ramp.add(chevron);
  }
}

export function createLevel(scene: THREE.Scene, world: CANNON.World, levelConfig?: { layout: string, type: string }) {
  const config = levelConfig || { layout: 'open', type: 'training' };
  neonStrips = []; // Reset neon strips
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
    createDistanceMarker(-12, 40 + i, i.toString(), scene);
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
    tex.colorSpace = THREE.SRGBColorSpace;
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
  const geo = bevelBox(width, height, depth, 0.05);
  const mat = makeBoxMaterial(width, height, depth, wallMaterial);
  const wall = new THREE.Mesh(geo, mat);
  wall.position.set(x, height / 2, z);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);

  addNeonAccents(wall, width, height, depth, Math.min(COPING_HEIGHT, height * 0.2) + 0.08, height > 1.2);
  addWallDetail(wall, width, height, depth);

  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, height / 2, z);
  world.addBody(body);
}

function createPlatform(x: number, y: number, z: number, width: number, height: number, depth: number, scene: THREE.Scene, world: CANNON.World) {
  const geo = bevelBox(width, height, depth, 0.04);
  const mat = makeBoxMaterial(width, height, depth, platformMaterial);
  const platform = new THREE.Mesh(geo, mat);
  platform.position.set(x, y, z);
  platform.castShadow = true;
  platform.receiveShadow = true;
  scene.add(platform);

  addNeonAccents(platform, width, height, depth, height, true);
  addPlatformDetail(platform, width, height, depth);

  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, y, z);
  world.addBody(body);
}

function createSlideRamp(x: number, y: number, z: number, width: number, length: number, rotation: number, scene: THREE.Scene, world: CANNON.World) {
  // Create a sloped ramp using a rotated box
  const height = 3;
  const geo = bevelBox(width, height, length, 0.06);
  const mat = makeBoxMaterial(width, height, length, slideRampMaterial);
  const ramp = new THREE.Mesh(geo, mat);
  
  ramp.position.set(x, y + height / 2, z);
  ramp.rotation.x = -Math.PI / 6; // 30 degree slope
  ramp.rotation.y = rotation;
  ramp.castShadow = true;
  ramp.receiveShadow = true;
  scene.add(ramp);

  addNeonAccents(ramp, width, height, length);
  addRampChevrons(ramp, width, height, length);

  // Cannon box shape (simpler than rotated trimesh)
  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, length / 2));
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(x, y + height / 2, z);
  body.quaternion.setFromEuler(-Math.PI / 6, rotation, 0);
  world.addBody(body);
}

function createDistanceMarker(x: number, z: number, text: string, scene: THREE.Scene) {
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
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(2, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 0.01, z); // Grounded on floor
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
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(6, 16, 24, 0.92)';
  ctx.strokeStyle = '#00ffcc';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(54, 34);
  ctx.lineTo(478, 34);
  ctx.lineTo(454, 222);
  ctx.lineTo(30, 222);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = 'rgba(0, 255, 204, 0.14)';
  ctx.fillRect(78, 54, 356, 34);
  ctx.fillStyle = '#9fffee';
  ctx.font = 'bold 26px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TRAINING POI', 256, 71);

  ctx.strokeStyle = 'rgba(0, 255, 204, 0.32)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(86, 192);
  ctx.lineTo(426, 192);
  ctx.stroke();

  ctx.shadowColor = '#00ffcc';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#00ffcc';
  ctx.font = 'bold 44px Arial';
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    ctx.fillText(line, 256, 118 + i * 44);
  });
  ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const group = new THREE.Group();
  group.position.set(x, y + 3.8, z);
  group.rotation.y = rotation;

  const panelGeo = new THREE.PlaneGeometry(5.4, 2.7);
  const panelMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });

  const frontPanel = new THREE.Mesh(panelGeo, panelMat);
  frontPanel.position.z = 0.06;
  group.add(frontPanel);

  const backPanel = new THREE.Mesh(panelGeo, panelMat.clone());
  backPanel.rotation.y = Math.PI;
  backPanel.position.z = -0.06;
  group.add(backPanel);

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(5.65, 2.95, 0.08),
    new THREE.MeshStandardMaterial({
      color: 0x0b141c,
      emissive: 0x00ffcc,
      emissiveIntensity: 0.08,
      metalness: 0.55,
      roughness: 0.35,
    })
  );
  group.add(frame);

  const topGlow = new THREE.Mesh(
    new THREE.BoxGeometry(5.1, 0.08, 0.16),
    new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.7 })
  );
  topGlow.position.set(0, 1.23, 0);
  group.add(topGlow);

  const sideNotchGeo = new THREE.BoxGeometry(0.14, 2.45, 0.14);
  const sideMat = new THREE.MeshStandardMaterial({
    color: 0x12303a,
    emissive: 0x00ffcc,
    emissiveIntensity: 0.1,
    metalness: 0.35,
    roughness: 0.45,
  });
  const leftPost = new THREE.Mesh(sideNotchGeo, sideMat);
  leftPost.position.set(-2.74, -0.08, 0);
  group.add(leftPost);

  const rightPost = new THREE.Mesh(sideNotchGeo, sideMat);
  rightPost.position.set(2.74, -0.08, 0);
  group.add(rightPost);

  scene.add(group);
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

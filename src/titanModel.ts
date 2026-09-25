import * as THREE from 'three';
import { bevelBox } from './geometryUtils';

/*
 * Procedural Titan model.
 *
 * Silhouette first: a wide, top-heavy chassis over a narrow waist, three-part
 * legs (thigh, shin, foot) with big planted feet, heavy forearms and a rotary
 * cannon held in the right hand. Front is +z; the ground is y = 0.
 *
 * Legs are real joint chains (hip → knee → ankle) posed by two-bone IK so the
 * feet stay planted however far the body crouches.
 */

/** Hip height above the ground when standing (body-space y of the leg pivots). */
/**
 * The rig is modelled ~11.2 m tall; the playable titan is scaled to ~7 m
 * (about twice a reaper). Everything in this file is in model units; the
 * Titan class applies the scale on a root node above the rig.
 */
export const TITAN_SCALE = 0.62;
/** Model-unit height of the rig standing upright (top of the engine pack). */
export const TITAN_MODEL_HEIGHT = 11.23;

export const TITAN_HIP_HEIGHT = 5.0;
/** Ankle joint height above the ground (half the foot's height). */
export const TITAN_ANKLE_HEIGHT = 0.35;
/*
 * Thigh + shin (5.15) are deliberately longer than the standing hip-to-ankle
 * distance (4.65), so IK leaves the knees bent ~25° even at rest: a planted,
 * ready stance instead of locked-straight legs.
 */
export const TITAN_THIGH_LENGTH = 2.65;
export const TITAN_SHIN_LENGTH = 2.5;
/** Right shoulder pivot in torso space (the left one is mirrored in X). */
export const TITAN_SHOULDER = new THREE.Vector3(2.55, 0.75, -0.1);

export interface TitanLegRig {
  hip: THREE.Group;
  thigh: THREE.Mesh;
  shin: THREE.Mesh;
  foot: THREE.Group;
}

export interface TitanRig {
  torso: THREE.Mesh;
  visor: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftElbow: THREE.Group;
  rightElbow: THREE.Group;
  leftShoulder: THREE.Mesh;
  rightShoulder: THREE.Mesh;
  leftForearm: THREE.Mesh;
  rightForearm: THREE.Mesh;
  leftFist: THREE.Mesh;
  rightFist: THREE.Mesh;
  leftLeg: TitanLegRig;
  rightLeg: TitanLegRig;
  /** The held weapon (child of the torso) and how it is gripped. */
  weapon: THREE.Group;
  weaponMount: TitanWeaponMount;
  /** Muzzle points in `weapon` space. */
  muzzleOffsets: THREE.Vector3[];
}

/**
 * Two-bone IK in the leg's sagittal plane with the ankle straight below the hip.
 * Returns joint rotations (radians about X): negative thigh = knee forward.
 */
export function solveTwoBoneIK(thigh: number, shin: number, hipToAnkle: number): { hip: number; knee: number; ankle: number } {
  const max = thigh + shin;
  const d = THREE.MathUtils.clamp(hipToAnkle, max * 0.3, max);
  const cosA1 = THREE.MathUtils.clamp((thigh * thigh + d * d - shin * shin) / (2 * thigh * d), -1, 1);
  const cosA2 = THREE.MathUtils.clamp((shin * shin + d * d - thigh * thigh) / (2 * shin * d), -1, 1);
  const a1 = Math.acos(cosA1);
  const a2 = Math.acos(cosA2);
  return { hip: -a1, knee: a1 + a2, ankle: -a2 };
}

/** Pose both legs so the feet stay on the ground for the body's current height offset. */
export function poseTitanLegs(rig: TitanRig, bodyOffsetY: number): void {
  const hipToAnkle = TITAN_HIP_HEIGHT + bodyOffsetY - TITAN_ANKLE_HEIGHT;
  const { hip, knee, ankle } = solveTwoBoneIK(TITAN_THIGH_LENGTH, TITAN_SHIN_LENGTH, hipToAnkle);
  for (const leg of [rig.leftLeg, rig.rightLeg]) {
    leg.thigh.rotation.x = hip;
    leg.shin.rotation.x = knee;
    leg.foot.rotation.x = ankle;
  }
}

/* ------------------------------------------------------------------ */
/*  Weapon mounts and arm IK                                           */
/* ------------------------------------------------------------------ */

/**
 * How a Titan weapon is held.
 * - `below`: the weapon hangs under the main hand, which grips a handle on top.
 * - `above`: the weapon rides on top of the main hand, which grips a pistol grip underneath.
 * In both cases the other hand holds a handle on the weapon's left side.
 */
export type TitanGripStyle = 'below' | 'above';

export interface TitanWeaponMount {
  style: TitanGripStyle;
  /** Weapon origin in torso space while held (barrels point +z). */
  position: THREE.Vector3;
  /** Main (right) hand grip in weapon space. */
  mainGrip: THREE.Vector3;
  /** Side handle for the support (left) hand, in weapon space. */
  supportGrip: THREE.Vector3;
}

/** Upper arm: shoulder pivot to elbow pivot. */
export const TITAN_UPPER_ARM_LENGTH = 2.2;
/** Forearm: elbow pivot to the centre of the fist. */
export const TITAN_FOREARM_LENGTH = 2.4;

export const XO16_MOUNTS: Record<TitanGripStyle, TitanWeaponMount> = {
  below: {
    style: 'below',
    position: new THREE.Vector3(0.45, -2.25, 1.75),
    mainGrip: new THREE.Vector3(0, 0.95, 0.3),
    supportGrip: new THREE.Vector3(-1.0, 0, 0.75),
  },
  above: {
    style: 'above',
    position: new THREE.Vector3(0.45, -1.35, 1.75),
    mainGrip: new THREE.Vector3(0, -0.95, 0.05),
    supportGrip: new THREE.Vector3(-1.0, 0, 0.75),
  },
};

/** The XO-16's grip style. Switch to 'above' to carry it on a pistol grip instead. */
export const XO16_GRIP_STYLE: TitanGripStyle = 'below';

/**
 * Analytic two-bone IK in 3D. Places the elbow in the plane containing the
 * shoulder, the target and the `pole` hint (the direction the elbow should
 * point), then returns the elbow position and the hand position actually
 * reached (the target, pulled in if it is out of reach).
 */
export function solveArmIK(
  shoulder: THREE.Vector3,
  target: THREE.Vector3,
  upper: number,
  lower: number,
  pole: THREE.Vector3,
): { elbow: THREE.Vector3; hand: THREE.Vector3 } {
  const toTarget = target.clone().sub(shoulder);
  const rawDist = toTarget.length();
  const dir = rawDist > 1e-6 ? toTarget.divideScalar(rawDist) : new THREE.Vector3(0, -1, 0);
  const minReach = Math.abs(upper - lower) + 1e-3;
  const maxReach = upper + lower - 1e-3;
  const d = THREE.MathUtils.clamp(rawDist, minReach, maxReach);

  // Distance along the shoulder→hand line to the foot of the elbow, and the elbow's offset from it
  const a = (upper * upper - lower * lower + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, upper * upper - a * a));

  // Bend direction: the pole hint with its component along the arm removed
  const bend = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(dir, dir.y);
  bend.normalize();

  const elbow = shoulder.clone().addScaledVector(dir, a).addScaledVector(bend, h);
  const hand = shoulder.clone().addScaledVector(dir, d);
  return { elbow, hand };
}

const _down = new THREE.Vector3(0, -1, 0);

/** Rotate an arm (shoulder group + elbow group, both built pointing -Y) so its fist lands on `target` (torso space). */
function aimArm(arm: THREE.Group, elbow: THREE.Group, target: THREE.Vector3, pole: THREE.Vector3): void {
  const ik = solveArmIK(arm.position, target, TITAN_UPPER_ARM_LENGTH, TITAN_FOREARM_LENGTH, pole);
  const upperDir = ik.elbow.clone().sub(arm.position).normalize();
  arm.quaternion.setFromUnitVectors(_down, upperDir);
  // Forearm direction expressed in the upper arm's frame
  const lowerDir = ik.hand.clone().sub(ik.elbow).normalize().applyQuaternion(arm.quaternion.clone().invert());
  elbow.quaternion.setFromUnitVectors(_down, lowerDir);
}

/**
 * Two-handed hold: place the weapon in front of the torso, then solve both arms
 * so the right fist closes on the main grip and the left fist on the side
 * handle. `crouch` (0..1) lowers the weapon slightly for the landing pose.
 */
export function poseTitanArms(rig: TitanRig, crouch: number): void {
  const c = THREE.MathUtils.clamp(crouch, 0, 1);
  const mount = rig.weaponMount;
  rig.weapon.position.copy(mount.position).add(new THREE.Vector3(0, -0.25 * c, 0.1 * c));
  rig.weapon.rotation.set(-0.12 * c, 0, 0);
  rig.weapon.updateMatrix();

  const main = mount.mainGrip.clone().applyMatrix4(rig.weapon.matrix);
  const support = mount.supportGrip.clone().applyMatrix4(rig.weapon.matrix);

  // Elbows: flared out and back when gripping over the top, tucked down when holding a pistol grip
  const rightPole = mount.style === 'below' ? new THREE.Vector3(1, -0.2, -0.7) : new THREE.Vector3(0.5, -1, -0.5);
  const leftPole = new THREE.Vector3(-1, -0.8, -0.3);
  aimArm(rig.rightArm, rig.rightElbow, main, rightPole);
  aimArm(rig.leftArm, rig.leftElbow, support, leftPole);
}

/* ------------------------------------------------------------------ */
/*  Materials                                                          */
/* ------------------------------------------------------------------ */

function makeHazardTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f2b01e';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#1b1e22';
  for (let x = -64; x < 320; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 64);
    ctx.lineTo(x + 24, 64);
    ctx.lineTo(x + 88, 0);
    ctx.lineTo(x + 64, 0);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMarkingTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 128);
  ctx.fillStyle = 'rgba(24, 28, 34, 0.92)';
  ctx.font = 'bold 60px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 54);
  ctx.fillRect(34, 98, 188, 7);
  ctx.fillStyle = '#f36b1c';
  ctx.fillRect(34, 110, 60, 7);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMaterials() {
  return {
    paint: new THREE.MeshStandardMaterial({ color: 0xb4bcc4, metalness: 0.3, roughness: 0.52 }),
    paintDark: new THREE.MeshStandardMaterial({ color: 0x7d8792, metalness: 0.35, roughness: 0.5 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2b3139, metalness: 0.8, roughness: 0.36 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x16191d, metalness: 0.6, roughness: 0.45 }),
    // Open-ended bells are seen from inside too
    nozzle: new THREE.MeshStandardMaterial({ color: 0x1c2025, metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 1.0, roughness: 0.16 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xf36b1c, metalness: 0.25, roughness: 0.48 }),
    hazard: new THREE.MeshStandardMaterial({ map: makeHazardTexture(), metalness: 0.2, roughness: 0.6 }),
    marking: new THREE.MeshStandardMaterial({ map: makeMarkingTexture('TX-07'), transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }),
    // HDR emissive colours so the sensor and thrusters bloom
    glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3dfff0).multiplyScalar(3) }),
    thruster: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff7a2a).multiplyScalar(3.5) }),
  };
}

type TitanMaterials = ReturnType<typeof makeMaterials>;

/* ------------------------------------------------------------------ */
/*  Builders                                                           */
/* ------------------------------------------------------------------ */

function part(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = !(mat instanceof THREE.MeshBasicMaterial) && !mat.transparent;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Cylinder along X (for joints and axles). */
function axle(radius: number, length: number, segments = 20): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments);
  geo.rotateZ(Math.PI / 2);
  return geo;
}

/** Cylinder along Z (barrels, nozzles). */
function tube(radiusFront: number, radiusBack: number, length: number, segments = 20, open = false): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radiusFront, radiusBack, length, segments, 1, open);
  geo.rotateX(Math.PI / 2);
  return geo;
}

/** Hydraulic ram between two points in `parent` space. */
function ram(parent: THREE.Object3D, m: TitanMaterials, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.6, radius * 1.6, len * 0.55, 14), m.frame);
  sleeve.quaternion.copy(q);
  sleeve.position.copy(a).addScaledVector(dir, 0.275);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len * 0.55, 14), m.chrome);
  rod.quaternion.copy(q);
  rod.position.copy(a).addScaledVector(dir, 0.72);
  for (const mesh of [sleeve, rod]) {
    mesh.castShadow = true;
    parent.add(mesh);
  }
}

function buildTorso(m: TitanMaterials): { torso: THREE.Mesh; visor: THREE.Mesh } {
  // Core chassis; the torso mesh itself is the central hull
  const torso = new THREE.Mesh(bevelBox(3.2, 2.3, 2.3, 0.2, 0.2), m.paint);
  torso.castShadow = true;
  torso.receiveShadow = true;

  // Wide shoulder yoke gives the top-heavy V silhouette
  part(torso, bevelBox(4.6, 1.05, 2.5, 0.22, 0.22), m.paintDark, 0, 1.2, -0.15);
  part(torso, bevelBox(4.7, 0.14, 2.3, 0.05), m.frame, 0, 0.63, -0.15);
  // Lower chassis / belly
  part(torso, bevelBox(2.4, 0.9, 1.8, 0.14, 0.14), m.frame, 0, -1.5, -0.05);

  // Cockpit hatch: two angled armour plates forming a wedge
  part(torso, bevelBox(2.5, 1.35, 0.36, 0.1), m.paint, 0, 0.35, 1.25, -0.32);
  const lower = part(torso, bevelBox(2.3, 1.0, 0.36, 0.1), m.paint, 0, -0.78, 1.22, 0.22);
  // Hazard band across the lower hatch
  part(lower, new THREE.PlaneGeometry(2.0, 0.28), m.hazard, 0, -0.18, 0.185);
  // Hatch seam and hinges
  part(torso, bevelBox(2.35, 0.08, 0.2, 0.02), m.dark, 0, -0.22, 1.36);
  for (const sx of [-1, 1]) part(torso, axle(0.12, 0.35), m.frame, sx * 1.05, -0.22, 1.3);

  // Central sensor "eye" set into the yoke above the hatch, flanked by a visor slit
  part(torso, tube(0.44, 0.5, 0.3, 28), m.frame, 0, 1.1, 1.18);
  part(torso, tube(0.3, 0.3, 0.32, 28), m.glow, 0, 1.1, 1.22);
  const visor = part(torso, bevelBox(2.4, 0.13, 0.1, 0.03), m.glow, 0, 1.1, 1.11);

  // Side intakes: stacked slats inside a frame
  for (const sx of [-1, 1]) {
    part(torso, bevelBox(0.18, 1.2, 1.4, 0.05), m.frame, sx * 1.66, -0.15, 0.1);
    for (let i = 0; i < 5; i++) part(torso, bevelBox(0.14, 0.09, 1.2, 0.02), m.dark, sx * 1.76, -0.6 + i * 0.22, 0.1);
  }

  // Rear engine pack with thrusters
  part(torso, bevelBox(2.8, 2.2, 1.2, 0.18, 0.18), m.frame, 0, 0.2, -1.7);
  for (const sx of [-1, 1]) part(torso, bevelBox(1.15, 1.35, 0.14, 0.06), m.paint, sx * 0.66, 0.2, -2.33, 0.08); // engine covers
  part(torso, bevelBox(2.2, 0.12, 0.08, 0.02), m.glow, 0, 1.05, -2.34);
  part(torso, new THREE.PlaneGeometry(1.9, 0.24), m.hazard, 0, -0.62, -2.31, 0, Math.PI, 0);
  for (const sx of [-1, 1]) {
    // Jump-jet bells under the engine pack, exhausting downward and slightly back
    const mount = part(torso, bevelBox(0.8, 0.3, 0.8, 0.08), m.frame, sx * 0.75, -0.95, -1.95);
    const nozzle = part(mount, new THREE.CylinderGeometry(0.26, 0.42, 0.8, 24, 1, true), m.nozzle, 0, -0.5, 0, 0.25);
    // Glowing exhaust face inside the bell, facing the ground
    part(nozzle, new THREE.CircleGeometry(0.34, 24), m.thruster, 0, -0.3, 0, Math.PI / 2);
  }
  // Antennae
  part(torso, new THREE.CylinderGeometry(0.035, 0.05, 1.8, 6), m.frame, 1.55, 2.3, -1.2, 0, 0, -0.12);
  part(torso, new THREE.CylinderGeometry(0.03, 0.04, 1.2, 6), m.frame, 1.3, 2.0, -1.4, 0, 0, -0.2);

  return { torso, visor };
}

function buildArm(m: TitanMaterials, side: -1 | 1): {
  arm: THREE.Group; elbow: THREE.Group; shoulder: THREE.Mesh; forearm: THREE.Mesh; fist: THREE.Mesh; pauldron: THREE.Mesh;
} {
  const arm = new THREE.Group();

  const shoulder = part(arm, new THREE.SphereGeometry(0.72, 24, 16), m.frame, 0, 0, 0);
  // Pauldron: big armour plate over the shoulder, with stripe and marking
  const pauldron = part(arm, bevelBox(1.75, 1.15, 2.2, 0.2, 0.2), m.paint, side * 0.35, 0.55, 0, 0, 0, side * -0.22);
  part(pauldron, bevelBox(1.77, 0.14, 0.34, 0.04), m.accent, 0, 0.1, 0.95);
  part(pauldron, new THREE.PlaneGeometry(1.0, 0.5), m.marking, side * 0.885, -0.05, 0, 0, side * Math.PI / 2, 0);

  // Upper arm with outer armour plate and a hydraulic ram
  part(arm, bevelBox(0.95, 1.7, 1.0, 0.12), m.paintDark, 0, -1.2, 0);
  part(arm, bevelBox(0.3, 1.3, 1.0, 0.08), m.paintDark, side * 0.5, -1.2, 0);
  ram(arm, m, new THREE.Vector3(0, -0.6, 0.55), new THREE.Vector3(0, -2.3, 0.6), 0.08);

  // Elbow joint: forearm, hand (and the cannon) hang off this pivot so the arm can bend
  const elbow = new THREE.Group();
  elbow.position.set(0, -2.2, 0);
  arm.add(elbow);
  part(elbow, axle(0.46, 1.05), m.frame, 0, 0, 0);

  // Heavy forearm with top ridge
  const forearm = part(elbow, bevelBox(1.25, 2.0, 1.4, 0.2, 0.2), m.paint, 0, -1.05, 0.05);
  part(forearm, bevelBox(0.5, 1.7, 0.25, 0.08), m.paintDark, side * 0.62, 0, 0);
  part(forearm, bevelBox(0.9, 0.12, 1.42, 0.03), m.accent, 0, 0.55, 0);
  part(forearm, bevelBox(1.0, 0.3, 1.2, 0.08), m.frame, 0, -1.08, 0);

  // Hand: palm block with a knuckle row and thumb
  const fist = part(elbow, bevelBox(0.95, 0.85, 1.05, 0.14), m.frame, 0, -2.4, 0.05);
  part(fist, bevelBox(0.97, 0.32, 0.4, 0.08), m.dark, 0, -0.32, 0.38);
  part(fist, bevelBox(0.26, 0.5, 0.3, 0.08), m.dark, -side * 0.5, -0.05, 0.3);

  return { arm, elbow, shoulder, forearm, fist, pauldron };
}

/** XO-16 rotary cannon held in the right hand, barrels pointing +z. */
function buildCannon(m: TitanMaterials, mount: TitanWeaponMount): { cannon: THREE.Group; muzzles: THREE.Vector3[] } {
  const cannon = new THREE.Group();
  part(cannon, bevelBox(0.8, 1.0, 2.4, 0.15, 0.15), m.frame, 0, 0, 0.5);          // receiver
  part(cannon, bevelBox(0.82, 0.14, 1.6, 0.04), m.accent, 0, 0.35, 0.6);           // stripe

  // Main grip: a top handle when the weapon hangs below the hand, a pistol grip when it sits above
  const g = mount.mainGrip;
  if (mount.style === 'below') {
    for (const dz of [-0.45, 0.45]) part(cannon, bevelBox(0.22, 0.45, 0.22, 0.05), m.frame, 0, 0.62, g.z + dz); // posts
    part(cannon, bevelBox(0.26, 0.24, 1.2, 0.08), m.paintDark, 0, g.y - 0.08, g.z);                            // bar
  } else {
    part(cannon, bevelBox(0.34, 0.75, 0.42, 0.08), m.paintDark, 0, g.y + 0.12, g.z, 0.25);                     // pistol grip
    part(cannon, bevelBox(0.1, 0.1, 0.55, 0.03), m.frame, 0, -0.62, g.z + 0.3);                                 // trigger guard
  }

  // Side handle for the support hand: bracket off the left of the receiver and a vertical bar
  const sg = mount.supportGrip;
  part(cannon, bevelBox(Math.abs(sg.x) - 0.3, 0.22, 0.3, 0.05), m.frame, (sg.x - 0.4) / 2 + 0.05, sg.y, sg.z);
  part(cannon, bevelBox(0.24, 0.9, 0.26, 0.08), m.paintDark, sg.x, sg.y, sg.z);
  part(cannon, tube(0.5, 0.5, 0.35, 28), m.frame, 0, 0.0, 1.85);                    // front collar
  part(cannon, tube(0.46, 0.46, 1.1, 28, true), m.dark, 0, 0.0, 2.5);              // shroud
  const barrels = new THREE.Group();
  barrels.position.set(0, 0, 2.3);
  cannon.add(barrels);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    part(barrels, tube(0.07, 0.07, 2.0, 10), m.chrome, Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0.55);
  }
  part(barrels, tube(0.36, 0.36, 0.14, 24), m.frame, 0, 0, 1.45);                  // muzzle ring
  part(cannon, axle(0.55, 0.55, 28), m.paintDark, 0.7, -0.2, 0.2);                  // ammo drum
  part(cannon, axle(0.25, 0.6, 16), m.accent, 0.7, -0.2, 0.2);
  part(cannon, bevelBox(0.45, 0.35, 0.5, 0.08), m.frame, 0.35, mount.style === 'below' ? -0.55 : -0.3, 0.8); // feed chute
  return { cannon, muzzles: [new THREE.Vector3(0.12, 0, 3.9), new THREE.Vector3(-0.12, 0, 3.9)] };
}

function buildLeg(m: TitanMaterials, side: -1 | 1): TitanLegRig {
  const hip = new THREE.Group();
  part(hip, new THREE.SphereGeometry(0.75, 20, 14), m.frame, 0, 0, 0);

  // Thigh (pivots at the hip): painted core wrapped in front, rear and outer plates
  const thigh = new THREE.Mesh(bevelBox(1.2, TITAN_THIGH_LENGTH, 1.25, 0.16).translate(0, -TITAN_THIGH_LENGTH / 2, 0), m.paintDark);
  thigh.castShadow = true;
  hip.add(thigh);
  part(thigh, bevelBox(1.3, 1.8, 0.36, 0.12), m.paint, 0, -1.1, 0.7, -0.05);
  part(thigh, bevelBox(1.32, 0.14, 0.38, 0.04), m.accent, 0, -0.35, 0.72, -0.05);
  part(thigh, bevelBox(1.2, 1.6, 0.3, 0.1), m.paint, 0, -1.15, -0.7, 0.05);
  part(thigh, bevelBox(0.3, 1.6, 1.1, 0.08), m.paint, side * 0.7, -1.2, 0);

  // Shin (pivots at the knee)
  const shin = new THREE.Mesh(bevelBox(1.05, TITAN_SHIN_LENGTH, 1.1, 0.15).translate(0, -TITAN_SHIN_LENGTH / 2, -0.05), m.paintDark);
  shin.position.y = -TITAN_THIGH_LENGTH;
  shin.castShadow = true;
  thigh.add(shin);
  part(shin, axle(0.58, 1.35), m.frame, 0, 0, 0);                                    // knee joint
  part(shin, bevelBox(1.25, 1.05, 0.7, 0.22, 0.22), m.paint, 0, -0.05, 0.6);        // knee cap
  part(shin, bevelBox(1.2, 1.8, 0.36, 0.12), m.paint, 0, -1.25, 0.66, 0.04);        // shin guard
  part(shin, bevelBox(0.5, 0.1, 0.1, 0.03), m.glow, 0, -1.55, 0.86);
  for (const sx of [-1, 1]) part(shin, bevelBox(0.26, 1.5, 0.9, 0.08), sx === side ? m.paint : m.frame, sx * 0.6, -1.2, -0.1); // calf plates
  ram(shin, m, new THREE.Vector3(0, -0.35, -0.7), new THREE.Vector3(0, -2.0, -0.65), 0.1);

  // Foot (pivots at the ankle, counter-rotated by IK to stay flat)
  const foot = new THREE.Group();
  foot.position.y = -TITAN_SHIN_LENGTH;
  shin.add(foot);
  part(foot, new THREE.SphereGeometry(0.38, 16, 12), m.frame, 0, 0, 0);
  part(foot, bevelBox(1.35, 0.5, 2.3, 0.12), m.frame, 0, -0.1, 0.4);                // sole
  part(foot, bevelBox(1.2, 0.35, 1.3, 0.12), m.paint, 0, 0.12, 0.55, 0.08);         // instep armour
  for (const tx of [-0.36, 0.36]) part(foot, bevelBox(0.58, 0.38, 0.85, 0.1), m.paintDark, tx, -0.13, 1.72, 0.12); // toes
  part(foot, bevelBox(0.75, 0.42, 0.7, 0.1), m.paintDark, 0, -0.12, -0.9);          // heel spur

  return { hip, thigh, shin, foot };
}

/**
 * Build the Titan under `body` (the group that crouches). Legs attach to `body`
 * at hip height, the torso sits at `torsoHeight`.
 */
export function buildTitanModel(body: THREE.Group, torsoHeight: number, mount: TitanWeaponMount = XO16_MOUNTS[XO16_GRIP_STYLE]): TitanRig {
  const m = makeMaterials();

  // Pelvis, waist and hip armour
  part(body, bevelBox(2.4, 1.0, 1.6, 0.16, 0.16), m.frame, 0, TITAN_HIP_HEIGHT + 0.2, -0.05);
  part(body, bevelBox(1.1, 0.95, 0.35, 0.1), m.paint, 0, TITAN_HIP_HEIGHT + 0.05, 0.8, -0.12); // codpiece
  for (const sx of [-1, 1]) part(body, bevelBox(0.28, 1.2, 1.35, 0.08), m.paint, sx * 1.42, TITAN_HIP_HEIGHT + 0.1, 0, 0, 0, sx * 0.08);
  part(body, new THREE.CylinderGeometry(0.62, 0.72, 1.4, 20), m.frame, 0, TITAN_HIP_HEIGHT + 1.2, -0.1);
  part(body, bevelBox(0.5, 1.6, 0.5, 0.1), m.dark, 0, TITAN_HIP_HEIGHT + 1.25, -0.75); // spine

  const { torso, visor } = buildTorso(m);
  torso.position.y = torsoHeight;
  body.add(torso);

  const left = buildArm(m, -1);
  const right = buildArm(m, 1);
  left.arm.position.set(-TITAN_SHOULDER.x, TITAN_SHOULDER.y, TITAN_SHOULDER.z);
  right.arm.position.copy(TITAN_SHOULDER);
  torso.add(left.arm, right.arm);
  // Pauldrons belong to the chassis, so they don't swing with the IK-driven arms
  for (const a of [left, right]) {
    a.pauldron.position.add(a.arm.position);
    torso.add(a.pauldron);
  }

  // Weapon held in front of the torso; the arms reach for its grips (see poseTitanArms)
  const { cannon, muzzles } = buildCannon(m, mount);
  torso.add(cannon);

  const leftLeg = buildLeg(m, -1);
  const rightLeg = buildLeg(m, 1);
  leftLeg.hip.position.set(-1.25, TITAN_HIP_HEIGHT, -0.05);
  rightLeg.hip.position.set(1.25, TITAN_HIP_HEIGHT, -0.05);
  body.add(leftLeg.hip, rightLeg.hip);


  const rig: TitanRig = {
    torso,
    visor,
    leftArm: left.arm,
    rightArm: right.arm,
    leftElbow: left.elbow,
    rightElbow: right.elbow,
    leftShoulder: left.shoulder,
    rightShoulder: right.shoulder,
    leftForearm: left.forearm,
    rightForearm: right.forearm,
    leftFist: left.fist,
    rightFist: right.fist,
    leftLeg,
    rightLeg,
    weapon: cannon,
    weaponMount: mount,
    muzzleOffsets: muzzles,
  };
  poseTitanLegs(rig, 0);
  poseTitanArms(rig, 0);
  return rig;
}

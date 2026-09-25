import * as THREE from 'three';
import { soundManager } from './sound';
import type { BossStatus } from './types';
import { segmentIntersectsSphere, splashDamage } from './collision';
import { bevelBox, mergeAndDispose } from './geometryUtils';
import { FRAG_EXPLOSION_CONFIG, TITAN_IMPACT_CONFIG } from './effects';
import { flashLight } from './graphics';
import { Hostile, HostileContext, HostileHit, tryMoveHorizontal, turnTowards, yawTowards } from './hostile';
import {
  ColossusAttack, ColossusHitZone, ColossusPose, NEUTRAL_POSE, PoseKey, chooseColossusAttack,
  colossusDamageMultiplier, legIK, pose, samplePose,
} from './colossusLogic';

/*
 * The Colossus: an ~18 m war machine fought as a boss, souls-style.
 *
 * Every attack is telegraphed by a readable wind-up (and ground markers for
 * the ranged ones), has a short active window, and leaves a recovery window
 * to punish. Its armour shrugs off most fire; the glowing reactor on its
 * back, the knee actuators and the head are weak points, and hits on them
 * build stagger. Fill the stagger bar and it drops to one knee, exposed.
 * At half health it roars into phase two: faster, with a sweeping chest
 * beam and a leap slam.
 *
 * Pilots dodge by moving and jumping (shockwaves only hit grounded targets);
 * a titan's dash gives invulnerability frames against melee and shockwaves.
 */

export enum ColossusState {
  DORMANT,
  WAKING,
  IDLE,
  APPROACH,
  ATTACK,
  STAGGERED,
  ROAR,
  DYING,
  DEAD,
}


const NAME = 'COLOSSUS // THE IRON SOVEREIGN';
const MAX_HEALTH = 12000;
const STAGGER_MAX = 900;
const STAGGER_DECAY = 30;
const STAGGER_DECAY_DELAY = 2.5;
const STAGGER_TIME = 5.5;
const WAKE_RANGE = 34;

// Skeleton (metres)
const HIP_HEIGHT = 7.4;
const HIP_SPREAD = 2.0;
const THIGH = 4.0;
const SHIN = 3.8;
const ANKLE_HEIGHT = 0.8;
const WAIST = 1.2;
const SHOULDER_X = 4.0;
const SHOULDER_Y = 4.6;
const UPPER_ARM = 5.0;
const FOREARM = 4.6;

const WALK_SPEED = 2.4;
const STRIDE = 3.2;
const BODY_RADIUS = 3.2;

// Attack tuning (damage vs pilot; titans take 80%)
const SWEEP_DAMAGE = 45;
const SLAM_DAMAGE = 60;
const SLAM_RADIUS = 4.5;
const STOMP_DAMAGE = 40;
const STOMP_RADIUS = 7.5;
const LEAP_DAMAGE = 45;
const LEAP_RADIUS = 6.5;
const SHOCKWAVE_DAMAGE = 25;
const SHOCKWAVE_SPEED = 16;
const SHOCKWAVE_WIDTH = 1.3;
const MORTAR_DAMAGE = 30;
const MORTAR_RADIUS = 3.5;
const MORTAR_FLIGHT = 1.8;
const MORTAR_COUNT = 8;
const BEAM_DPS = 110;
const BEAM_CONTACT_DAMAGE = 12;

/* Shared geometry for effects (unit sizes, scaled per use) */
const ringGeo = new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2);
const waveGeo = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true).translate(0, 0.5, 0);
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
const shellGeo = new THREE.CapsuleGeometry(0.22, 0.7, 4, 8);

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  center: THREE.Vector3;
  radius: number;
  maxRadius: number;
  damage: number;
  hit: boolean;
  active: boolean;
}

interface Marker {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  active: boolean;
  time: number;
  duration: number;
}

interface Shell {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  delay: number;
  marker: Marker;
  active: boolean;
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
  side: number;
  kneeAnchor: THREE.Object3D;
}

interface Arm {
  shoulderZ: THREE.Group;
  shoulderX: THREE.Group;
  elbow: THREE.Group;
  fist: THREE.Object3D;
  side: number;
}

/** Hit/collision sphere following a bone. */
interface BodySphere {
  anchor: THREE.Object3D;
  radius: number;
  zone: ColossusHitZone;
  collide: boolean;
  world: THREE.Vector3;
}

export class Colossus implements Hostile {
  readonly kind = 'colossus' as const;
  readonly scoreValue = 5000;
  readonly group: THREE.Group;
  health = MAX_HEALTH;
  state = ColossusState.DORMANT;
  phase: 1 | 2 = 1;

  private readonly scene: THREE.Scene;
  private readonly arenaCenter: THREE.Vector3;
  private readonly pelvis: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly head: THREE.Group;
  private readonly legs: Leg[] = [];
  private readonly arms: Arm[] = [];
  private readonly spheres: BodySphere[] = [];
  private readonly coreAnchor: THREE.Object3D;
  private readonly emitterAnchor: THREE.Object3D;
  private readonly podAnchors: THREE.Object3D[] = [];
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly kneeMat: THREE.MeshBasicMaterial;
  private readonly emitterMat: THREE.MeshBasicMaterial;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly beam: THREE.Mesh;
  private readonly shellMat: THREE.MeshBasicMaterial;
  private readonly shockwaves: Shockwave[] = [];
  private readonly markers: Marker[] = [];
  private readonly shells: Shell[] = [];

  private readonly current: ColossusPose = { ...NEUTRAL_POSE };
  private readonly target: ColossusPose = { ...NEUTRAL_POSE };
  private stateTimer = 0;
  private time = 0;
  private gait = 0;
  private walking = 0;
  private lastLift = [0, 0];
  private gap = 1.2;
  private attack: ColossusAttack | null = null;
  private lastAttack: ColossusAttack | null = null;
  private attackKeys: PoseKey[] = [];
  private attackTime = 0;
  private attackEnd = 0;
  private events = new Set<string>();
  private hitThisAttack = false;
  private speed = 1;
  private stagger = 0;
  private staggerCooldown = 0;
  private flash = 0;
  private lockPoint = new THREE.Vector3();
  private leapFrom = new THREE.Vector3();
  private leapMarker: Marker | null = null;
  private beamFrom = 0;
  private beamTo = 0;
  private beamYaw = 0;
  private beamReach = 24;
  private sweepPrev = 0;
  private sweepSide = 1;
  private approachTime = 0;
  private deathBlasts = 0;
  private detour = 1;

  constructor(scene: THREE.Scene, position: THREE.Vector3, facing = 0) {
    this.scene = scene;
    this.arenaCenter = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.rotation.y = facing;

    this.pelvis = new THREE.Group();
    this.group.add(this.pelvis);
    this.torso = new THREE.Group();
    this.torso.position.y = WAIST;
    this.pelvis.add(this.torso);
    this.head = new THREE.Group();
    this.head.position.set(0, 6.3, 0.5);
    this.torso.add(this.head);

    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a1a).multiplyScalar(3) });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3a14).multiplyScalar(4) });
    this.kneeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa02a).multiplyScalar(2.5) });
    this.emitterMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a1a).multiplyScalar(1.5) });
    this.coreAnchor = new THREE.Object3D();
    this.emitterAnchor = new THREE.Object3D();
    this.buildModel();

    const additive = (hex: number, k: number) => new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex).multiplyScalar(k),
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.beamMat = additive(0xff4a1a, 6);
    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.beam.userData.ignoreRaycast = true;
    scene.add(this.beam);
    this.shellMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8a3a).multiplyScalar(5) });

    for (let i = 0; i < 4; i++) {
      const mat = additive(0xff8a3a, 3);
      const mesh = new THREE.Mesh(waveGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.userData.ignoreRaycast = true;
      scene.add(mesh);
      this.shockwaves.push({ mesh, mat, center: new THREE.Vector3(), radius: 0, maxRadius: 0, damage: 0, hit: false, active: false });
    }
    for (let i = 0; i < MORTAR_COUNT + 2; i++) {
      const mat = additive(0xff2a14, 3);
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.userData.ignoreRaycast = true;
      scene.add(mesh);
      this.markers.push({ mesh, mat, active: false, time: 0, duration: 1 });
    }
    for (let i = 0; i < MORTAR_COUNT; i++) {
      const mesh = new THREE.Mesh(shellGeo, this.shellMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.userData.ignoreRaycast = true;
      scene.add(mesh);
      this.shells.push({ mesh, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, delay: 0, marker: this.markers[i], active: false });
    }

    // Dormant: kneeling, head bowed, lights dim
    Object.assign(this.current, this.kneelPose());
    this.applyPose(this.current);
    this.setGlow(0.25);
    scene.add(this.group);
  }

  /* ------------------------------ Model ------------------------------- */

  private buildModel(): void {
    const frame = new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.75, roughness: 0.38 });
    const ivory = new THREE.MeshStandardMaterial({ color: 0xcfc6b2, metalness: 0.3, roughness: 0.42 });
    const crimson = new THREE.MeshStandardMaterial({ color: 0x8a1f1c, metalness: 0.35, roughness: 0.45 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xb8913a, metalness: 0.9, roughness: 0.28 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x121418, metalness: 0.6, roughness: 0.55 });

    type Parts = Map<THREE.Material, THREE.BufferGeometry[]>;
    const parts: Parts = new Map();
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      geo.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        new THREE.Vector3(1, 1, 1),
      ));
      const list = parts.get(mat) ?? [];
      list.push(geo);
      parts.set(mat, list);
    };
    const flush = (parent: THREE.Object3D) => {
      for (const [mat, geos] of parts) {
        const merged = mergeAndDispose(geos);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      parts.clear();
    };
    const glow = (parent: THREE.Object3D, mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const sphere = (anchorParent: THREE.Object3D, x: number, y: number, z: number, radius: number, zone: ColossusHitZone = 'armor', collide = false) => {
      const a = new THREE.Object3D();
      a.position.set(x, y, z);
      anchorParent.add(a);
      this.spheres.push({ anchor: a, radius, zone, collide, world: new THREE.Vector3() });
      return a;
    };

    // --- Pelvis: hip block, waist drum and a skirt of armour plates ---
    add(frame, bevelBox(4.6, 1.8, 3.0, 0.2));
    add(frame, new THREE.CylinderGeometry(1.3, 1.5, 1.4, 16), 0, 0.8, 0);
    add(gold, new THREE.TorusGeometry(1.45, 0.12, 8, 24), 0, 0.4, 0, Math.PI / 2);
    add(ivory, bevelBox(3.0, 2.6, 0.4, 0.12), 0, -1.3, 1.6, -0.22);                 // front tasset
    add(crimson, bevelBox(1.0, 2.2, 0.42, 0.1), 0, -1.3, 1.64, -0.22);
    add(ivory, bevelBox(3.2, 2.4, 0.4, 0.12), 0, -1.2, -1.6, 0.25);                 // back tasset
    for (const sx of [-1, 1]) {
      add(ivory, bevelBox(0.4, 2.6, 2.8, 0.12), sx * 2.55, -1.2, 0, 0, 0, sx * -0.22);  // side tassets
      add(gold, bevelBox(0.44, 0.2, 2.9, 0.06), sx * 2.62, -0.05, 0, 0, 0, sx * -0.22);
    }
    flush(this.pelvis);
    sphere(this.pelvis, 0, 0, 0, 2.6, 'armor', true);

    // --- Torso: armoured chest, ivory breastplates, back reactor, chest emitter ---
    add(frame, bevelBox(3.6, 2.2, 2.8, 0.2), 0, 1.0, 0);                             // abdomen
    add(frame, bevelBox(6.0, 4.4, 3.8, 0.3), 0, 3.4, 0);                             // chest
    for (const sx of [-1, 1]) {
      add(ivory, bevelBox(2.7, 2.4, 0.7, 0.2), sx * 1.45, 3.9, 1.95, -0.12, sx * 0.18);   // breastplates
      add(crimson, bevelBox(2.0, 0.3, 0.72, 0.08), sx * 1.5, 2.65, 1.9, -0.12, sx * 0.18);
      add(ivory, bevelBox(1.2, 1.4, 3.0, 0.15), sx * 2.9, 3.0, 0, 0, 0, sx * 0.1);        // flank plates
      add(dark, new THREE.CylinderGeometry(0.45, 0.55, 2.6, 12), sx * 1.7, 6.0, -1.9, -0.35);  // exhaust stacks
      add(gold, new THREE.TorusGeometry(0.5, 0.08, 6, 16), sx * 1.7, 7.2, -2.3, Math.PI / 2 - 0.35);
    }
    for (let i = 0; i < 3; i++) add(ivory, bevelBox(3.0 - i * 0.4, 0.5, 2.4, 0.12), 0, 0.5 + i * 0.55, 0.3, -0.1); // ab plates
    add(gold, bevelBox(4.4, 0.35, 3.0, 0.1), 0, 5.55, 0.2);                          // collar
    add(ivory, bevelBox(3.2, 1.0, 2.4, 0.2), 0, 5.8, 0.4, -0.2);                      // gorget
    // Back reactor housing (the core sits in the ring)
    add(frame, bevelBox(3.2, 3.2, 1.2, 0.2), 0, 3.5, -2.2);
    add(gold, new THREE.TorusGeometry(1.15, 0.18, 10, 32), 0, 3.5, -2.8);
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      add(dark, bevelBox(0.3, 0.9, 0.5, 0.06), Math.cos(a) * 1.3, 3.5 + Math.sin(a) * 1.3, -2.85, 0, 0, a);
    }
    // Chest emitter housing
    add(dark, new THREE.CylinderGeometry(0.75, 0.9, 0.5, 20), 0, 3.3, 2.05, Math.PI / 2);
    add(gold, new THREE.TorusGeometry(0.8, 0.1, 8, 24), 0, 3.3, 2.3);
    flush(this.torso);
    const core = glow(this.torso, this.coreMat, new THREE.SphereGeometry(1.0, 24, 16), 0, 3.5, -2.75);
    core.add(this.coreAnchor);
    const emitter = glow(this.torso, this.emitterMat, new THREE.SphereGeometry(0.55, 16, 12), 0, 3.3, 2.25);
    emitter.add(this.emitterAnchor);
    this.emitterAnchor.position.set(0, 0, 0.4);
    sphere(this.torso, 0, 1.2, 0, 2.3);
    sphere(this.torso, 0, 3.6, 0.4, 3.1);
    sphere(this.torso, 0, 3.5, -2.8, 1.5, 'core');

    // --- Head: crested helm, dark face plate with glowing eyes ---
    add(frame, new THREE.CylinderGeometry(0.7, 0.9, 1.2, 12), 0, -0.1, -0.2);          // neck
    add(ivory, bevelBox(2.0, 2.0, 2.3, 0.3), 0, 1.0, 0);                              // helm
    add(dark, bevelBox(1.6, 0.9, 0.4, 0.1), 0, 0.9, 1.1);                             // face plate
    add(ivory, bevelBox(1.5, 0.7, 0.9, 0.15), 0, 0.2, 0.9, 0.35);                     // jaw guard
    add(crimson, bevelBox(0.35, 1.2, 2.2, 0.1), 0, 2.05, -0.1);                        // crest fin
    for (const sx of [-1, 1]) {
      const horn = new THREE.ConeGeometry(0.28, 2.4, 8);
      add(gold, horn, sx * 0.95, 2.1, -0.4, -0.9, 0, sx * -0.5);                      // swept horns
      add(ivory, bevelBox(0.4, 1.4, 1.8, 0.1), sx * 1.05, 0.9, -0.1, 0, 0, sx * 0.1);  // cheek guards
    }
    flush(this.head);
    for (const sx of [-1, 1]) glow(this.head, this.eyeMat, new THREE.BoxGeometry(0.5, 0.14, 0.1), sx * 0.42, 1.05, 1.32).rotation.z = sx * -0.18;
    glow(this.head, this.eyeMat, new THREE.BoxGeometry(0.12, 0.35, 0.1), 0, 0.72, 1.32);
    sphere(this.head, 0, 1.0, 0.2, 1.7, 'head');

    // --- Arms: shoulder ball, pauldron (with mortar pod), upper arm, forearm gauntlet, fist ---
    for (const side of [1, -1]) {
      const shoulderZ = new THREE.Group();
      shoulderZ.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
      this.torso.add(shoulderZ);
      const shoulderX = new THREE.Group();
      shoulderZ.add(shoulderX);

      // Pauldron rides the abduction but not the swing
      add(frame, new THREE.SphereGeometry(1.4, 16, 12));
      add(ivory, bevelBox(3.2, 1.3, 3.8, 0.3), side * 0.7, 1.2, 0, 0, 0, side * -0.28);
      add(ivory, bevelBox(2.8, 1.0, 3.4, 0.25), side * 1.25, 0.2, 0, 0, 0, side * -0.55);
      add(crimson, bevelBox(3.0, 0.3, 3.9, 0.1), side * 0.72, 1.9, 0, 0, 0, side * -0.28);
      add(gold, bevelBox(0.25, 1.0, 3.5, 0.08), side * 2.0, 0.85, 0, 0, 0, side * -0.28);
      // Mortar pod on top of the pauldron
      add(frame, bevelBox(1.7, 1.1, 2.0, 0.15), side * 0.3, 2.45, -0.5);
      for (let i = 0; i < 4; i++) {
        add(dark, new THREE.CylinderGeometry(0.22, 0.22, 0.3, 10), side * 0.3 + ((i % 2) - 0.5) * 0.7, 3.0, -0.5 + (Math.floor(i / 2) - 0.5) * 0.8);
      }
      flush(shoulderZ);
      const pod = new THREE.Object3D();
      pod.position.set(side * 0.3, 3.2, -0.5);
      shoulderZ.add(pod);
      this.podAnchors.push(pod);
      sphere(shoulderZ, side * 0.6, 0.8, 0, 2.0);

      // Upper arm
      add(frame, bevelBox(1.7, UPPER_ARM, 1.8, 0.2), 0, -UPPER_ARM / 2, 0);
      add(ivory, bevelBox(1.9, 2.4, 2.0, 0.2), 0, -1.6, 0.1);
      add(gold, bevelBox(2.0, 0.25, 2.1, 0.06), 0, -2.9, 0.1);
      flush(shoulderX);
      sphere(shoulderX, 0, -UPPER_ARM / 2, 0, 1.3);

      // Forearm + gauntlet
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER_ARM;
      shoulderX.add(elbow);
      add(frame, new THREE.SphereGeometry(1.0, 14, 10));
      add(frame, bevelBox(1.9, FOREARM, 2.1, 0.2), 0, -FOREARM / 2, 0);
      add(ivory, bevelBox(2.3, 3.2, 2.4, 0.3), 0, -2.6, 0.05);
      add(crimson, bevelBox(2.35, 0.4, 2.45, 0.1), 0, -1.1, 0.05);
      for (let i = 0; i < 3; i++) add(gold, new THREE.ConeGeometry(0.2, 0.9, 6), side * 1.2, -1.8 - i * 0.9, 0, 0, 0, side * -Math.PI / 2); // spikes
      // Fist
      add(frame, bevelBox(2.0, 1.9, 2.2, 0.25), 0, -FOREARM - 0.95, 0.1);
      add(ivory, bevelBox(2.1, 0.7, 2.3, 0.15), 0, -FOREARM - 0.5, 0.15);
      add(dark, bevelBox(1.8, 0.4, 0.6, 0.1), 0, -FOREARM - 1.8, 0.9);                 // knuckles
      flush(elbow);
      sphere(elbow, 0, -FOREARM / 2, 0, 1.3);
      const fist = sphere(elbow, 0, -FOREARM - 0.95, 0.1, 1.4);
      this.arms.push({ shoulderZ, shoulderX, elbow, fist, side });
    }

    // --- Legs: hip ball, thigh, knee cap with glowing actuator, shin greave, armoured foot ---
    for (const side of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.set(side * HIP_SPREAD, -0.3, 0);
      this.pelvis.add(hip);
      add(frame, new THREE.SphereGeometry(1.3, 14, 10));
      add(frame, bevelBox(2.1, THIGH, 2.3, 0.25), 0, -THIGH / 2, 0);
      add(ivory, bevelBox(2.3, 2.8, 1.2, 0.25), 0, -2.0, 0.8, 0.05);
      add(ivory, bevelBox(0.5, 3.0, 2.2, 0.15), side * 1.15, -2.0, 0, 0, 0, side * -0.06);
      flush(hip);
      sphere(hip, 0, -THIGH / 2, 0, 1.6, 'armor', true);

      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      hip.add(knee);
      add(frame, new THREE.SphereGeometry(1.05, 14, 10));
      add(ivory, bevelBox(1.9, 1.5, 1.0, 0.25), 0, 0.3, 1.15, -0.25);                 // knee cap
      add(frame, bevelBox(1.8, SHIN, 2.0, 0.2), 0, -SHIN / 2, 0);
      add(ivory, bevelBox(2.1, 3.0, 0.8, 0.25), 0, -2.1, 0.95, 0.06);                  // greave
      add(crimson, bevelBox(0.5, 2.4, 0.82, 0.1), 0, -2.1, 1.02, 0.06);
      add(dark, new THREE.CylinderGeometry(0.2, 0.2, 3.2, 8), side * 0.95, -1.8, -0.6);  // piston
      flush(knee);
      glow(knee, this.kneeMat, new THREE.SphereGeometry(0.5, 16, 12), 0, -0.45, 1.25);
      const kneeAnchor = sphere(knee, 0, -0.45, 1.3, 1.1, 'knee');
      sphere(knee, 0, -SHIN / 2, 0, 1.35, 'armor', true);

      const ankle = new THREE.Group();
      ankle.position.y = -SHIN;
      knee.add(ankle);
      add(frame, new THREE.SphereGeometry(0.8, 12, 8));
      add(frame, bevelBox(2.3, 1.0, 3.8, 0.25), 0, -0.3, 0.5);
      add(ivory, bevelBox(2.2, 0.7, 1.8, 0.2), 0, 0.05, 1.5, -0.25);                   // toe cap
      add(gold, bevelBox(2.35, 0.2, 3.9, 0.06), 0, -0.7, 0.5);
      add(dark, new THREE.ConeGeometry(0.35, 1.2, 6), 0, -0.2, -1.8, -Math.PI / 2);    // heel spur
      flush(ankle);
      sphere(ankle, 0, -0.2, 0.5, 1.5, 'armor', true);
      this.legs.push({ hip, knee, ankle, side, kneeAnchor });
    }
  }

  /* ---------------------------- Hostile API ---------------------------- */

  isDead(): boolean { return this.health <= 0; }
  isFinished(): boolean { return this.state === ColossusState.DEAD && this.stateTimer > 20; }
  get awake(): boolean { return this.state !== ColossusState.DORMANT; }

  status(): BossStatus {
    return {
      name: NAME,
      health: this.health,
      maxHealth: MAX_HEALTH,
      stagger: this.stagger,
      staggerMax: STAGGER_MAX,
      phase: this.phase,
      awake: this.awake,
      staggered: this.state === ColossusState.STAGGERED,
    };
  }

  /** Spheres the game turns into physics colliders (legs, feet, pelvis) so pilots can't walk through it. */
  colliders(): { center: THREE.Vector3; radius: number }[] {
    if (this.state === ColossusState.DYING || this.state === ColossusState.DEAD) return [];
    return this.spheres.filter((s) => s.collide).map((s) => ({ center: s.world, radius: s.radius * 0.9 }));
  }

  checkBulletHit(p: THREE.Vector3): boolean {
    if (this.isDead()) return false;
    // Quick reject against the whole body
    const g = this.group.position;
    const dx = p.x - g.x;
    const dz = p.z - g.z;
    if (dx * dx + dz * dz > 14 * 14 || p.y < g.y - 1 || p.y > g.y + 20) return false;
    for (const s of this.spheres) if (p.distanceToSquared(s.world) < s.radius * s.radius) return true;
    return false;
  }

  takeDamage(amount: number, hitPoint?: THREE.Vector3): void {
    if (this.isDead()) return;
    if (this.state === ColossusState.DORMANT) this.wake();

    // Which part was hit: nearest weak point sphere containing the hit wins
    let zone: ColossusHitZone = 'armor';
    if (hitPoint) {
      for (const s of this.spheres) {
        if (s.zone === 'armor') continue;
        if (hitPoint.distanceTo(s.world) < s.radius + 0.3) { zone = s.zone; break; }
      }
    }
    const staggered = this.state === ColossusState.STAGGERED;
    let dmg = amount * colossusDamageMultiplier(zone, staggered);
    if (this.state === ColossusState.ROAR || this.state === ColossusState.WAKING) dmg *= 0.1;
    this.health = Math.max(0, this.health - dmg);
    if (zone !== 'armor') this.flash = 0.12;

    // Stagger builds from weak-point hits (and a little from anything), faster while it's recovering from an attack
    if (!staggered) {
      const punish = this.state === ColossusState.ATTACK && this.attackTime > this.attackEnd * 0.6 ? 1.5 : 1;
      const build = zone === 'core' ? 0.9 : zone === 'armor' ? 0.06 : 0.45;
      this.stagger += amount * build * punish;
      this.staggerCooldown = STAGGER_DECAY_DELAY;
    }

    if (this.health <= 0) {
      this.enterDying();
    } else if (this.phase === 1 && this.health < MAX_HEALTH * 0.5 && this.state !== ColossusState.STAGGERED) {
      this.phase = 2;
      this.startRoar();
    } else if (this.stagger >= STAGGER_MAX && !staggered && this.state !== ColossusState.ROAR) {
      this.enterStagger();
    }
  }

  update(ctx: HostileContext): HostileHit[] {
    const dt = ctx.delta;
    this.time += dt;
    this.stateTimer += dt;
    const hits: HostileHit[] = [];
    this.group.updateMatrixWorld(true);
    for (const s of this.spheres) s.anchor.getWorldPosition(s.world);

    this.updateShockwaves(ctx, hits);
    this.updateShells(ctx, hits);
    this.updateMarkers(dt);

    if (this.staggerCooldown > 0) this.staggerCooldown -= dt;
    else if (this.state !== ColossusState.STAGGERED) this.stagger = Math.max(0, this.stagger - STAGGER_DECAY * dt);

    const pos = this.group.position;
    const flat = ctx.target.clone().setY(pos.y);
    const dist = pos.distanceTo(flat);
    const bearing = this.bearingTo(ctx.target);
    this.walking = 0;

    switch (this.state) {
      case ColossusState.DORMANT:
        if (dist < WAKE_RANGE) this.wake();
        break;

      case ColossusState.WAKING: {
        // Rise from the kneel, then a roar that shakes the arena
        const keys: PoseKey[] = [
          [0, this.kneelPose()],
          [1.6, pose({ crouch: 1.0, lean: -0.1, headX: -0.3 })],
          [2.2, this.roarPose()],
          [3.4, this.roarPose()],
          [4.0, NEUTRAL_POSE],
        ];
        samplePose(keys, this.stateTimer, this.target);
        this.setGlow(Math.min(1, this.stateTimer / 1.6));
        if (this.once('wake-roar', this.stateTimer > 2.2)) {
          soundManager.playSound('roar', 0.9);
          ctx.shake(0.8);
        }
        if (this.stateTimer > 4.0) this.enterIdle(1.0);
        break;
      }

      case ColossusState.IDLE:
        this.turnToward(ctx.target, dt, 1);
        this.gap -= dt;
        Object.assign(this.target, NEUTRAL_POSE);
        if (this.gap <= 0) {
          const next = chooseColossusAttack(dist, bearing, this.phase, this.lastAttack);
          if (next && this.readyFor(next, bearing)) this.startAttack(next, ctx);
          else if (!next) { this.state = ColossusState.APPROACH; this.stateTimer = 0; this.approachTime = 2 + Math.random() * 1.5; }
        }
        break;

      case ColossusState.APPROACH:
        this.turnToward(ctx.target, dt, 1);
        Object.assign(this.target, NEUTRAL_POSE);
        if (dist > 7 && Math.abs(bearing) < 1.0) this.walk(ctx, WALK_SPEED * (this.phase === 2 ? 1.3 : 1));
        if (this.stateTimer > this.approachTime || dist < 10) this.enterIdle(0.2);
        break;

      case ColossusState.ATTACK:
        this.attackTime += dt * this.speed;
        samplePose(this.attackKeys, this.attackTime, this.target);
        this.updateAttack(ctx, hits, dist);
        if (this.attackTime >= this.attackEnd) {
          this.beam.visible = false;
          this.emitterMat.color.set(0xff6a1a).multiplyScalar(1.5);
          // Phase-two combo: a backhand follows the sweep
          if (this.attack === 'sweep' && this.phase === 2 && this.sweepSide === 1 && dist < 13) {
            this.startAttack('sweep', ctx, -1);
          } else {
            this.enterIdle(this.phase === 2 ? 0.3 + Math.random() * 0.5 : 0.7 + Math.random() * 0.8);
          }
        }
        break;

      case ColossusState.STAGGERED: {
        const keys: PoseKey[] = [
          [0, this.current],
          [0.5, this.kneelPose()],
          [STAGGER_TIME - 0.8, this.kneelPose()],
          [STAGGER_TIME, NEUTRAL_POSE],
        ];
        samplePose(keys, this.stateTimer, this.target);
        this.coreMat.color.set(0xffc060).multiplyScalar(5 + Math.sin(this.time * 10) * 2);
        if (this.once('stagger-thud', this.stateTimer > 0.5)) {
          this.shockwave(pos.clone(), 12, 0);
          soundManager.playSound('thud', 0.9);
          ctx.shake(0.6);
        }
        if (this.stateTimer >= STAGGER_TIME) {
          this.stagger = 0;
          this.setGlow(1);
          // Dropped below half health while down: rise straight into the phase-two roar
          if (this.phase === 1 && this.health < MAX_HEALTH * 0.5) {
            this.phase = 2;
            this.startRoar();
          } else {
            this.enterIdle(0.4);
          }
        }
        break;
      }

      case ColossusState.ROAR: {
        const keys: PoseKey[] = [[0, this.current], [0.6, this.roarPose()], [2.4, this.roarPose()], [3.0, NEUTRAL_POSE]];
        samplePose(keys, this.stateTimer, this.target);
        if (this.once('phase-roar', this.stateTimer > 0.6)) {
          soundManager.playSound('roar', 1);
          ctx.shake(1);
          this.shockwave(pos.clone(), 34, 20);
          this.eyeMat.color.set(0xb04aff).multiplyScalar(5);
          flashLight(this.coreAnchor.getWorldPosition(new THREE.Vector3()), 0xb04aff, 80, 30, 0.6);
        }
        if (this.stateTimer >= 3.0) {
          this.speed = 1.25;
          this.enterIdle(0.3);
        }
        break;
      }

      case ColossusState.DYING:
        this.updateDying(ctx);
        break;

      case ColossusState.DEAD:
        if (this.stateTimer > 12) this.group.position.y -= dt * 0.4;
        break;
    }

    this.animate(ctx, dt, dist);
    return hits;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.remove(this.beam);
    for (const w of this.shockwaves) { this.scene.remove(w.mesh); w.mat.dispose(); }
    for (const m of this.markers) { this.scene.remove(m.mesh); m.mat.dispose(); }
    for (const s of this.shells) this.scene.remove(s.mesh);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.beamMat.dispose();
    this.shellMat.dispose();
  }

  /* ------------------------------ Brain ------------------------------- */

  private wake(): void {
    if (this.state !== ColossusState.DORMANT) return;
    this.state = ColossusState.WAKING;
    this.stateTimer = 0;
  }

  private enterIdle(gap: number): void {
    this.state = ColossusState.IDLE;
    this.stateTimer = 0;
    this.gap = gap;
    this.attack = null;
  }

  private enterStagger(): void {
    this.state = ColossusState.STAGGERED;
    this.stateTimer = 0;
    this.beam.visible = false;
    this.events.clear();
    soundManager.playSound('overload', 0.6);
  }

  private startRoar(): void {
    this.state = ColossusState.ROAR;
    this.stateTimer = 0;
    this.beam.visible = false;
    this.stagger = 0;
    this.events.clear();
  }

  /** Front-facing attacks turn to face the target first. */
  private readyFor(attack: ColossusAttack, bearing: number): boolean {
    if (attack === 'stomp' || attack === 'mortar' || attack === 'leap') return true;
    return Math.abs(bearing) < 0.45;
  }

  private bearingTo(point: THREE.Vector3): number {
    const yaw = yawTowards(this.group.position, point);
    return Math.atan2(Math.sin(yaw - this.group.rotation.y), Math.cos(yaw - this.group.rotation.y));
  }

  private turnToward(point: THREE.Vector3, dt: number, scale: number): void {
    const rate = (this.phase === 2 ? 0.95 : 0.65) * scale;
    const before = this.group.rotation.y;
    this.group.rotation.y = turnTowards(before, yawTowards(this.group.position, point), rate * dt);
    // Shuffle the feet while turning on the spot
    if (Math.abs(this.group.rotation.y - before) > 1e-4) this.walking = Math.max(this.walking, 0.35);
  }

  private walk(ctx: HostileContext, speed: number): void {
    const dir = new THREE.Vector3(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
    const step = speed * ctx.delta;
    for (const angle of [0, 0.5, 1.0]) {
      const d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle * this.detour);
      if (tryMoveHorizontal(this.group, d.x * step, d.z * step, ctx.worldMeshes, BODY_RADIUS, [1, 4])) {
        this.walking = 1;
        return;
      }
    }
    this.detour *= -1;
  }

  /** Fire an event once per attack/state when `condition` first becomes true. */
  private once(name: string, condition: boolean): boolean {
    if (!condition || this.events.has(name)) return false;
    this.events.add(name);
    return true;
  }

  /* ------------------------------ Attacks ----------------------------- */

  private startAttack(attack: ColossusAttack, ctx: HostileContext, sweepSide = 1): void {
    this.state = ColossusState.ATTACK;
    this.stateTimer = 0;
    this.attack = attack;
    this.lastAttack = attack;
    this.attackTime = 0;
    this.events.clear();
    this.hitThisAttack = false;
    this.lockPoint.copy(ctx.target).setY(this.group.position.y);

    switch (attack) {
      case 'sweep': {
        this.sweepSide = sweepSide;
        const s = sweepSide; // 1 = right arm, sweeping right → left; -1 = left-arm backhand
        const wind = s === 1
          ? pose({ crouch: 2.0, lean: 0.5, twist: -0.75, rShX: -0.55, rShZ: -1.25, rEl: -0.25, lShX: -0.2, lEl: -0.9, headX: 0.3 })
          : pose({ crouch: 2.0, lean: 0.5, twist: 0.75, lShX: -0.55, lShZ: 1.25, lEl: -0.25, rShX: -0.2, rEl: -0.9, headX: 0.3 });
        const follow = s === 1
          ? pose({ crouch: 2.2, lean: 0.55, twist: 0.9, rShX: -0.7, rShZ: -0.35, rEl: -0.15, lShX: -0.2, lEl: -0.9, headX: 0.3 })
          : pose({ crouch: 2.2, lean: 0.55, twist: -0.9, lShX: -0.7, lShZ: 0.35, lEl: -0.15, rShX: -0.2, rEl: -0.9, headX: 0.3 });
        const windup = sweepSide === 1 ? 1.05 : 0.7;
        this.attackKeys = [[0, { ...this.current }], [windup, wind], [windup + 0.35, follow], [windup + 1.5, NEUTRAL_POSE]];
        this.attackEnd = windup + 1.5;
        this.sweepPrev = -1.4 * s;
        break;
      }
      case 'slam': {
        const raise = pose({ crouch: 0.2, lean: -0.35, headX: -0.25, lShX: -2.9, lShZ: 0.2, lEl: -0.45, rShX: -2.9, rShZ: -0.2, rEl: -0.45 });
        const impact = pose({ crouch: 2.8, lean: 0.7, headX: 0.35, lShX: -1.15, lShZ: 0.12, lEl: -0.12, rShX: -1.15, rShZ: -0.12, rEl: -0.12 });
        this.attackKeys = [[0, { ...this.current }], [1.3, raise], [1.55, impact], [3.4, impact], [4.1, NEUTRAL_POSE]];
        this.attackEnd = 4.1;
        break;
      }
      case 'stomp': {
        const lift = pose({ crouch: 0.4, lean: -0.1, twist: 0.2, rFootLift: 3.6, rFootZ: 1.6, lFootZ: -0.2, lShZ: 0.5, rShZ: -0.5 });
        const down = pose({ crouch: 1.7, lean: 0.25, rFootLift: 0, rFootZ: 1.8, lFootZ: -0.2, lShZ: 0.3, rShZ: -0.3 });
        this.attackKeys = [[0, { ...this.current }], [0.85, lift], [1.0, down], [2.0, NEUTRAL_POSE]];
        this.attackEnd = 2.0;
        break;
      }
      case 'mortar': {
        const brace = pose({ crouch: 0.8, lean: -0.15, headX: -0.3, lShZ: 0.45, rShZ: -0.45, lShX: -0.15, rShX: -0.15 });
        this.attackKeys = [[0, { ...this.current }], [0.8, brace], [1.8, brace], [2.5, NEUTRAL_POSE]];
        this.attackEnd = 2.5;
        this.launchMortars(ctx);
        break;
      }
      case 'beam': {
        const charge = pose({ crouch: 1.0, lean: 0.3, headX: 0.25, lShX: 0.3, lShZ: 0.75, lEl: -0.3, rShX: 0.3, rShZ: -0.75, rEl: -0.3 });
        this.attackKeys = [[0, { ...this.current }], [1.2, charge], [3.6, charge], [4.3, NEUTRAL_POSE]];
        this.attackEnd = 4.3;
        // Sweep across the target from one side to the other
        this.beamYaw = yawTowards(this.group.position, ctx.target);
        // Rake the ground just beyond the target so the beam is low where they stand
        this.beamReach = THREE.MathUtils.clamp(this.group.position.distanceTo(ctx.target.clone().setY(this.group.position.y)) + 2, 10, 36);
        const s = Math.random() < 0.5 ? 1 : -1;
        this.beamFrom = -0.75 * s;
        this.beamTo = 0.75 * s;
        soundManager.playSound('laser_charge', 0.6);
        break;
      }
      case 'leap': {
        const coil = pose({ crouch: 3.0, lean: 0.5, lShX: 0.5, rShX: 0.5, lEl: -0.3, rEl: -0.3, headX: 0.2 });
        const air = pose({ crouch: -0.3, lean: 0.05, lShX: -2.6, rShX: -2.6, lEl: -0.5, rEl: -0.5, lFootLift: 1.2, rFootLift: 1.2, lFootZ: -0.5, rFootZ: 0.8 });
        const land = pose({ crouch: 3.2, lean: 0.6, lShX: -1.0, rShX: -1.0, lEl: -0.2, rEl: -0.2, headX: 0.3 });
        this.attackKeys = [[0, { ...this.current }], [0.9, coil], [1.4, air], [2.0, land], [3.6, NEUTRAL_POSE]];
        this.attackEnd = 3.6;
        this.leapFrom.copy(this.group.position);
        this.leapMarker = this.showMarker(this.clampToArena(ctx.target.clone().setY(0)), LEAP_RADIUS, 2.0 / this.speed);
        break;
      }
    }
  }

  private updateAttack(ctx: HostileContext, hits: HostileHit[], dist: number): void {
    const t = this.attackTime;
    const pos = this.group.position;
    const dodging = ctx.targetDodging;
    const scale = (d: number) => (ctx.targetIsTitan ? d * 0.8 : d);

    switch (this.attack) {
      case 'sweep': {
        const windup = this.sweepSide === 1 ? 1.05 : 0.7;
        if (t < windup * 0.8) this.turnToward(ctx.target, ctx.delta, 0.8);
        if (this.once('whoosh', t > windup)) soundManager.playSound('slide', 0.8);
        if (t > windup && t < windup + 0.35 && !this.hitThisAttack) {
          // The arm sweeps an arc in front, low enough to catch anything on the ground
          const u = (t - windup) / 0.35;
          const a = THREE.MathUtils.lerp(-1.4, 1.4, u) * this.sweepSide;
          const bearing = this.bearingTo(ctx.target);
          const lo = Math.min(this.sweepPrev, a) - 0.25;
          const hi = Math.max(this.sweepPrev, a) + 0.25;
          const height = ctx.hitbox.center.y - pos.y - ctx.hitbox.radius;
          if (bearing >= lo && bearing <= hi && dist > 2 && dist < 13 + ctx.hitbox.radius && height < 4 && !dodging) {
            hits.push({ damage: scale(SWEEP_DAMAGE), source: pos.clone() });
            this.hitThisAttack = true;
            ctx.shake(0.5);
          }
          this.sweepPrev = a;
        }
        break;
      }

      case 'slam': {
        // Tracks the target while raising the arms, then commits
        if (t < 1.0) {
          this.turnToward(ctx.target, ctx.delta, 1.2);
          this.lockPoint.copy(ctx.target).setY(pos.y);
        }
        if (this.once('slam-impact', t >= 1.55)) {
          const a = this.arms[0].fist.getWorldPosition(new THREE.Vector3());
          const b = this.arms[1].fist.getWorldPosition(new THREE.Vector3());
          const center = a.add(b).multiplyScalar(0.5).setY(pos.y + 0.1);
          this.impact(ctx, hits, center, SLAM_RADIUS, scale(SLAM_DAMAGE), 1);
          this.shockwave(center, 30, scale(SHOCKWAVE_DAMAGE));
        }
        break;
      }

      case 'stomp':
        if (this.once('stomp-impact', t >= 1.0)) {
          const foot = this.legs[1].ankle.getWorldPosition(new THREE.Vector3()).setY(pos.y + 0.1);
          this.impact(ctx, hits, foot, STOMP_RADIUS, scale(STOMP_DAMAGE), 0.8);
          this.shockwave(foot, 16, scale(SHOCKWAVE_DAMAGE * 0.8));
        }
        break;

      case 'mortar':
        // Shells are launched and resolved in updateShells
        break;

      case 'beam': {
        const origin = this.emitterAnchor.getWorldPosition(new THREE.Vector3());
        if (t < 1.2) {
          // Charge: chest emitter brightens
          this.emitterMat.color.set(0xff6a1a).multiplyScalar(1.5 + (t / 1.2) * 10);
          this.turnToward(ctx.target, ctx.delta, 0.6);
          break;
        }
        if (t < 3.4) {
          const u = (t - 1.2) / 2.2;
          const yaw = this.beamYaw + THREE.MathUtils.lerp(this.beamFrom, this.beamTo, u);
          const ground = pos.clone().add(new THREE.Vector3(Math.sin(yaw) * this.beamReach, 0.05, Math.cos(yaw) * this.beamReach));
          // Walls stop the beam
          const dir = ground.clone().sub(origin);
          const len = dir.length();
          dir.divideScalar(len);
          const wall = new THREE.Raycaster(origin, dir, 0, len).intersectObjects(ctx.worldMeshes, false)[0];
          const end = wall ? wall.point : ground;
          this.placeBeam(origin, end, 0.45 + Math.sin(this.time * 50) * 0.08);
          this.beamMat.opacity = 0.9;
          this.emitterMat.color.set(0xffb060).multiplyScalar(12);
          if (Math.random() < ctx.delta * 30) ctx.effects.spawnImpact(end.clone(), dir.clone().negate(), TITAN_IMPACT_CONFIG);
          if (this.once('beam-fire', true)) {
            soundManager.playSound('laser_fire', 1);
            flashLight(origin, 0xff6a1a, 60, 30, 2.2);
          }
          if (!dodging && segmentIntersectsSphere(origin, end, ctx.hitbox.center, ctx.hitbox.radius + 0.6)) {
            // First contact burns, then it keeps cooking whoever stays in it
            const contact = this.hitThisAttack ? 0 : scale(BEAM_CONTACT_DAMAGE);
            this.hitThisAttack = true;
            hits.push({ damage: contact + scale(BEAM_DPS) * ctx.delta, source: origin });
            ctx.shake(0.15);
          }
        } else {
          this.beam.visible = false;
        }
        break;
      }

      case 'leap': {
        if (t < 0.9) {
          this.turnToward(ctx.target, ctx.delta, 1.5);
          // The landing marker follows the target until take-off
          if (this.leapMarker) {
            const p = this.clampToArena(ctx.target.clone().setY(0));
            this.leapMarker.mesh.position.set(p.x, 0.06, p.z);
            this.lockPoint.copy(p);
          }
        } else if (t < 2.0) {
          if (this.once('leap-off', true)) {
            soundManager.playSound('heavy_cannon', 0.8);
            this.leapFrom.copy(pos);
          }
          const u = THREE.MathUtils.clamp((t - 0.9) / 1.1, 0, 1);
          pos.x = THREE.MathUtils.lerp(this.leapFrom.x, this.lockPoint.x, u);
          pos.z = THREE.MathUtils.lerp(this.leapFrom.z, this.lockPoint.z, u);
          pos.y = this.leapFrom.y + Math.sin(u * Math.PI) * 11;
        }
        if (this.once('leap-land', t >= 2.0)) {
          pos.y = this.leapFrom.y;
          const center = pos.clone().setY(pos.y + 0.1);
          this.impact(ctx, hits, center, LEAP_RADIUS, scale(LEAP_DAMAGE), 1);
          this.shockwave(center, 32, scale(SHOCKWAVE_DAMAGE));
          if (this.leapMarker) this.leapMarker.time = this.leapMarker.duration;
        }
        break;
      }
    }
  }

  /** Ground impact: damage in a radius, dust, light, sound, shake. */
  private impact(ctx: HostileContext, hits: HostileHit[], center: THREE.Vector3, radius: number, damage: number, shake: number): void {
    ctx.effects.spawnExplosion(center.clone().setY(center.y + 0.5), FRAG_EXPLOSION_CONFIG);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.effects.spawnImpact(center.clone().add(new THREE.Vector3(Math.cos(a) * radius * 0.6, 0.2, Math.sin(a) * radius * 0.6)), new THREE.Vector3(0, 1, 0), TITAN_IMPACT_CONFIG);
    }
    flashLight(center, 0xff8a3a, 70, radius * 4, 0.35);
    soundManager.playSound('thud', 1);
    soundManager.playSound('explosion', 0.6);
    const toTarget = new THREE.Vector3(ctx.hitbox.center.x - center.x, 0, ctx.hitbox.center.z - center.z).length();
    const d = Math.max(0, Math.min(toTarget, center.distanceTo(ctx.hitbox.center)) - ctx.hitbox.radius);
    ctx.shake(shake * THREE.MathUtils.clamp(1 - toTarget / 45, 0.2, 1));
    if (!ctx.targetDodging && d < radius) hits.push({ damage: Math.max(damage * 0.4, splashDamage(damage, d, radius)), source: center.clone() });
  }

  /* --------------------------- Shockwaves ----------------------------- */

  private shockwave(center: THREE.Vector3, maxRadius: number, damage: number): void {
    const w = this.shockwaves.find((s) => !s.active) ?? this.shockwaves[0];
    w.active = true;
    w.center.copy(center);
    w.radius = 1;
    w.maxRadius = maxRadius;
    w.damage = damage;
    w.hit = false;
    w.mesh.visible = true;
  }

  private updateShockwaves(ctx: HostileContext, hits: HostileHit[]): void {
    for (const w of this.shockwaves) {
      if (!w.active) continue;
      const prev = w.radius;
      w.radius += SHOCKWAVE_SPEED * ctx.delta;
      const life = w.radius / w.maxRadius;
      w.mesh.position.copy(w.center);
      w.mesh.scale.set(w.radius, 1.1 * (1 - life * 0.6), w.radius);
      w.mat.opacity = 0.75 * (1 - life);
      // Hits grounded targets as the wave front passes them; jump it (pilot) or dash through it (titan)
      if (w.damage > 0 && !w.hit) {
        const d = Math.hypot(ctx.hitbox.center.x - w.center.x, ctx.hitbox.center.z - w.center.z);
        const reach = SHOCKWAVE_WIDTH + (ctx.targetIsTitan ? ctx.hitbox.radius * 0.5 : 0.4);
        if (d > prev - reach && d < w.radius + reach && ctx.targetGrounded && !ctx.targetDodging) {
          hits.push({ damage: w.damage, source: w.center.clone() });
          w.hit = true;
          ctx.shake(0.4);
        }
      }
      if (w.radius >= w.maxRadius) {
        w.active = false;
        w.mesh.visible = false;
      }
    }
  }

  /* ------------------------ Mortars and markers ----------------------- */

  private showMarker(at: THREE.Vector3, radius: number, duration: number): Marker {
    const m = this.markers.find((x) => !x.active && !this.shells.some((s) => s.active && s.marker === x)) ?? this.markers[this.markers.length - 1];
    m.active = true;
    m.time = 0;
    m.duration = duration;
    m.mesh.position.set(at.x, 0.06, at.z);
    m.mesh.scale.setScalar(radius);
    m.mesh.visible = true;
    return m;
  }

  private updateMarkers(dt: number): void {
    for (const m of this.markers) {
      if (!m.active) continue;
      m.time += dt;
      // Pulse faster as impact nears
      const u = m.time / m.duration;
      m.mat.opacity = 0.35 + 0.45 * Math.abs(Math.sin(m.time * (6 + u * 18)));
      if (m.time >= m.duration) {
        m.active = false;
        m.mesh.visible = false;
      }
    }
  }

  private launchMortars(ctx: HostileContext): void {
    const predicted = ctx.target.clone().addScaledVector(ctx.targetVelocity, MORTAR_FLIGHT * 0.8).setY(0);
    const spots: THREE.Vector3[] = [predicted, ctx.target.clone().setY(0)];
    while (spots.length < MORTAR_COUNT) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 7;
      const p = ctx.target.clone().setY(0).add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      if (spots.every((s) => s.distanceTo(p) > 3)) spots.push(p);
    }
    spots.forEach((spot, i) => {
      const shell = this.shells[i];
      const at = this.clampToArena(spot);
      shell.active = true;
      shell.t = 0;
      shell.delay = 0.8 + i * 0.1;
      shell.to.copy(at);
      shell.mesh.visible = false;
      shell.marker = this.showMarker(at, MORTAR_RADIUS, shell.delay + MORTAR_FLIGHT);
    });
  }

  private updateShells(ctx: HostileContext, hits: HostileHit[]): void {
    for (let i = 0; i < this.shells.length; i++) {
      const s = this.shells[i];
      if (!s.active) continue;
      if (s.delay > 0) {
        s.delay -= ctx.delta;
        if (s.delay <= 0) {
          // Launch from alternating shoulder pods
          this.podAnchors[i % 2].getWorldPosition(s.from);
          s.mesh.visible = true;
          soundManager.playSound('grenade_fire', 0.35);
          ctx.effects.spawnMuzzleFlash(s.from, new THREE.Vector3(0, 1, 0), { color: 0xffaa55, radius: 0.8, life: 0.1 });
        }
        continue;
      }
      s.t += ctx.delta / MORTAR_FLIGHT;
      const u = Math.min(1, s.t);
      const p = s.from.clone().lerp(s.to, u);
      p.y += Math.sin(u * Math.PI) * 22;
      const ahead = s.from.clone().lerp(s.to, Math.min(1, u + 0.02));
      ahead.y += Math.sin(Math.min(1, u + 0.02) * Math.PI) * 22;
      s.mesh.position.copy(p);
      s.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ahead.sub(p).normalize());
      if (u >= 1) {
        s.active = false;
        s.mesh.visible = false;
        ctx.effects.spawnExplosion(s.to.clone().setY(0.5), FRAG_EXPLOSION_CONFIG);
        flashLight(s.to, 0xff7733, 40, 12, 0.25);
        soundManager.playSound('explosion', 0.4);
        const d = Math.max(0, s.to.distanceTo(ctx.hitbox.center) - ctx.hitbox.radius);
        const dmg = splashDamage(ctx.targetIsTitan ? MORTAR_DAMAGE * 0.8 : MORTAR_DAMAGE, d, MORTAR_RADIUS);
        if (dmg > 0 && !ctx.targetDodging) hits.push({ damage: dmg, source: s.to.clone() });
        if (d < 10) ctx.shake(0.25);
      }
    }
  }

  private clampToArena(p: THREE.Vector3): THREE.Vector3 {
    const off = p.clone().sub(this.arenaCenter).setY(0);
    if (off.length() > 38) off.setLength(38);
    return this.arenaCenter.clone().add(off).setY(0);
  }

  private placeBeam(from: THREE.Vector3, to: THREE.Vector3, radius: number): void {
    const dir = to.clone().sub(from);
    const len = dir.length();
    this.beam.position.copy(from);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(Math.max(1e-6, len)));
    this.beam.scale.set(radius, len, radius);
    this.beam.visible = true;
  }

  /* ------------------------------ Death ------------------------------- */

  private enterDying(): void {
    this.state = ColossusState.DYING;
    this.stateTimer = 0;
    this.beam.visible = false;
    this.deathBlasts = 0;
    for (const w of this.shockwaves) { w.active = false; w.mesh.visible = false; }
    for (const s of this.shells) { s.active = false; s.mesh.visible = false; }
    for (const m of this.markers) { m.active = false; m.mesh.visible = false; }
    soundManager.playSound('overload', 1);
  }

  private updateDying(ctx: HostileContext): void {
    const t = this.stateTimer;
    // Knees buckle, then it topples forward
    const keys: PoseKey[] = [[0, this.current], [1.2, this.kneelPose()], [5, pose({ crouch: 3.0, lean: 0.9, headX: 0.8, lShX: -0.3, rShX: -0.3, lEl: -0.2, rEl: -0.2, lFootZ: -3.2, lFootLift: 0.4, rFootZ: -2.8, rFootLift: 0.3 })]];
    samplePose(keys, t, this.target);
    if (t > 2.4) this.group.rotation.x = Math.min(0.35, (t - 2.4) * 0.25);
    this.coreMat.color.set(0xffffff).multiplyScalar(4 + Math.sin(t * (10 + t * 8)) * 3);
    // Chain of explosions across the body, then the reactor goes
    while (this.deathBlasts < Math.floor(t / 0.35) && t < 4.2) {
      this.deathBlasts++;
      const s = this.spheres[Math.floor(Math.random() * this.spheres.length)];
      ctx.effects.spawnExplosion(s.world.clone(), FRAG_EXPLOSION_CONFIG);
      flashLight(s.world, 0xff7733, 50, 16, 0.25);
      soundManager.playSound('explosion', 0.5);
      ctx.shake(0.3);
    }
    if (this.once('death-blast', t > 4.4)) {
      const c = this.coreAnchor.getWorldPosition(new THREE.Vector3());
      for (let i = 0; i < 5; i++) ctx.effects.spawnExplosion(c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4)), FRAG_EXPLOSION_CONFIG);
      flashLight(c, 0xffc080, 120, 60, 0.8);
      soundManager.playSound('explosion', 1);
      soundManager.playSound('thud', 1);
      ctx.shake(1);
      this.setGlow(0);
      this.coreMat.color.setRGB(0.05, 0.03, 0.02);
    }
    if (t > 5.5) {
      this.state = ColossusState.DEAD;
      this.stateTimer = 0;
    }
  }

  /* ---------------------------- Animation ----------------------------- */

  private kneelPose(): ColossusPose {
    // Left knee on the ground (foot tucked back), right foot planted forward
    return pose({
      crouch: 1.9, lean: 0.6, headX: 0.55, twist: 0,
      lShX: -0.9, lShZ: 0.3, lEl: -0.4, rShX: -0.6, rShZ: -0.25, rEl: -0.9,
      lFootZ: -3.1, lFootLift: 1.3, rFootZ: 2.6, rFootLift: 0,
    });
  }

  private roarPose(): ColossusPose {
    return pose({ crouch: 0.9, lean: -0.3, headX: -0.55, lShX: -0.9, lShZ: 1.15, lEl: -0.5, rShX: -0.9, rShZ: -1.15, rEl: -0.5 });
  }

  private setGlow(k: number): void {
    const eye = this.phase === 2 ? 0xb04aff : 0xff3a14;
    this.eyeMat.color.set(eye).multiplyScalar(0.2 + k * 4);
    this.coreMat.color.set(0xff6a1a).multiplyScalar(0.3 + k * 2.7);
    this.kneeMat.color.set(0xffa02a).multiplyScalar(0.2 + k * 2.3);
  }

  private animate(ctx: HostileContext, dt: number, dist: number): void {
    // Ease the live pose towards the target pose (heavy, damped motion)
    const k = 1 - Math.exp(-dt * (this.state === ColossusState.ATTACK ? 22 : 6));
    for (const key of Object.keys(this.target) as (keyof ColossusPose)[]) {
      this.current[key] += (this.target[key] - this.current[key]) * k;
    }

    // Walk cycle overrides foot placement while moving
    const walk = this.walking;
    if (walk > 0) this.gait += dt * (WALK_SPEED / STRIDE) * Math.PI * 2 * 0.5 * (this.phase === 2 ? 1.3 : 1);
    this.walkBlend += ((walk > 0 ? 1 : 0) - this.walkBlend) * Math.min(1, dt * 4);
    this.applyPose(this.current);

    // Footfalls: shake the ground when a foot comes down near the target
    if (this.walkBlend > 0.3) {
      for (let i = 0; i < 2; i++) {
        const lift = Math.max(0, Math.cos(this.gait + i * Math.PI));
        if (this.lastLift[i] > 0.05 && lift <= 0.05 && dist < 40) {
          soundManager.playSound('thud', 0.5);
          ctx.shake(0.25 * (1 - dist / 40));
        }
        this.lastLift[i] = lift;
      }
    }

    // Head tracks the target
    if (this.awake && this.state !== ColossusState.DYING && this.state !== ColossusState.DEAD) {
      const look = THREE.MathUtils.clamp(this.bearingTo(ctx.target) - this.current.twist, -0.7, 0.7);
      this.head.rotation.y += (look - this.head.rotation.y) * Math.min(1, dt * 3);
    }

    // Weak-point hit flash
    if (this.flash > 0) {
      this.flash -= dt;
      this.kneeMat.color.set(0xffffff).multiplyScalar(6);
      if (this.flash <= 0) this.setGlow(this.state === ColossusState.DORMANT ? 0.25 : 1);
    }
    if (this.state !== ColossusState.STAGGERED && this.state !== ColossusState.DYING && this.state !== ColossusState.DEAD && this.awake && this.flash <= 0) {
      // Core pulses, faster as stagger builds
      const pulse = 2.4 + Math.sin(this.time * (2 + (this.stagger / STAGGER_MAX) * 8)) * 0.6;
      this.coreMat.color.set(this.phase === 2 ? 0xd060ff : 0xff6a1a).multiplyScalar(pulse);
    }
  }

  private walkBlend = 0;

  private applyPose(p: ColossusPose): void {
    this.pelvis.position.y = HIP_HEIGHT - p.crouch;
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.headX;

    for (const arm of this.arms) {
      const left = arm.side > 0;
      arm.shoulderZ.rotation.z = left ? p.lShZ : p.rShZ;
      arm.shoulderX.rotation.x = left ? p.lShX : p.rShX;
      arm.elbow.rotation.x = left ? p.lEl : p.rEl;
    }

    const w = this.walkBlend;
    for (const leg of this.legs) {
      const left = leg.side > 0;
      const phase = this.gait + (left ? 0 : Math.PI);
      const walkZ = Math.sin(phase) * STRIDE * 0.5;
      const walkLift = Math.max(0, Math.cos(phase)) * 1.3;
      const footZ = (left ? p.lFootZ : p.rFootZ) * (1 - w) + walkZ * w;
      const lift = (left ? p.lFootLift : p.rFootLift) * (1 - w) + walkLift * w;
      const dy = ANKLE_HEIGHT + lift - (HIP_HEIGHT - p.crouch - 0.3);
      const { hip, knee, ankle } = legIK(THIGH, SHIN, dy, footZ);
      leg.hip.rotation.x = hip;
      leg.knee.rotation.x = knee;
      leg.ankle.rotation.x = ankle;
    }
  }
}

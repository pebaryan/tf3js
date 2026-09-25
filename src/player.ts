import * as THREE from "three";
import * as CANNON from "cannon-es";
import { getBindings, getAimCurve, applyAimCurve } from "./keybindings";
import { Attachment, Weapon, WeaponManager, R201_WEAPON, MAX_WEAPON_SLOTS, WEAPON_MUZZLES, barrelAttachmentLength } from "./weapons";
import { BallisticsSystem, Bullet } from "./ballistics";
import { ImpactEffectsRenderer, PLAYER_IMPACT_CONFIG, DEFAULT_MUZZLE_CONFIG, EPG_EXPLOSION_CONFIG, FRAG_EXPLOSION_CONFIG } from "./effects";
import { MovementSystem, MovementInput } from "./movement";
import { AimingSystem } from "./aiming";
import { ReticleRenderer } from "./reticle";
import { RadarRenderer } from "./radar";
import { soundManager } from "./sound";
import { disposeObject3D, splashDamage } from "./collision";
import { bevelBox } from "./geometryUtils";
import type { Damageable, DebugHUDData, WeaponHUDData } from "./types";

interface KeyState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  fire: boolean;
  embark: boolean;
}

interface Grenade {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  fuseTime: number;
  bouncesLeft: number;
  trail: THREE.Line;
  trailPositions: THREE.Vector3[];
}

interface ViewmodelSightLayout {
  adsAnchor: THREE.Vector3;
}

const VIEWMODEL_SIGHT_LAYOUTS: Record<string, ViewmodelSightLayout> = {
  'R-201': {
    adsAnchor: new THREE.Vector3(0, 0.045, 0.02),
  },
  'EVA-8': {
    adsAnchor: new THREE.Vector3(0, 0.05, 0.05),
  },
  'Kraber': {
    adsAnchor: new THREE.Vector3(0, 0.04, -0.02),
  },
  'EPG-1': {
    adsAnchor: new THREE.Vector3(0, 0.038, 0.08),
  },
  'Alternator': {
    adsAnchor: new THREE.Vector3(0, 0.042, 0.04),
  },
  'CAR': {
    adsAnchor: new THREE.Vector3(0, 0.05, 0.03),
  },
  'Flatline': {
    adsAnchor: new THREE.Vector3(0, 0.046, 0.05),
  },
  'Mastiff': {
    adsAnchor: new THREE.Vector3(0, 0.05, 0.08),
  },
  'Wingman': {
    adsAnchor: new THREE.Vector3(0, 0.05, 0.01),
  },
  'L-STAR': {
    adsAnchor: new THREE.Vector3(0, 0.05, 0.05),
  },
  'XO-16': {
    adsAnchor: new THREE.Vector3(0, 0.065, 0.03),
  },
};

/* ------------------------------------------------------------------ */
/*  Weapon Mesh Construction                                         */
/* ------------------------------------------------------------------ */

export function createWeaponMesh(weapon: Weapon, forPickup: boolean = false): THREE.Group {
  const gun = new THREE.Group();
  const name = weapon?.name ?? 'R-201';
  const sightLayout = VIEWMODEL_SIGHT_LAYOUTS[name];

  // Gunmetal receiver: metallic so it picks up sky reflections and bevel highlights
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, metalness: 0.75, roughness: 0.32 });
  // Matte polymer for grips, stocks and furniture
  const polymerMat = new THREE.MeshStandardMaterial({ color: 0x1f2328, metalness: 0.1, roughness: 0.7 });
  const accentColor = weapon?.bulletVisuals?.color ?? 0x00ffcc;
  const accentMat = new THREE.MeshStandardMaterial({ 
    color: accentColor, 
    emissive: accentColor, 
    emissiveIntensity: forPickup ? 1.0 : 0.3,
    metalness: 0.4,
    roughness: 0.35,
  });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    gun.add(m);
    return m;
  };
  /** Cylinder lying along the barrel axis (z). */
  const cyl = (radius: number, length: number, open = false) =>
    new THREE.CylinderGeometry(radius, radius, length, 18, 1, open).rotateX(Math.PI / 2);

  if (name === 'R-201') {
    // Upper/lower receiver split, vented handguard, muzzle brake, toothed top rail
    add(bevelBox(0.05, 0.045, 0.22, 0.006), bodyMat, 0, 0.012, 0.03);            // upper receiver
    add(bevelBox(0.044, 0.04, 0.15, 0.006), polymerMat, 0, -0.028, 0.06);        // lower receiver
    add(bevelBox(0.048, 0.05, 0.2, 0.008), bodyMat, 0, 0.006, -0.16);            // handguard
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) add(bevelBox(0.004, 0.012, 0.028, 0.0015), polymerMat, side * 0.0245, 0.006, -0.23 + i * 0.04); // vents
    }
    for (const side of [-1, 1]) add(bevelBox(0.003, 0.007, 0.15, 0.0012), accentMat, side * 0.0255, -0.012, -0.15); // accent strips
    const barrel = add(new THREE.CylinderGeometry(0.009, 0.009, 0.1, 16), bodyMat, 0, 0.01, -0.3, Math.PI / 2);
    barrel.castShadow = false;
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.05, 16), polymerMat, 0, 0.01, -0.345, Math.PI / 2); // muzzle brake
    add(bevelBox(0.03, 0.012, 0.012, 0.003), bodyMat, 0, 0.01, -0.35);                              // brake ports
    add(bevelBox(0.024, 0.01, 0.3, 0.003), bodyMat, 0, 0.04, -0.06);                                 // top rail
    for (let i = 0; i < 11; i++) add(bevelBox(0.028, 0.005, 0.008, 0.0015), polymerMat, 0, 0.047, -0.2 + i * 0.027); // rail teeth
    add(bevelBox(0.026, 0.09, 0.045, 0.008), accentMat, 0, -0.085, 0.015, 0.2);   // magazine
    add(bevelBox(0.028, 0.03, 0.047, 0.006), polymerMat, 0, -0.13, 0.005, 0.28);  // mag base plate
    add(bevelBox(0.028, 0.08, 0.036, 0.008), polymerMat, 0, -0.07, 0.115, -0.32); // pistol grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.052, 0.07);           // trigger guard
    add(bevelBox(0.022, 0.03, 0.12, 0.006), bodyMat, 0, 0.0, 0.2);                // stock tube
    add(bevelBox(0.036, 0.08, 0.03, 0.008), polymerMat, 0, -0.014, 0.272);        // butt pad
    add(bevelBox(0.03, 0.022, 0.08, 0.006), polymerMat, 0, 0.022, 0.22);          // cheek rest
  } else if (name === 'EVA-8') {
    // Auto shotgun: heavy receiver, barrel over magazine tube, ribbed pump, box mag
    add(bevelBox(0.058, 0.06, 0.2, 0.008), bodyMat, 0, 0.004, 0.07);                // receiver
    add(cyl(0.017, 0.26), bodyMat, 0, 0.018, -0.13);                               // barrel
    add(cyl(0.021, 0.022), polymerMat, 0, 0.018, -0.25);                           // muzzle ring
    add(cyl(0.013, 0.2), bodyMat, 0, -0.012, -0.11);                               // mag tube
    add(bevelBox(0.052, 0.04, 0.11, 0.01), polymerMat, 0, -0.008, -0.1);           // pump
    for (let i = 0; i < 4; i++) add(bevelBox(0.054, 0.005, 0.01, 0.002), bodyMat, 0, 0.004, -0.14 + i * 0.025); // pump grooves
    add(bevelBox(0.012, 0.006, 0.24, 0.002), bodyMat, 0, 0.037, -0.08);            // vent rib
    add(new THREE.SphereGeometry(0.0045, 8, 6), accentMat, 0, 0.043, -0.2);        // bead sight
    add(bevelBox(0.034, 0.07, 0.05, 0.008), accentMat, 0, -0.06, 0.06, 0.12);      // box magazine
    for (const side of [-1, 1]) add(bevelBox(0.003, 0.02, 0.12, 0.001), accentMat, side * 0.0295, 0.01, 0.07); // side panels
    add(bevelBox(0.028, 0.075, 0.036, 0.008), polymerMat, 0, -0.065, 0.135, -0.3); // grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.035, 0.1);             // trigger guard
    add(bevelBox(0.04, 0.058, 0.14, 0.01), polymerMat, 0, -0.012, 0.235);          // stock
    add(bevelBox(0.044, 0.08, 0.022, 0.008), polymerMat, 0, -0.018, 0.31);         // butt pad
  } else if (name === 'Kraber') {
    // Anti-materiel bolt-action: long barrel, big brake, scope, thumbhole stock
    add(bevelBox(0.05, 0.055, 0.26, 0.008), bodyMat, 0, -0.005, 0.08);              // receiver
    add(cyl(0.012, 0.36), bodyMat, 0, 0.01, -0.29);                                // barrel
    add(cyl(0.018, 0.12), polymerMat, 0, 0.01, -0.1);                              // barrel shroud
    add(bevelBox(0.034, 0.026, 0.05, 0.006), polymerMat, 0, 0.01, -0.465);         // muzzle brake
    for (const side of [-1, 1]) add(bevelBox(0.004, 0.016, 0.01, 0.001), bodyMat, side * 0.017, 0.01, -0.47); // brake ports
    for (const side of [-1, 1]) add(cyl(0.004, 0.2), bodyMat, side * 0.012, -0.018, -0.22); // folded bipod legs
    add(cyl(0.016, 0.16), bodyMat, 0, 0.047, 0.0);                                 // scope tube
    add(cyl(0.021, 0.035), bodyMat, 0, 0.047, -0.09);                              // objective bell
    add(cyl(0.019, 0.03), bodyMat, 0, 0.047, 0.085);                               // eyepiece
    add(new THREE.CircleGeometry(0.018, 16), accentMat, 0, 0.047, -0.108, 0, Math.PI); // lens glint
    for (const z of [-0.04, 0.05]) add(bevelBox(0.02, 0.022, 0.018, 0.004), bodyMat, 0, 0.027, z); // scope rings
    add(new THREE.CylinderGeometry(0.005, 0.005, 0.045, 10).rotateZ(Math.PI / 2), bodyMat, 0.035, 0.01, 0.12); // bolt handle
    add(new THREE.SphereGeometry(0.009, 10, 8), polymerMat, 0.058, 0.01, 0.12);
    add(bevelBox(0.03, 0.05, 0.07, 0.006), accentMat, 0, -0.05, 0.05);             // magazine
    add(bevelBox(0.028, 0.075, 0.036, 0.008), polymerMat, 0, -0.065, 0.16, -0.3);  // grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.035, 0.125);           // trigger guard
    add(bevelBox(0.036, 0.022, 0.16, 0.006), polymerMat, 0, 0.012, 0.29);          // stock top (thumbhole)
    add(bevelBox(0.036, 0.022, 0.12, 0.006), polymerMat, 0, -0.05, 0.31);          // stock bottom
    add(bevelBox(0.03, 0.02, 0.1, 0.006), polymerMat, 0, 0.032, 0.29);             // cheek riser
    add(bevelBox(0.042, 0.1, 0.022, 0.008), polymerMat, 0, -0.018, 0.375);         // butt pad
  } else if (name === 'EPG-1') {
    // Energy grenade launcher: fat bore with glowing coils, charge canister underneath
    add(bevelBox(0.07, 0.07, 0.16, 0.012), bodyMat, 0, -0.005, 0.1);                // receiver
    add(cyl(0.036, 0.22, true), bodyMat, 0, 0.012, -0.075);                        // bore
    add(cyl(0.026, 0.2), polymerMat, 0, 0.012, -0.07);                             // inner bore
    add(new THREE.CircleGeometry(0.026, 20), accentMat, 0, 0.012, -0.175, 0, Math.PI); // glowing chamber
    for (const z of [-0.02, -0.08, -0.14]) {
      const coil = add(new THREE.TorusGeometry(0.039, 0.006, 8, 24), accentMat, 0, 0.012, z);
      coil.castShadow = false;
    }
    add(cyl(0.04, 0.02), polymerMat, 0, 0.012, -0.185);                            // muzzle ring
    add(cyl(0.024, 0.09), accentMat, 0, -0.058, 0.08);                             // charge canister
    add(bevelBox(0.03, 0.012, 0.1, 0.003), bodyMat, 0, 0.038, 0.02);               // sight rail
    add(bevelBox(0.028, 0.075, 0.036, 0.008), polymerMat, 0, -0.07, 0.16, -0.3);   // grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.042, 0.13);            // trigger guard
    add(bevelBox(0.045, 0.06, 0.1, 0.01), polymerMat, 0, -0.01, 0.23);             // stock
  } else if (name === 'Alternator') {
    // Twin-barrel SMG: alternating barrels, bottom mag, folding wire stock
    add(bevelBox(0.07, 0.055, 0.16, 0.01), bodyMat, 0, -0.005, 0.05);               // receiver
    add(bevelBox(0.064, 0.045, 0.05, 0.008), polymerMat, 0, 0.004, -0.04);         // barrel block
    for (const side of [-1, 1]) {
      add(cyl(0.011, 0.1), bodyMat, side * 0.017, 0.008, -0.08);                   // barrels
      add(cyl(0.014, 0.018), polymerMat, side * 0.017, 0.008, -0.125);             // muzzles
    }
    add(bevelBox(0.055, 0.02, 0.03, 0.005), accentMat, 0, 0.03, 0.04);             // vent
    add(bevelBox(0.028, 0.08, 0.036, 0.008), accentMat, 0, -0.065, 0.03, 0.15);    // magazine
    add(bevelBox(0.028, 0.072, 0.034, 0.008), polymerMat, 0, -0.062, 0.12, -0.3);  // grip
    add(bevelBox(0.012, 0.006, 0.045, 0.002), bodyMat, 0, -0.035, 0.09);           // trigger guard
    for (const side of [-1, 1]) add(cyl(0.004, 0.13), bodyMat, side * 0.013, -0.005, 0.19); // stock rods
    add(bevelBox(0.04, 0.055, 0.012, 0.004), polymerMat, 0, -0.012, 0.255);        // stock pad
    add(bevelBox(0.012, 0.012, 0.012, 0.003), bodyMat, 0, 0.032, 0.11);            // rear sight
  } else if (name === 'CAR') {
    // Compact SMG: integral suppressor, long straight mag, top rail with dot sight
    add(bevelBox(0.046, 0.056, 0.16, 0.008), bodyMat, 0, -0.004, 0.04);             // receiver
    add(cyl(0.012, 0.08), bodyMat, 0, 0.012, -0.06);                               // barrel
    add(bevelBox(0.042, 0.042, 0.08, 0.008), bodyMat, 0, 0.004, -0.06);            // handguard
    add(cyl(0.019, 0.13), polymerMat, 0, 0.012, -0.165);                           // suppressor
    for (let i = 0; i < 3; i++) add(cyl(0.02, 0.004), bodyMat, 0, 0.012, -0.12 - i * 0.04); // suppressor bands
    add(bevelBox(0.024, 0.095, 0.034, 0.006), accentMat, 0, -0.072, 0.012, 0.08);  // magazine
    add(bevelBox(0.02, 0.008, 0.2, 0.002), bodyMat, 0, 0.028, -0.01);              // top rail
    for (let i = 0; i < 7; i++) add(bevelBox(0.022, 0.004, 0.006, 0.001), polymerMat, 0, 0.034, -0.09 + i * 0.025);
    add(bevelBox(0.018, 0.016, 0.03, 0.004), polymerMat, 0, 0.041, 0.07);          // dot sight body
    add(bevelBox(0.014, 0.004, 0.004, 0.001), accentMat, 0, 0.049, 0.057);         // dot emitter
    add(bevelBox(0.028, 0.072, 0.034, 0.008), polymerMat, 0, -0.062, 0.1, -0.3);   // grip
    add(bevelBox(0.012, 0.006, 0.045, 0.002), bodyMat, 0, -0.035, 0.07);           // trigger guard
    add(bevelBox(0.03, 0.05, 0.1, 0.008), polymerMat, 0, -0.008, 0.17);            // stock
    add(bevelBox(0.036, 0.065, 0.016, 0.006), polymerMat, 0, -0.012, 0.225);       // butt pad
  } else if (name === 'Flatline') {
    // Heavy AR: flash hider, ribbed handguard, angled mag, skeleton stock
    add(bevelBox(0.058, 0.058, 0.2, 0.01), bodyMat, 0, -0.004, 0.05);               // receiver
    add(bevelBox(0.052, 0.05, 0.13, 0.01), bodyMat, 0, 0.004, -0.12);              // handguard
    for (const side of [-1, 1]) add(bevelBox(0.003, 0.012, 0.11, 0.001), accentMat, side * 0.027, 0.0, -0.12); // accent strips
    for (let i = 0; i < 3; i++) add(bevelBox(0.054, 0.004, 0.012, 0.001), polymerMat, 0, 0.03, -0.16 + i * 0.03); // cooling fins
    add(cyl(0.011, 0.1), bodyMat, 0, 0.012, -0.23);                                // barrel
    add(cyl(0.015, 0.04), polymerMat, 0, 0.012, -0.27);                            // flash hider
    for (const side of [-1, 1]) add(bevelBox(0.003, 0.02, 0.025, 0.001), bodyMat, side * 0.015, 0.012, -0.275); // hider slots
    add(bevelBox(0.028, 0.085, 0.045, 0.008), accentMat, 0, -0.072, 0.05, 0.25);   // magazine
    add(bevelBox(0.014, 0.016, 0.02, 0.004), bodyMat, 0, 0.034, 0.1);              // rear sight
    add(bevelBox(0.008, 0.016, 0.01, 0.002), bodyMat, 0, 0.037, -0.17);            // front post
    add(bevelBox(0.028, 0.075, 0.036, 0.008), polymerMat, 0, -0.065, 0.14, -0.3);  // grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.036, 0.1);             // trigger guard
    add(bevelBox(0.03, 0.014, 0.13, 0.004), polymerMat, 0, 0.012, 0.22);           // stock top bar
    add(bevelBox(0.03, 0.014, 0.1, 0.004), polymerMat, 0, -0.035, 0.23, -0.2);     // stock bottom bar
    add(bevelBox(0.036, 0.075, 0.018, 0.006), polymerMat, 0, -0.012, 0.29);        // butt pad
  } else if (name === 'Mastiff') {
    // Energy shotgun: wide flat emitter with glowing slits, side cell, pump
    add(bevelBox(0.07, 0.065, 0.18, 0.012), bodyMat, 0, -0.004, 0.07);              // receiver
    add(bevelBox(0.08, 0.036, 0.12, 0.01), bodyMat, 0, 0.008, -0.08);              // emitter housing
    for (let i = 0; i < 3; i++) add(bevelBox(0.07, 0.004, 0.02, 0.001), accentMat, 0, 0.0 + (i - 1) * 0.01, -0.145); // emitter slits
    add(bevelBox(0.084, 0.04, 0.018, 0.006), polymerMat, 0, 0.008, -0.15);         // emitter lip
    add(bevelBox(0.05, 0.03, 0.08, 0.008), polymerMat, 0, -0.022, -0.05);          // pump
    add(cyl(0.02, 0.08), accentMat, 0.045, 0.0, 0.1);                              // side energy cell
    add(bevelBox(0.012, 0.012, 0.06, 0.003), bodyMat, 0.045, 0.022, 0.1);          // cell clamp
    add(bevelBox(0.02, 0.01, 0.12, 0.003), bodyMat, 0, 0.034, 0.03);               // sight rib
    add(bevelBox(0.03, 0.075, 0.038, 0.008), polymerMat, 0, -0.07, 0.15, -0.3);    // grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.042, 0.115);           // trigger guard
    add(bevelBox(0.04, 0.06, 0.09, 0.01), polymerMat, 0, -0.012, 0.215);           // stock
    add(bevelBox(0.044, 0.075, 0.018, 0.006), polymerMat, 0, -0.016, 0.265);       // butt pad
  } else if (name === 'Wingman') {
    // Magnum revolver: ribbed barrel, fluted cylinder, big angled grip
    add(bevelBox(0.034, 0.05, 0.1, 0.008), bodyMat, 0, 0.004, 0.0);                 // frame
    add(bevelBox(0.026, 0.028, 0.1, 0.006), bodyMat, 0, 0.018, -0.07);             // barrel lug
    add(cyl(0.0095, 0.02), polymerMat, 0, 0.018, -0.12);                           // muzzle
    add(bevelBox(0.008, 0.008, 0.11, 0.002), bodyMat, 0, 0.035, -0.06);            // top rib
    add(bevelBox(0.004, 0.01, 0.01, 0.001), accentMat, 0, 0.043, -0.11);           // front sight
    add(bevelBox(0.012, 0.008, 0.008, 0.002), bodyMat, 0, 0.04, 0.035);            // rear notch
    add(cyl(0.024, 0.042), bodyMat, 0, -0.002, -0.005);                            // cylinder
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(bevelBox(0.006, 0.006, 0.04, 0.001), polymerMat, Math.cos(a) * 0.022, -0.002 + Math.sin(a) * 0.022, -0.005); // flutes
    }
    add(bevelBox(0.008, 0.016, 0.012, 0.002), bodyMat, 0, 0.034, 0.055, 0.5);      // hammer
    add(bevelBox(0.03, 0.09, 0.04, 0.01), polymerMat, 0, -0.058, 0.075, -0.4);     // grip
    for (const side of [-1, 1]) add(bevelBox(0.002, 0.05, 0.022, 0.001), accentMat, side * 0.0155, -0.06, 0.078, -0.4); // grip inlays
    const guard = add(new THREE.TorusGeometry(0.016, 0.003, 6, 16, Math.PI), bodyMat, 0, -0.024, 0.025);
    guard.rotation.set(0, Math.PI / 2, Math.PI);
  } else if (name === 'L-STAR') {
    // Energy LMG: coil-wrapped shroud, emitter, underslung power pack
    add(bevelBox(0.065, 0.07, 0.24, 0.012), bodyMat, 0, -0.004, 0.06);              // receiver
    add(cyl(0.03, 0.2), bodyMat, 0, 0.012, -0.19);                                 // shroud
    for (let i = 0; i < 4; i++) {
      const coil = add(new THREE.TorusGeometry(0.032, 0.005, 8, 24), accentMat, 0, 0.012, -0.12 - i * 0.045);
      coil.castShadow = false;
    }
    add(cyl(0.02, 0.05), polymerMat, 0, 0.012, -0.315);                            // emitter
    add(new THREE.CircleGeometry(0.014, 16), accentMat, 0, 0.012, -0.341, 0, Math.PI); // emitter glow
    add(bevelBox(0.058, 0.085, 0.065, 0.01), polymerMat, 0, -0.07, 0.08);          // power pack
    add(bevelBox(0.06, 0.008, 0.05, 0.002), accentMat, 0, -0.05, 0.08);            // pack indicator
    for (const side of [-1, 1]) add(cyl(0.004, 0.16), bodyMat, side * 0.018, -0.02, -0.16); // folded bipod
    add(bevelBox(0.024, 0.01, 0.18, 0.003), bodyMat, 0, 0.034, 0.0);               // top rail
    add(bevelBox(0.028, 0.075, 0.036, 0.008), polymerMat, 0, -0.07, 0.17, -0.3);   // grip
    add(bevelBox(0.012, 0.006, 0.05, 0.002), bodyMat, 0, -0.042, 0.135);           // trigger guard
    add(bevelBox(0.04, 0.06, 0.1, 0.01), polymerMat, 0, -0.01, 0.23);              // stock
    add(bevelBox(0.044, 0.08, 0.02, 0.008), polymerMat, 0, -0.014, 0.285);         // butt pad
  } else if (name === 'XO-16') {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 16), bodyMat);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.25); gun.add(barrel);
    const barrelShroud = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.3, 16), bodyMat);
    barrelShroud.rotation.x = Math.PI / 2; barrelShroud.position.set(0, 0.02, -0.45); gun.add(barrelShroud);
    const body = new THREE.Mesh(bevelBox(0.1, 0.08, 0.25), bodyMat);
    body.position.set(0, -0.01, 0.05); gun.add(body);
    const ammoBox = new THREE.Mesh(bevelBox(0.06, 0.12, 0.08), accentMat);
    ammoBox.position.set(0, -0.06, 0.02); gun.add(ammoBox);
    const handle = new THREE.Mesh(bevelBox(0.03, 0.15, 0.04), bodyMat);
    handle.position.set(0, -0.08, 0.12); handle.rotation.x = -0.3; gun.add(handle);
    const sightRail = new THREE.Mesh(bevelBox(0.02, 0.015, 0.2), bodyMat);
    sightRail.position.set(0, 0.045, -0.03); gun.add(sightRail);
    const coolingVents = new THREE.Mesh(bevelBox(0.08, 0.02, 0.06), accentMat);
    coolingVents.position.set(0, 0.03, 0.08); gun.add(coolingVents);
  } else {
    const body = new THREE.Mesh(bevelBox(0.06, 0.06, 0.3), bodyMat);
    gun.add(body);
  }

  // Grip + trigger guard for the generic fallback model (every named weapon models its own)
  if (!(name in WEAPON_MUZZLES)) {
    const grip = new THREE.Mesh(bevelBox(0.025, 0.06, 0.025), polymerMat);
    grip.position.set(0, -0.05, 0.03); grip.rotation.x = -0.2; gun.add(grip);
    const guard = new THREE.Mesh(bevelBox(0.02, 0.008, 0.04), bodyMat);
    guard.position.set(0, -0.03, 0.02); gun.add(guard);
  }

  if (sightLayout) {
    gun.userData.adsAnchor = sightLayout.adsAnchor.clone();
  }

  // --- Attachments Visuals ---
  const attachments = weapon?.attachments || {};

  // Optic
  if (attachments.optic) {
    const opt = attachments.optic;
    const opticGroup = new THREE.Group();
    opticGroup.position.set(0, 0.04, 0.05); // Standard top-rail position

    if (opt.id === 'hcog') {
      const base = new THREE.Mesh(bevelBox(0.03, 0.02, 0.06), bodyMat);
      opticGroup.add(base);
      const glass = new THREE.Mesh(bevelBox(0.025, 0.025, 0.005), new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.4 }));
      glass.position.set(0, 0.02, -0.02);
      opticGroup.add(glass);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.003, 4, 4), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
      dot.position.set(0, 0.02, -0.021);
      opticGroup.add(dot);
      gun.userData.adsAnchor = new THREE.Vector3(0, 0.06, 0.025);
    } else if (opt.id === 'ranger') {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.012, 0.1, 16), bodyMat);
      scope.rotation.x = Math.PI / 2;
      opticGroup.add(scope);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.012, 12), new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.5 }));
      lens.position.z = -0.051; lens.rotation.y = Math.PI;
      opticGroup.add(lens);
      gun.userData.adsAnchor = new THREE.Vector3(0, 0.06, -0.001);
    } else if (opt.id === 'threat') {
      const box = new THREE.Mesh(bevelBox(0.035, 0.035, 0.08), bodyMat);
      opticGroup.add(box);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.025, 0.025), new THREE.MeshBasicMaterial({ color: 0xff3300, transparent: true, opacity: 0.6 }));
      screen.position.z = 0.041;
      opticGroup.add(screen);
      gun.userData.adsAnchor = new THREE.Vector3(0, 0.06, 0.045);
    }
    gun.add(opticGroup);
  }

  // Barrel
  if (attachments.barrel) {
    const bar = attachments.barrel;
    const muzzlePos = (WEAPON_MUZZLES[name] ?? new THREE.Vector3(0, 0.01, -0.35)).clone();

    if (bar.id === 'suppressor') {
      const supGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.15, 16);
      const sup = new THREE.Mesh(supGeo, bodyMat);
      sup.rotation.x = Math.PI / 2;
      sup.position.copy(muzzlePos);
      sup.position.z -= 0.075;
      gun.add(sup);
    } else if (bar.id === 'stabilizer') {
      const stabGeo = bevelBox(0.03, 0.03, 0.08);
      const stab = new THREE.Mesh(stabGeo, accentMat);
      stab.position.copy(muzzlePos);
      stab.position.z -= 0.04;
      gun.add(stab);
    }
  }

  // Magazine
  if (attachments.magazine && attachments.magazine.id === 'extended_mag') {
    const mag = new THREE.Mesh(bevelBox(0.028, 0.12, 0.035), accentMat);
    mag.position.set(0, -0.08, 0.05);
    gun.add(mag);
  }

  if (!forPickup) {
    gun.renderOrder = 900;
    gun.frustumCulled = false;
    gun.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.renderOrder = 900;
      child.frustumCulled = false;

      const material = child.material as THREE.Material & {
        depthTest?: boolean;
        depthWrite?: boolean;
        fog?: boolean;
        opacity?: number;
        transparent?: boolean;
        toneMapped?: boolean;
      };
      const shouldStayTransparent = material.transparent === true || (material.opacity !== undefined && material.opacity < 1);
      material.transparent = shouldStayTransparent;
      material.opacity = material.opacity ?? 1;
      material.depthTest = true;
      material.depthWrite = !shouldStayTransparent;
      material.fog = false;
      material.toneMapped = false;
    });
  } else {
    // Pickup specific scale and rotation adjustments if needed
    gun.scale.set(1.5, 1.5, 1.5); // Make it slightly larger in world
  }

  return gun;
}

/**
 * Titanfall 2 player controller.
 */
export class Player {
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  group: THREE.Group;

  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private keys: KeyState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    fire: false,
    embark: false,
  };

  private movement!: MovementSystem;
  private wasJumping = false;
  private wasSliding = false;
  private wasWallRunning = false;
  private wasMantling = false;
  private jumpJustPressed = false;
  private crouchJustPressed = false;

  private isGrappling = false;
  private grappleTarget = new THREE.Vector3();
  private grappleRope: THREE.Mesh | null = null;
  private grapplePreviewLine: THREE.Line | null = null;
  private grappleCooldown = 0;
  private grappleKeyHeld = false;
  private grappleProjectile: THREE.Mesh | null = null;
  private grappleProjectileVelocity = new THREE.Vector3();
  private grappleProjectileActive = false;
  private readonly GRAPPLE_RANGE = 50;
  private readonly GRAPPLE_PULL_ACCEL = 42;
  private readonly GRAPPLE_COOLDOWN = 2;
  private readonly GRAPPLE_PROJECTILE_SPEED = 95;
  private readonly GRAPPLE_PROJECTILE_GRAVITY = -4;
  private readonly GRAPPLE_HOLD_GRAVITY = -8;
  private readonly GRAPPLE_TANGENT_BOOST = 1.1;
  private readonly GRAPPLE_INITIAL_BOOST = 8;
  private readonly GRAPPLE_RELEASE_BOOST = 1.08;
  private readonly GRAPPLE_MAX_SPEED = 34;
  private readonly GRAPPLE_SLACK_DISTANCE = 2.75;
  private readonly GRAPPLE_ROPE_RADIUS = 0.018;
  private readonly GRAPPLE_ROPE_SEGMENTS = 18;

  private gamepadIndex: number | null = null;
  private gamepadMove = new THREE.Vector2();
  private gamepadLook = new THREE.Vector2();
  private gamepadLookSmoothed = new THREE.Vector2();
  private titanMouseLook = new THREE.Vector2();
  private gamepadJumpPrev = false;
  private gamepadCrouchPrev = false;
  private gamepadSprint = false;
  private gamepadCrouch = false;
  private gamepadFire = false;
  private gamepadADS = false;
  private mouseADS = false;
  private gamepadTitanDash = false;

  private weaponMesh: THREE.Group | null = null;
  private readonly hipfirePos = new THREE.Vector3(0.25, -0.22, -0.4);
  private readonly adsPos = new THREE.Vector3(0, -0.13, -0.35);
  private readonly adsSightOffset = new THREE.Vector3(0, -0.012, -0.16);
  private weaponViewOffset = this.hipfirePos.clone();
  private weaponBobTime = 0;
  private weaponRecoilKick = 0;
  private weaponSwayX = 0;
  private weaponSwayY = 0;

  health = 100;
  titanMeter = 0;
  private timeSinceDamage = 0;
  private readonly REGEN_DELAY = 4;
  private readonly REGEN_RATE = 25;
  private lastShotTime = 0;
  private bullets: Bullet[] = [];
  private grenades: Grenade[] = [];
  private grenadeCooldown = 0;
  private grenadeCount = 2;
  private maxGrenades = 2;
  private grenadeRegenTime = 0;
  private readonly GRENADE_REGEN_DURATION = 5;
  private grenadeHeld = false;
  private grenadeTrajectoryLine: THREE.Line | null = null;
  private gamepadGrenadeHeld = false;
  private ballisticsSystem!: BallisticsSystem;
  private impactRenderer!: ImpactEffectsRenderer;
  private weaponManager = new WeaponManager();
  private activeWeapon!: Weapon;
  private aimingSystem = new AimingSystem();
  private reticleRenderer = new ReticleRenderer();
  private radarRenderer = new RadarRenderer();
  private recoilOffset = { x: 0, y: 0 };
  private crosshairSpread = 0;
  private weaponSwitchCooldown = 0;

  body: CANNON.Body;
  private readonly world: CANNON.World;
  private readonly listeners = new AbortController();
  private inputEnabled = true;

  private onTitanMeterChange?: (meter: number) => void;
  private onCallTitan?: () => void;
  private onEmbarkTitan?: () => void;
  private onDisembarkTitan?: () => void;
  private onPause?: () => void;
  private onTitanControl?: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean, crouch: boolean) => void;
  private isPilotingTitan = false;
  private gamepadButtonXHoldTime = 0;
  private gamepadMenuPrev = false;
  private keyboardEmbarkStartTime = 0;
  private hasTriggeredEmbark = false;
  private suppressInteractRelease = false;
  private readonly DISENGAGE_HOLD_TIME = 1.0;
  private readonly EMBARK_COOLDOWN = 2.0;
  private lastEmbarkTime = performance.now();
  private isDisembarking = false;
  private gamepadDpadDownPrev = false;
  private gamepadReloadPrev = false;
  private gamepadGrenadePrev = false;
  private gamepadGrapplePrev = false;

  constructor(camera: THREE.PerspectiveCamera, scene: THREE.Scene, world: CANNON.World) {
    this.camera = camera;
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();

    const shape = new CANNON.Sphere(0.4);
    this.body = new CANNON.Body({
      mass: 1,
      shape,
      position: new CANNON.Vec3(0, 2, 0),
      fixedRotation: true,
      linearDamping: 0,
      angularDamping: 1,
    });
    this.body.type = CANNON.Body.DYNAMIC;
    world.addBody(this.body);

    this.movement = new MovementSystem(scene, this.body);
    this.setupControls();
    this.ballisticsSystem = new BallisticsSystem(this.scene);
    this.impactRenderer = new ImpactEffectsRenderer(this.scene);
    this.aimingSystem.setRecoilCompensation((movement) => {
      this.recoilOffset.x += movement.x;
      this.recoilOffset.y += movement.y;
    });
    this.weaponManager.addWeapon(R201_WEAPON);
    this.activeWeapon = this.weaponManager.getCurrentWeapon()!;
    this.reticleRenderer.setWeapon(this.activeWeapon.name);
    this.rebuildWeaponMesh();
    this.updateWeaponHUD();
  }

  private rebuildWeaponMesh() {
    if (this.weaponMesh) {
      this.scene.remove(this.weaponMesh);
      this.weaponMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.weaponMesh = null;
    }

    const gun = createWeaponMesh(this.activeWeapon, false);
    this.weaponViewOffset.copy(this.hipfirePos);
    this.scene.add(gun);
    this.weaponMesh = gun;
    this.syncWeaponMeshToCamera();
  }

  private syncWeaponMeshToCamera(): void {
    if (!this.weaponMesh) return;
    const offset = this.weaponViewOffset.clone().applyQuaternion(this.camera.quaternion);
    this.weaponMesh.position.copy(this.camera.position).add(offset);
    this.weaponMesh.quaternion.copy(this.camera.quaternion);
  }

  private syncViewmodelAnchors(): void {
    this.camera.quaternion.setFromEuler(this.euler);
    this.camera.position.copy(this.group.position);
    this.camera.position.y += 0.5;
    this.syncWeaponMeshToCamera();
  }

  private getADSViewOffset(): THREE.Vector3 {
    const adsAnchor = this.weaponMesh?.userData.adsAnchor;
    if (adsAnchor instanceof THREE.Vector3) {
      return this.adsSightOffset.clone().sub(adsAnchor);
    }
    return this.adsPos.clone();
  }

  private getWeaponMuzzleLocalOffset(): THREE.Vector3 {
    const muzzle = (WEAPON_MUZZLES[this.activeWeapon.name] ?? new THREE.Vector3(0, 0, -0.18)).clone();
    // Fire from the tip of a suppressor/stabilizer rather than from inside it
    muzzle.z -= barrelAttachmentLength(this.activeWeapon.attachments.barrel?.id);
    return muzzle;
  }

  private getWeaponMuzzlePosition(aimDir: THREE.Vector3): THREE.Vector3 {
    this.syncViewmodelAnchors();
    if (!this.weaponMesh) {
      return this.camera.position.clone().add(aimDir.clone().multiplyScalar(0.5));
    }
    this.weaponMesh.updateWorldMatrix(true, false);
    return this.weaponMesh.localToWorld(this.getWeaponMuzzleLocalOffset());
  }

  private getShotDirection(weapon: Weapon, aimDir: THREE.Vector3, spreadRad: number, pelletIndex: number, pelletCount: number): THREE.Vector3 {
    if (spreadRad <= 0) return aimDir.clone();
    const right = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
    const up = new THREE.Vector3().crossVectors(right, aimDir).normalize();
    if (weapon.name === 'Mastiff' && pelletCount > 1) {
      const t = pelletCount === 1 ? 0 : pelletIndex / (pelletCount - 1);
      const angleOffset = (t - 0.5) * 2 * spreadRad;
      return aimDir.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(up, angleOffset));
    }
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spreadRad;
    return aimDir.clone().add(right.multiplyScalar(Math.cos(angle) * radius)).add(up.multiplyScalar(Math.sin(angle) * radius)).normalize();
  }

  private getCameraAimPoint(weapon: Weapon, aimDir: THREE.Vector3): THREE.Vector3 {
    const raycaster = new THREE.Raycaster(this.camera.position, aimDir.clone().normalize(), 0, weapon.range);
    const intersects = raycaster.intersectObjects(this.getMeshes(), false);
    if (intersects.length > 0) return intersects[0].point.clone();
    return this.camera.position.clone().add(aimDir.clone().multiplyScalar(weapon.range));
  }

  private getProjectileVelocity(
    weapon: Weapon,
    startPos: THREE.Vector3,
    cameraShotDir: THREE.Vector3,
    aimPoint: THREE.Vector3,
    isADS: boolean,
  ): THREE.Vector3 {
    const directToAim = aimPoint.clone().sub(startPos);
    if (directToAim.lengthSq() < 1e-6) {
      return cameraShotDir.clone().multiplyScalar(weapon.bulletSpeed);
    }

    directToAim.normalize();

    const maxConvergeDeg = weapon.bulletSpeed <= 70
      ? 12
      : weapon.bulletsPerShot > 1
        ? 9
        : isADS
          ? 5
          : 8;
    const maxConvergeRad = THREE.MathUtils.degToRad(maxConvergeDeg);
    const angleToAim = cameraShotDir.angleTo(directToAim);

    let finalDir = directToAim;
    if (angleToAim > maxConvergeRad) {
      const blend = maxConvergeRad / angleToAim;
      finalDir = cameraShotDir.clone().lerp(directToAim, blend).normalize();
    }

    return finalDir.multiplyScalar(weapon.bulletSpeed);
  }

  private setupControls() {
    const opts = { signal: this.listeners.signal };
    document.addEventListener("keydown", (e) => this.onKeyDown(e), opts);
    document.addEventListener("keyup", (e) => this.onKeyUp(e), opts);
    document.addEventListener("mousemove", (e) => this.onMouseMove(e), opts);
    document.addEventListener("mousedown", (e) => {
      if (!this.inputEnabled) return;
      if (e.button === 0) this.keys.fire = true;
      if (e.button === 2) this.mouseADS = true;
    }, opts);
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.keys.fire = false;
      if (e.button === 2) this.mouseADS = false;
    }, opts);
    document.addEventListener("contextmenu", (e) => e.preventDefault(), opts);
    window.addEventListener("gamepadconnected", (e) => { this.gamepadIndex = e.gamepad.index; }, opts);
    window.addEventListener("gamepaddisconnected", () => { this.gamepadIndex = null; }, opts);
    window.addEventListener("blur", () => this.releaseAllInput(), opts);
    document.addEventListener("wheel", (e) => {
      if (!this.inputEnabled || !document.pointerLockElement) return;
      if (this.weaponSwitchCooldown > 0) return;
      if (e.deltaY > 0) this.switchWeapon(this.weaponManager.nextWeapon());
      else if (e.deltaY < 0) this.switchWeapon(this.weaponManager.prevWeapon());
    }, opts);
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gamepads.length; i++) { if (gamepads[i]) { this.gamepadIndex = i; break; } }
  }

  /** Clears held keys/buttons so nothing stays "stuck" after focus loss or pausing. */
  private releaseAllInput(): void {
    for (const key of Object.keys(this.keys) as (keyof KeyState)[]) this.keys[key] = false;
    this.mouseADS = false;
    this.grenadeHeld = false;
    this.jumpJustPressed = false;
    this.crouchJustPressed = false;
  }

  /**
   * Enable/disable gameplay input (e.g. while paused or in menus). Disabling also
   * hides the reticle and radar, whose canvases sit above the menu overlays.
   */
  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) {
      this.releaseAllInput();
      this.reticleRenderer.hide();
      this.radarRenderer.hide();
    } else {
      this.radarRenderer.show();
      // Buttons still held from menu navigation (e.g. A on "Resume") must not trigger actions
      this.gamepadJumpPrev = this.gamepadCrouchPrev = this.gamepadMenuPrev = true;
      this.gamepadDpadDownPrev = this.gamepadReloadPrev = this.gamepadGrenadePrev = this.gamepadGrapplePrev = true;
    }
  }

  /** True while the pilot is inside a titan (entering, piloting or exiting). */
  isInTitan(): boolean {
    return this.isPilotingTitan;
  }

  hasFreeWeaponSlot(): boolean {
    return this.weaponManager.getWeaponCount() < MAX_WEAPON_SLOTS;
  }

  /**
   * Picks up `newWeapon`. Fills an empty slot if one is available, otherwise
   * swaps it with the active weapon. Returns whether it was picked up and the
   * weapon that was dropped (if any), so the caller can leave it in the world.
   */
  tryPickupWeapon(newWeapon: Weapon): { pickedUp: boolean; dropped: Weapon | null } {
    let dropped: Weapon | null = null;
    if (this.weaponManager.getWeaponCount() < MAX_WEAPON_SLOTS) {
      this.weaponManager.addWeapon(newWeapon);
      this.weaponManager.switchTo(this.weaponManager.getWeaponCount() - 1);
    } else {
      dropped = this.weaponManager.replaceWeapon(this.weaponManager.getCurrentIndex(), newWeapon);
      if (!dropped) return { pickedUp: false, dropped: null };
    }
    this.activeWeapon = this.weaponManager.getCurrentWeapon()!;
    this.weaponSwitchCooldown = 0.3;
    this.crosshairSpread = 0;
    this.reticleRenderer.setWeapon(this.activeWeapon.name);
    this.rebuildWeaponMesh();
    soundManager.playSound('pickup', 0.4);
    return { pickedUp: true, dropped };
  }

  /** Fits `attachment` to the active weapon. */
  equipAttachment(attachment: Attachment): void {
    this.weaponManager.attach(this.weaponManager.getCurrentIndex(), attachment);
    this.rebuildWeaponMesh();
    soundManager.playSound('pickup', 0.4);
  }

  /** Removes every listener, DOM element, mesh and physics body this player created. */
  dispose(): void {
    this.listeners.abort();
    this.world.removeBody(this.body);

    const removeAndDispose = (object: THREE.Object3D | null) => {
      if (!object) return;
      object.parent?.remove(object);
      disposeObject3D(object);
    };
    removeAndDispose(this.weaponMesh);
    this.weaponMesh = null;
    removeAndDispose(this.grappleProjectile);
    this.grappleProjectile = null;
    removeAndDispose(this.grappleRope);
    this.grappleRope = null;
    removeAndDispose(this.grapplePreviewLine);
    this.grapplePreviewLine = null;
    removeAndDispose(this.grenadeTrajectoryLine);
    this.grenadeTrajectoryLine = null;
    for (const g of this.grenades) {
      removeAndDispose(g.mesh);
      removeAndDispose(g.trail);
    }
    this.grenades = [];
    for (const b of this.bullets) this.ballisticsSystem.disposeBullet(b);
    this.bullets = [];
    this.impactRenderer.disposeAll();
    this.reticleRenderer.destroy();
    this.radarRenderer.destroy();
    this.group.parent?.remove(this.group);
  }

  private switchWeapon(weapon: Weapon | null): void {
    if (!weapon || weapon === this.activeWeapon) return;
    this.weaponManager.cancelReload();
    this.activeWeapon = weapon;
    this.weaponSwitchCooldown = 0.3;
    this.crosshairSpread = 0;
    this.reticleRenderer.setWeapon(weapon.name);
    this.rebuildWeaponMesh();
    this.updateWeaponHUD();
    soundManager.playSound('weapon_switch', 0.4);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.inputEnabled) return;
    const b = getBindings();
    if (e.repeat && (e.code === b.grapple || e.code === b.grenade || e.code === b.reload)) return;
    if (e.code === b.forward) this.keys.forward = true;
    else if (e.code === b.backward) this.keys.backward = true;
    else if (e.code === b.left) this.keys.left = true;
    else if (e.code === b.right) this.keys.right = true;
    else if (e.code === b.jump) { this.keys.jump = true; this.jumpJustPressed = true; }
    else if (e.code === b.sprint) this.keys.sprint = true;
    else if (e.code === b.crouch) { this.keys.crouch = true; this.crouchJustPressed = true; }
    else if (e.code === b.embark) { this.keys.embark = true; this.keyboardEmbarkStartTime = performance.now(); this.hasTriggeredEmbark = false; this.suppressInteractRelease = false; }
    else if (e.code === b.reload) { if (!this.isPilotingTitan && this.weaponManager.startReload()) soundManager.playSound('reload', 0.4); }
    else if (e.code === b.grenade) { if (!this.isPilotingTitan) this.grenadeHeld = true; }
    else if (e.code === b.grapple) this.toggleGrapple();
    else if (e.code === 'Digit1') this.switchWeapon(this.weaponManager.switchTo(0));
    else if (e.code === 'Digit2') this.switchWeapon(this.weaponManager.switchTo(1));
    else if (e.code === 'Digit3') this.switchWeapon(this.weaponManager.switchTo(2));
    else if (e.code === 'Digit4') this.switchWeapon(this.weaponManager.switchTo(3));
  }

  private onKeyUp(e: KeyboardEvent) {
    const b = getBindings();
    if (e.code === b.forward) this.keys.forward = false;
    else if (e.code === b.backward) this.keys.backward = false;
    else if (e.code === b.left) this.keys.left = false;
    else if (e.code === b.right) this.keys.right = false;
    else if (e.code === b.jump) this.keys.jump = false;
    else if (e.code === b.sprint) this.keys.sprint = false;
    else if (e.code === b.crouch) this.keys.crouch = false;
    else if (e.code === b.embark) {
      this.keys.embark = false;
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      if (!this.hasTriggeredEmbark && !this.suppressInteractRelease && holdDuration < this.DISENGAGE_HOLD_TIME && this.onEmbarkTitan) {
        // Only embark here if NOT piloting and NOT already triggered by Game.ts hold
        if (!this.isPilotingTitan) {
          this.lastEmbarkTime = performance.now();
          this.onEmbarkTitan();
        }
      }
      this.hasTriggeredEmbark = false;
      this.suppressInteractRelease = false;
    }
    else if (e.code === b.grenade) { if (this.grenadeHeld) { this.grenadeHeld = false; this.throwGrenade(); } }
  }

  private readonly LOOK_SENS_X = 0.002;
  private readonly LOOK_SENS_Y = 0.0012;
  private readonly ADS_SENS_MULT = 0.4;
  private readonly TITAN_LOOK_X_FROM_MOUSE = 0.06;
  private readonly TITAN_LOOK_Y_FROM_MOUSE = 0.06;

  private onMouseMove(e: MouseEvent) {
    if (!this.inputEnabled || !document.pointerLockElement) return;
    const sensMult = (this.mouseADS || this.gamepadADS) ? this.ADS_SENS_MULT : 1.0;
    if (this.isPilotingTitan) {
      this.titanMouseLook.x += e.movementX * this.TITAN_LOOK_X_FROM_MOUSE * sensMult;
      this.titanMouseLook.y += e.movementY * this.TITAN_LOOK_Y_FROM_MOUSE * sensMult;
    }
    const compX = this.recoilOffset.x;
    const compY = this.recoilOffset.y;
    this.recoilOffset.x = 0; this.recoilOffset.y = 0;
    this.euler.y -= (e.movementX * this.LOOK_SENS_X + compX) * sensMult;
    this.euler.x -= (e.movementY * this.LOOK_SENS_Y + compY) * sensMult;
    this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
  }

  lockPointer() {
    // Newer browsers return a promise that rejects without a user gesture; that's expected, not an error.
    const result = document.body.requestPointerLock() as unknown;
    if (result instanceof Promise) result.catch(() => {});
  }

  setTitanMeterCallback(callback: (meter: number) => void): void { this.onTitanMeterChange = callback; }
  setCallTitanCallback(callback: () => void): void { this.onCallTitan = callback; }
  setEmbarkTitanCallback(callback: () => void): void { this.onEmbarkTitan = callback; }
  setDisembarkTitanCallback(callback: () => void): void { this.onDisembarkTitan = callback; }
  setPauseCallback(callback: () => void): void { this.onPause = callback; }
  setTitanControlCallback(callback: (forward: number, right: number, lookX: number, lookY: number, fire: boolean, dash: boolean, crouch: boolean) => void): void { this.onTitanControl = callback; }

  setPilotingState(piloting: boolean): void {
    this.isPilotingTitan = piloting;
    if (!piloting) this.titanMouseLook.set(0, 0);
    if (piloting) {
      this.grenadeHeld = false;
      this.gamepadGrenadeHeld = false;
    }
    // Hide/show pilot weapon model so it doesn't render over the titan cockpit weapon
    if (this.weaponMesh) this.weaponMesh.visible = !piloting;
    const hud = document.getElementById('weapon-hud');
    if (hud) hud.style.display = piloting ? 'none' : '';
    if (piloting) this.reticleRenderer.setWeapon('XO-16'); else this.reticleRenderer.setWeapon(this.activeWeapon.name);
  }

  private updateTitanControls(): void {
    if (!this.onTitanControl || !this.isPilotingTitan) return;
    let localX = 0, localZ = 0;
    if (this.keys.forward) localZ -= 1; if (this.keys.backward) localZ += 1;
    if (this.keys.left) localX -= 1; if (this.keys.right) localX += 1;
    if (this.gamepadMove.length() > 0.1) { localX += this.gamepadMove.x; localZ += this.gamepadMove.y; }
    const mag = Math.hypot(localX, localZ);
    if (mag > 1) { localX /= mag; localZ /= mag; }
    const lookX = (this.gamepadLook.x || 0) + this.titanMouseLook.x;
    const lookY = (this.gamepadLook.y || 0) + this.titanMouseLook.y;
    this.titanMouseLook.set(0, 0);
    this.onTitanControl(-localZ, localX, lookX, lookY, this.keys.fire || this.gamepadFire, this.keys.sprint || this.gamepadTitanDash, this.keys.crouch || this.gamepadCrouch);
  }

  syncToTitan(position: THREE.Vector3, yaw: number): void {
    this.body.position.set(position.x, position.y + 1, position.z);
    this.body.velocity.set(0, 0, 0); this.movement.vel.set(0, 0, 0);
    this.group.position.set(position.x, position.y + 1, position.z);
    this.euler.y = yaw;
  }

  resetTitanMeter(): void { this.titanMeter = 0; if (this.onTitanMeterChange) this.onTitanMeterChange(0); }
  setVelocity(x: number, y: number, z: number): void { this.movement.vel.set(x, y, z); }
  isADSActive(): boolean { return this.mouseADS || this.gamepadADS; }
  shouldShowSniperScope(): boolean { return !this.isPilotingTitan && this.activeWeapon.name === 'Kraber' && this.isADSActive(); }
  isInteractHeld(): boolean { return this.keys.embark || this.gamepadButtonXHoldTime > 0; }
  consumeInteractHold(): void { this.hasTriggeredEmbark = true; this.suppressInteractRelease = true; }
  isInteractConsumed(): boolean { return this.suppressInteractRelease; }
  getVelocity(): THREE.Vector3 { return this.movement.vel; }

  private pollGamepad() {
    if (this.gamepadIndex === null || !this.inputEnabled) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return;
    const moveDeadzone = 0.15, lookDeadzone = 0.06, moveSens = 0.6, lookSens = 1.0;
    const applyDeadzone = (value: number, deadzone: number) => {
      const abs = Math.abs(value);
      if (abs <= deadzone) return 0;
      const normalized = (abs - deadzone) / (1 - deadzone);
      return Math.sign(value) * normalized;
    };
    const moveAxis = (i: number, sens: number) => applyDeadzone(gp.axes[i] || 0, moveDeadzone) * sens;
    this.gamepadMove.set(moveAxis(0, moveSens), moveAxis(1, moveSens));
    const curve = getAimCurve();
    const rawLookX = applyDeadzone(gp.axes[2] || 0, lookDeadzone);
    const rawLookY = applyDeadzone(gp.axes[3] || 0, lookDeadzone);
    this.gamepadLook.set(applyAimCurve(rawLookX, curve) * lookSens, applyAimCurve(rawLookY, curve) * lookSens);
    const smoothFactor = 0.3;
    this.gamepadLookSmoothed.x += (this.gamepadLook.x - this.gamepadLookSmoothed.x) * smoothFactor;
    this.gamepadLookSmoothed.y += (this.gamepadLook.y - this.gamepadLookSmoothed.y) * smoothFactor;
    const lb = gp.buttons[4]?.pressed ?? false, rb = gp.buttons[5]?.pressed ?? false, lt = gp.buttons[6]?.value ?? 0, rt = gp.buttons[7]?.value ?? 0;
    const buttonX = gp.buttons[2]?.pressed ?? false, dpadDown = gp.buttons[13]?.pressed ?? false, menuBtn = gp.buttons[8]?.pressed ?? false;
    const buttonA = gp.buttons[0]?.pressed ?? false, buttonB = gp.buttons[1]?.pressed ?? false, buttonY = gp.buttons[3]?.pressed ?? false;
    if (buttonY && !this.gamepadReloadPrev) this.switchWeapon(this.weaponManager.nextWeapon());
    this.gamepadReloadPrev = buttonY;
    if (this.isPilotingTitan) {
      this.gamepadGrenadeHeld = false;
    } else {
      if (buttonB && !this.gamepadGrenadePrev) this.gamepadGrenadeHeld = true;
      if (!buttonB && this.gamepadGrenadeHeld) { this.gamepadGrenadeHeld = false; this.throwGrenade(); }
    }
    this.gamepadGrenadePrev = buttonB;
    if (lb && !this.gamepadJumpPrev) this.jumpJustPressed = true;
    this.gamepadJumpPrev = lb;
    const crouchPressed = this.isPilotingTitan ? buttonB : rb;
    if (crouchPressed && !this.gamepadCrouchPrev) this.crouchJustPressed = true;
    this.gamepadCrouchPrev = crouchPressed; this.gamepadCrouch = crouchPressed;
    if (buttonX) {
      if (this.gamepadButtonXHoldTime === 0) { this.hasTriggeredEmbark = false; this.suppressInteractRelease = false; }
      if (!this.isDisembarking) {
        this.gamepadButtonXHoldTime += 0.016;
        const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
        if (this.gamepadButtonXHoldTime >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) {
          if (timeSinceEmbark >= this.EMBARK_COOLDOWN) { this.isDisembarking = true; this.onDisembarkTitan(); }
        }
      }
    } else {
      if (this.gamepadButtonXHoldTime > 0 && this.gamepadButtonXHoldTime < this.DISENGAGE_HOLD_TIME && !this.suppressInteractRelease) {
        if (!this.isPilotingTitan) {
          if (this.weaponManager.startReload()) soundManager.playSound('reload', 0.4);
          this.updateWeaponHUD();
        }
      }
      this.gamepadButtonXHoldTime = 0; this.isDisembarking = false; this.hasTriggeredEmbark = false; this.suppressInteractRelease = false;
    }
    if (dpadDown && !this.gamepadDpadDownPrev && this.onCallTitan) this.onCallTitan();
    this.gamepadDpadDownPrev = dpadDown;
    if (menuBtn && !this.gamepadMenuPrev && this.onPause) this.onPause();
    this.gamepadMenuPrev = menuBtn; this.gamepadTitanDash = buttonA;
    if (!this.isPilotingTitan) {
      if (buttonA && !this.gamepadGrapplePrev) this.toggleGrapple();
    }
    this.gamepadGrapplePrev = buttonA;
    this.gamepadSprint = Math.hypot(gp.axes[0] || 0, gp.axes[1] || 0) > 0.9;
    this.gamepadFire = rt > 0.5; this.gamepadADS = lt > 0.3;
    if (this.gamepadLookSmoothed.length() > 0.01) {
      const adsMult = (this.mouseADS || this.gamepadADS) ? this.ADS_SENS_MULT : 1.0;
      this.euler.y -= this.gamepadLookSmoothed.x * 0.04 * adsMult;
      this.euler.x -= this.gamepadLookSmoothed.y * 0.03 * adsMult;
      this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
    }
  }

  private getMeshes(): THREE.Mesh[] { return this.scene.children.filter((o) => o instanceof THREE.Mesh && !o.userData.ignoreRaycast) as THREE.Mesh[]; }

  private buildMovementInput(): MovementInput {
    const input: MovementInput = { forward: this.keys.forward, backward: this.keys.backward, left: this.keys.left, right: this.keys.right, jumpJustPressed: this.jumpJustPressed, sprint: this.keys.sprint, crouch: this.keys.crouch, crouchJustPressed: this.crouchJustPressed, gamepadMove: this.gamepadMove.clone(), gamepadSprint: this.gamepadSprint, gamepadCrouch: this.gamepadCrouch, yaw: this.euler.y };
    this.jumpJustPressed = false; this.crouchJustPressed = false; return input;
  }

  update(delta: number, targets: Damageable[] = [], enemies: Damageable[] = []) {
    this.pollGamepad();
    this.regenerateHealth(delta);
    if (this.isPilotingTitan) { this.updateTitanControls(); this.handleShooting(delta, targets, enemies, false); this.updateGrenades(delta, targets, enemies); this.reticleRenderer.setSpread(0); this.reticleRenderer.render(); this.reticleRenderer.show(); return; }
    if (this.keys.embark) {
      const holdDuration = (performance.now() - this.keyboardEmbarkStartTime) / 1000;
      const timeSinceEmbark = (performance.now() - this.lastEmbarkTime) / 1000;
      if (holdDuration >= this.DISENGAGE_HOLD_TIME && !this.isDisembarking && this.onDisembarkTitan) { if (timeSinceEmbark >= this.EMBARK_COOLDOWN) { this.isDisembarking = true; this.hasTriggeredEmbark = true; this.onDisembarkTitan(); } }
    }
    this.updateGrapple(delta);
    if (!this.isGrappling) { const input = this.buildMovementInput(); this.movement.update(delta, input); }
    else { this.jumpJustPressed = false; this.crouchJustPressed = false; }
    this.applyVelocity(); this.handleShooting(delta, targets, enemies); this.updateGrenades(delta, targets, enemies); this.updateGrenadeTrajectory(); this.updateGrappleTrajectory(); this.updateAiming(delta); this.syncCamera(); this.updateUI();
  }

  private applyVelocity() {
    const m = this.movement;
    if (m.vel.y > 0.1 && !this.wasJumping) soundManager.playSound("jump", 0.3); this.wasJumping = m.vel.y > 0.1;
    if (m.isSliding && !this.wasSliding) soundManager.playSound("slide", 0.3); this.wasSliding = m.isSliding;
    if (m.isWallRunning && !this.wasWallRunning) soundManager.playSound("wallrun", 0.25); this.wasWallRunning = m.isWallRunning;
    if (m.isMantling && !this.wasMantling) soundManager.playSound("mantle", 0.3); this.wasMantling = m.isMantling;
    m.applyToBody(); this.group.position.set(this.body.position.x, this.body.position.y, this.body.position.z);
    if (this.body.position.y < -10) { this.body.position.set(0, 5, 0); m.vel.set(0, 0, 0); this.body.velocity.set(0, 0, 0); }
  }

  private handleShooting(delta: number, targets: Damageable[], enemies: Damageable[], allowFire: boolean = true) {
    if (this.weaponSwitchCooldown > 0) this.weaponSwitchCooldown = Math.max(0, this.weaponSwitchCooldown - delta);
    if (this.weaponManager.isReloading()) { if (this.weaponManager.updateReload(delta * 1000)) this.updateWeaponHUD(); }
    if (allowFire && this.weaponSwitchCooldown <= 0 && !this.weaponManager.isReloading() && (this.keys.fire || this.gamepadFire)) {
      const now = performance.now();
      if (now - this.lastShotTime > this.activeWeapon.fireRate) {
        if (this.weaponManager.getCurrentAmmo() <= 0) { if (this.weaponManager.startReload()) soundManager.playSound('reload', 0.4); this.updateWeaponHUD(); }
        else { this.weaponManager.consumeAmmo(1); this.shoot(); this.lastShotTime = now; this.updateWeaponHUD(); }
      }
    }
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    const damageables = [...targets, ...enemies];
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prevPos = b.mesh.position.clone();
      this.ballisticsSystem.updateBullet(b, delta);
      const step = b.mesh.position.clone().sub(prevPos);
      const stepLen = step.length();
      let hit = false;

      // Nearest world surface along this frame's path (if any)
      let wallHit: THREE.Intersection | null = null;
      if (stepLen > 1e-6) {
        const raycaster = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen);
        wallHit = raycaster.intersectObjects(worldMeshes, false)[0] ?? null;
      }

      // Entities are tested along the whole segment up to the wall, so fast rounds can't tunnel through them
      const segmentEnd = wallHit ? wallHit.point : b.mesh.position;
      const entityHit = this.findSegmentHit(prevPos, segmentEnd, damageables);
      if (entityHit) {
        b.mesh.position.copy(entityHit.point);
        entityHit.entity.takeDamage(b.damage, entityHit.point);
        this.impactRenderer.spawnImpact(entityHit.point.clone(), b.velocity.clone().normalize().negate(), PLAYER_IMPACT_CONFIG);
        this.reticleRenderer.showHitmarker(entityHit.entity.health <= 0);
        hit = true;
      } else if (wallHit) {
        b.mesh.position.copy(wallHit.point);
        const normal = wallHit.face ? wallHit.face.normal.clone().transformDirection(wallHit.object.matrixWorld) : step.clone().normalize().negate();
        this.impactRenderer.spawnImpact(wallHit.point, normal, PLAYER_IMPACT_CONFIG);
        hit = true;
      }

      if (hit || b.time > b.maxLifetime || b.mesh.position.y < -5) {
        if (hit && b.explosive) {
          const impactPos = b.mesh.position.clone();
          this.impactRenderer.spawnExplosion(impactPos, EPG_EXPLOSION_CONFIG); soundManager.playSound('explosion', 0.6);
          if (b.splashRadius > 0) this.applySplashDamage(impactPos, b.damage, b.splashRadius, damageables);
        }
        this.ballisticsSystem.disposeBullet(b); this.bullets.splice(i, 1);
      }
    }
    this.impactRenderer.update(delta);
  }

  /** First entity hit along the segment `from` → `to`, sampled finely enough that no hitbox is skipped. */
  private findSegmentHit(from: THREE.Vector3, to: THREE.Vector3, entities: Damageable[]): { entity: Damageable; point: THREE.Vector3 } | null {
    if (entities.length === 0) return null;
    const length = from.distanceTo(to);
    const samples = Math.max(1, Math.ceil(length / 0.25));
    const point = new THREE.Vector3();
    for (let s = 1; s <= samples; s++) {
      point.lerpVectors(from, to, s / samples);
      for (const entity of entities) {
        if (entity.health > 0 && entity.checkBulletHit(point)) return { entity, point: point.clone() };
      }
    }
    return null;
  }

  private applySplashDamage(center: THREE.Vector3, damage: number, radius: number, entities: Damageable[]): void {
    for (const entity of entities) {
      if (entity.health <= 0) continue;
      const amount = splashDamage(damage, center.distanceTo(entity.group.position), radius);
      if (amount <= 0) continue;
      entity.takeDamage(amount, center);
      this.reticleRenderer.showHitmarker(entity.health <= 0);
    }
  }

  private updateAiming(delta: number): void {
    this.crosshairSpread = Math.max(0, this.crosshairSpread - 30 * delta);
    const totalSpread = this.crosshairSpread + this.movement.hSpeed() * (this.isADSActive() ? 0.1 : 0.3);
    if (!document.pointerLockElement) { this.reticleRenderer.hide(); return; }
    if (this.shouldShowSniperScope()) this.reticleRenderer.hide();
    else { this.reticleRenderer.setSpread(totalSpread); this.reticleRenderer.render(); this.reticleRenderer.show(); }
    if (this.gamepadLook.length() > 0.1) {
      const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const hits = raycaster.intersectObjects(this.getMeshes()); if (hits.length > 0 && hits[0].distance < 30) this.aimingSystem.assistAiming({ x: this.gamepadLook.x, y: this.gamepadLook.y });
    }
  }

  takeDamage(amount: number, sourcePosition?: THREE.Vector3) {
    if (this.health <= 0) return;
    this.timeSinceDamage = 0;
    this.health = Math.max(0, this.health - amount); soundManager.playSound('hit', 0.5);
    if (sourcePosition) this.radarRenderer.showDamageDirection(sourcePosition, this.group.position, this.euler.y);
  }

  /** Titanfall-style pilot regen: after a few seconds out of harm's way, health recovers quickly. */
  private regenerateHealth(delta: number): void {
    this.timeSinceDamage += delta;
    if (this.health > 0 && this.health < 100 && this.timeSinceDamage >= this.REGEN_DELAY) {
      this.health = Math.min(100, this.health + this.REGEN_RATE * delta);
    }
  }

  updateRadar(enemies: { position: THREE.Vector3; velocity?: THREE.Vector3 }[]): void { this.radarRenderer.updateEnemies(enemies, this.group.position, this.euler.y); }
  renderRadar(): void { this.radarRenderer.render(); }

  private shoot() {
    const weapon = this.activeWeapon; const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const startPos = this.getWeaponMuzzlePosition(aimDir);
    const pellets = weapon.bulletsPerShot, isADS = this.isADSActive(), spreadRad = (weapon.spread * (isADS ? 0.3 : 1.0) * Math.PI) / 180;
    const cameraAimPoint = this.getCameraAimPoint(weapon, aimDir);
    const damage = this.weaponManager.getEffectiveDamage(weapon);
    for (let p = 0; p < pellets; p++) {
      const shotDir = this.getShotDirection(weapon, aimDir, spreadRad, p, pellets);
      const pelletTarget = pellets > 1
        ? this.camera.position.clone().add(shotDir.clone().multiplyScalar(weapon.range))
        : cameraAimPoint;
      const velocity = this.getProjectileVelocity(weapon, startPos, shotDir, pelletTarget, isADS);
      const bullet = this.ballisticsSystem.createBullet(startPos, velocity, weapon.bulletVisuals);
      bullet.damage = damage;
      this.bullets.push(bullet);
    }
    const recoilMult = isADS ? 0.5 : 1.0;
    const recoil = this.weaponManager.getEffectiveRecoil(weapon);
    this.crosshairSpread = Math.min(12, this.crosshairSpread + recoil.y * 2 * recoilMult);
    this.weaponRecoilKick = Math.min(1, this.weaponRecoilKick + recoil.y * 0.25 * recoilMult);
    if (weapon.muzzleFlash) this.impactRenderer.spawnMuzzleFlash(startPos, aimDir, DEFAULT_MUZZLE_CONFIG);
    soundManager.playSound(weapon.soundId, 0.4);
    this.titanMeter = Math.min(100, this.titanMeter + 0.5); if (this.onTitanMeterChange) this.onTitanMeterChange(this.titanMeter);
  }

  private clearGrappleRope(): void {
    if (!this.grappleRope) return;
    this.scene.remove(this.grappleRope);
    this.grappleRope.geometry.dispose();
    (this.grappleRope.material as THREE.Material).dispose();
    this.grappleRope = null;
  }

  private createGrappleRope(): void {
    this.clearGrappleRope();
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.grappleRope = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(0, 0, 0.01)]),
        this.GRAPPLE_ROPE_SEGMENTS,
        this.GRAPPLE_ROPE_RADIUS,
        8,
        false,
      ),
      material,
    );
    this.grappleRope.userData.ignoreRaycast = true;
    this.scene.add(this.grappleRope);
  }

  private updateGrappleRope(start: THREE.Vector3, end: THREE.Vector3, slackAmount: number): void {
    if (!this.grappleRope) return;

    const distance = start.distanceTo(end);
    if (distance < 0.05) return;

    const dir = end.clone().sub(start).normalize();
    const mid = start.clone().lerp(end, 0.5);
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    else side.normalize();

    const sag = Math.min(1.35, Math.max(0.08, slackAmount));
    const bow = Math.min(0.32, distance * 0.015);
    const controlA = start.clone().lerp(mid, 0.45).add(new THREE.Vector3(0, -sag, 0)).add(side.clone().multiplyScalar(bow));
    const controlB = mid.clone().lerp(end, 0.55).add(new THREE.Vector3(0, -sag * 0.7, 0)).add(side.multiplyScalar(-bow * 0.6));
    const curve = new THREE.CatmullRomCurve3([start.clone(), controlA, controlB, end.clone()], false, 'centripetal');
    const segments = Math.max(this.GRAPPLE_ROPE_SEGMENTS, Math.min(32, Math.ceil(distance * 2.5)));
    const nextGeometry = new THREE.TubeGeometry(curve, segments, this.GRAPPLE_ROPE_RADIUS, 8, false);

    this.grappleRope.geometry.dispose();
    this.grappleRope.geometry = nextGeometry;
  }

  private cancelGrappleProjectile(applyCooldown: boolean): void {
    if (this.grappleProjectile) {
      this.scene.remove(this.grappleProjectile);
      this.grappleProjectile.geometry.dispose();
      (this.grappleProjectile.material as THREE.Material).dispose();
      this.grappleProjectile = null;
    }
    this.grappleProjectileActive = false;
    if (applyCooldown) this.grappleCooldown = this.GRAPPLE_COOLDOWN * 0.5;
    this.clearGrappleRope();
  }

  private toggleGrapple(): void {
    if (this.isPilotingTitan) return;
    if (this.isGrappling || this.grappleProjectileActive) {
      this.grappleKeyHeld = false;
      this.stopGrapple();
      return;
    }

    if (this.startGrapple()) {
      this.grappleKeyHeld = true;
    }
  }

  private startGrapple(): boolean {
    if (this.isGrappling || this.grappleCooldown > 0 || this.grappleProjectileActive) return false;
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera); raycaster.far = this.GRAPPLE_RANGE;
    const hits = raycaster.intersectObjects(this.getMeshes()); if (hits.length === 0) return false;
    const handOffset = new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion);
    const startPos = this.camera.position.clone().add(handOffset);
    this.grappleProjectile = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.9 }));
    this.grappleProjectile.position.copy(startPos);
    this.grappleProjectile.userData.ignoreRaycast = true;
    this.grappleProjectileVelocity = hits[0].point.clone().sub(startPos).normalize().multiplyScalar(this.GRAPPLE_PROJECTILE_SPEED);
    this.grappleProjectileActive = true;
    this.createGrappleRope();
    this.updateGrappleRope(startPos, this.grappleProjectile.position, 0.12);
    this.scene.add(this.grappleProjectile); this.updateWeaponHUD();
    return true;
  }

  private updateGrappleProjectile(delta: number): void {
    if (!this.grappleProjectileActive || !this.grappleProjectile) return;
    this.grappleProjectileVelocity.y += this.GRAPPLE_PROJECTILE_GRAVITY * delta;
    const oldPos = this.grappleProjectile.position.clone();
    this.grappleProjectile.position.add(this.grappleProjectileVelocity.clone().multiplyScalar(delta));
    if (this.grappleRope) {
      const ropeStart = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion));
      const ropeSlack = Math.max(0.08, ropeStart.distanceTo(this.grappleProjectile.position) * 0.02);
      this.updateGrappleRope(ropeStart, this.grappleProjectile.position, ropeSlack);
    }
    const dist = this.grappleProjectile.position.distanceTo(oldPos);
    if (dist > 0.01) {
      const raycaster = new THREE.Raycaster(oldPos, this.grappleProjectileVelocity.clone().normalize(), 0, dist + 0.1);
      const hits = raycaster.intersectObjects(this.getMeshes());
      if (hits.length > 0) {
        this.grappleTarget.copy(hits[0].point);
        this.scene.remove(this.grappleProjectile); this.grappleProjectile.geometry.dispose(); (this.grappleProjectile.material as THREE.Material).dispose(); this.grappleProjectile = null;
        this.grappleProjectileActive = false; this.startGrappleFromPoint(); return;
      }
    }
    if (this.grappleProjectile.position.distanceTo(this.camera.position) > this.GRAPPLE_RANGE) {
      this.grappleKeyHeld = false;
      this.cancelGrappleProjectile(true);
      this.updateWeaponHUD();
    }
  }

  private startGrappleFromPoint(): void {
    this.isGrappling = true;
    if (this.grapplePreviewLine) { this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null; }
    if (this.grappleRope) {
      (this.grappleRope.material as THREE.MeshBasicMaterial).opacity = 0.85;
      const ropeStart = this.group.position.clone().add(new THREE.Vector3(0, 0.3, 0));
      const ropeSlack = Math.max(0.12, ropeStart.distanceTo(this.grappleTarget) * 0.025);
      this.updateGrappleRope(ropeStart, this.grappleTarget, ropeSlack);
    }
    this.movement.isWallRunning = false; this.movement.isSliding = false; this.movement.isMantling = false;
    const toTarget = this.grappleTarget.clone().sub(this.group.position);
    if (toTarget.length() > 0.1) {
      const playerVel = this.movement.vel;
      const toTargetNorm = toTarget.clone().normalize();
      const inwardSpeed = playerVel.dot(toTargetNorm);
      const tangentialVel = playerVel.clone().sub(toTargetNorm.clone().multiplyScalar(inwardSpeed));

      this.movement.vel.copy(tangentialVel.multiplyScalar(this.GRAPPLE_TANGENT_BOOST));

      if (inwardSpeed > 0) {
        this.movement.vel.add(toTargetNorm.clone().multiplyScalar(inwardSpeed));
      }

      this.movement.vel.add(toTargetNorm.clone().multiplyScalar(this.GRAPPLE_INITIAL_BOOST));
    }
    soundManager.playSound('grapple', 0.4); this.updateWeaponHUD();
  }

  private stopGrapple(): void {
    if (this.grappleProjectileActive) {
      this.cancelGrappleProjectile(true);
      this.updateWeaponHUD();
      return;
    }
    if (!this.isGrappling) return;
    if (this.movement.vel.length() > 5) this.movement.vel.multiplyScalar(this.GRAPPLE_RELEASE_BOOST);
    this.isGrappling = false; this.grappleCooldown = this.GRAPPLE_COOLDOWN; this.grappleKeyHeld = false;
    this.clearGrappleRope();
    this.updateWeaponHUD();
  }

  getGrappleCooldownPercent(): number { return this.grappleCooldown <= 0 ? 0 : 1 - (this.grappleCooldown / this.GRAPPLE_COOLDOWN); }
  isGrappleReady(): boolean { return this.grappleCooldown <= 0; }

  private updateGrapple(delta: number): void {
    if (this.grappleCooldown > 0) this.grappleCooldown = Math.max(0, this.grappleCooldown - delta);
    if (this.grappleProjectileActive) { this.updateGrappleProjectile(delta); return; }
    if (!this.isGrappling) return;
    const m = this.movement, playerPos = this.group.position, toTarget = this.grappleTarget.clone().sub(playerPos), dist = toTarget.length();
    if (this.grappleRope) {
      const ropeStart = playerPos.clone().add(new THREE.Vector3(0, 0.3, 0));
      const ropeSlack = Math.max(0.05, (dist - this.GRAPPLE_SLACK_DISTANCE) * 0.18);
      this.updateGrappleRope(ropeStart, this.grappleTarget, ropeSlack);
    }
    if (dist < 2.0) { this.stopGrapple(); return; }
    if (this.jumpJustPressed) { this.jumpJustPressed = false; m.vel.y = Math.max(m.vel.y, 9); this.stopGrapple(); return; }
    if (!this.grappleKeyHeld) { this.stopGrapple(); return; }
    const dir = toTarget.clone().normalize();
    const slackRatio = THREE.MathUtils.clamp((dist - this.GRAPPLE_SLACK_DISTANCE) / 8, 0, 1);
    if (slackRatio > 0) {
      m.vel.add(dir.clone().multiplyScalar(this.GRAPPLE_PULL_ACCEL * slackRatio * delta));
    }

    const inwardSpeed = m.vel.dot(dir);
    if (slackRatio > 0 && inwardSpeed < 22) {
      m.vel.add(dir.clone().multiplyScalar((22 - inwardSpeed) * 0.12));
    }

    const tangentialVel = m.vel.clone().sub(dir.clone().multiplyScalar(m.vel.dot(dir)));
    if (slackRatio < 0.25 && tangentialVel.length() > 0.1) {
      const damp = Math.max(0, 1 - delta * 0.6);
      tangentialVel.multiplyScalar(damp);
      m.vel.copy(dir.clone().multiplyScalar(m.vel.dot(dir)).add(tangentialVel));
    }

    m.vel.y += this.GRAPPLE_HOLD_GRAVITY * delta;
    if (m.vel.length() > this.GRAPPLE_MAX_SPEED) m.vel.multiplyScalar(this.GRAPPLE_MAX_SPEED / m.vel.length());
  }

  private throwGrenade(): void {
    if (this.grenadeCooldown > 0 || this.grenadeCount <= 0) return;
    this.grenadeCount--; this.grenadeCooldown = 0.8; this.grenadeRegenTime = 0;
    const throwDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); throwDir.y += 0.3; throwDir.normalize();
    const startPos = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion));
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshStandardMaterial({ color: 0x44ff44, emissive: 0x44ff44, emissiveIntensity: 2 }));
    mesh.position.copy(startPos); mesh.userData.ignoreRaycast = true; this.scene.add(mesh);
    const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(60 * 3), 3)); trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.6 }));
    this.scene.add(trail); this.grenades.push({ mesh, velocity: throwDir.multiplyScalar(20), fuseTime: 2.0, bouncesLeft: 3, trail, trailPositions: [startPos.clone()] });
    this.updateWeaponHUD();
  }

  private updateGrenades(delta: number, targets: Damageable[], enemies: Damageable[]): void {
    if (this.grenadeCooldown > 0) this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    if (this.grenadeCount < this.maxGrenades) { this.grenadeRegenTime += delta; if (this.grenadeRegenTime >= this.GRENADE_REGEN_DURATION) { this.grenadeCount++; this.grenadeRegenTime = 0; this.updateWeaponHUD(); } }
    const worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets);
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i]; g.velocity.y -= 20 * delta; const prevPos = g.mesh.position.clone(); g.mesh.position.add(g.velocity.clone().multiplyScalar(delta));
      g.trailPositions.push(g.mesh.position.clone()); if (g.trailPositions.length > 20) g.trailPositions.shift();
      const trailArr = (g.trail.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      for (let j = 0; j < g.trailPositions.length; j++) { trailArr[j * 3] = g.trailPositions[j].x; trailArr[j * 3 + 1] = g.trailPositions[j].y; trailArr[j * 3 + 2] = g.trailPositions[j].z; }
      g.trail.geometry.attributes.position.needsUpdate = true; g.trail.geometry.setDrawRange(0, g.trailPositions.length);
      const step = g.mesh.position.clone().sub(prevPos), stepLen = step.length();
      if (stepLen > 1e-6) {
        const hits = new THREE.Raycaster(prevPos, step.clone().normalize(), 0, stepLen + 0.05).intersectObjects(worldMeshes, false);
        if (hits.length > 0) {
          const hit = hits[0]; g.mesh.position.copy(hit.point);
          const normal = hit.face ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld) : step.clone().normalize().negate();
          if (g.bouncesLeft > 0) { g.velocity.reflect(normal).multiplyScalar(0.5); g.bouncesLeft--; g.mesh.position.add(normal.clone().multiplyScalar(0.02)); } else g.velocity.set(0, 0, 0);
        }
      }
      g.fuseTime -= delta;
      if (g.fuseTime <= 0 || g.mesh.position.y < -20) {
        if (g.fuseTime <= 0) {
          const pos = g.mesh.position.clone(); this.impactRenderer.spawnExplosion(pos, FRAG_EXPLOSION_CONFIG); soundManager.playSound('explosion', 0.6);
          this.applySplashDamage(pos, 100, 6, [...targets, ...enemies]);
        }
        this.scene.remove(g.mesh); g.mesh.geometry.dispose(); (g.mesh.material as THREE.Material).dispose();
        this.scene.remove(g.trail); g.trail.geometry.dispose(); (g.trail.material as THREE.Material).dispose();
        this.grenades.splice(i, 1);
      }
    }
  }

  private updateGrenadeTrajectory(): void {
    if (!document.pointerLockElement) { if (this.grenadeTrajectoryLine) { this.scene.remove(this.grenadeTrajectoryLine); this.grenadeTrajectoryLine.geometry.dispose(); (this.grenadeTrajectoryLine.material as THREE.Material).dispose(); this.grenadeTrajectoryLine = null; } return; }
    if (!(this.grenadeHeld || this.gamepadGrenadeHeld) || this.grenadeCooldown > 0 || this.grenadeCount <= 0) { if (this.grenadeTrajectoryLine) { this.scene.remove(this.grenadeTrajectoryLine); this.grenadeTrajectoryLine.geometry.dispose(); (this.grenadeTrajectoryLine.material as THREE.Material).dispose(); this.grenadeTrajectoryLine = null; } return; }
    const throwDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); throwDir.y += 0.3; throwDir.normalize();
    const startPos = this.camera.position.clone().add(new THREE.Vector3(0.2, -0.15, -0.3).applyQuaternion(this.camera.quaternion));
    const vel = throwDir.clone().multiplyScalar(20), gravity = -20, worldMeshes = BallisticsSystem.getCollisionMeshes(this.scene, this.group, this.bullets), points: THREE.Vector3[] = [], pos = startPos.clone(), dt = 0.03;
    let bounces = 0;
    for (let i = 0; i < 150 && bounces <= 3; i++) {
      points.push(pos.clone()); const prevPos = pos.clone(); vel.y += gravity * dt; pos.add(vel.clone().multiplyScalar(dt));
      if (i < 3) continue;
      const stepLen = pos.distanceTo(prevPos);
      if (stepLen > 0.001) {
        const hits = new THREE.Raycaster(prevPos, pos.clone().sub(prevPos).normalize(), 0, stepLen + 0.05).intersectObjects(worldMeshes, false);
        if (hits.length > 0) {
          const hit = hits[0]; points.push(hit.point.clone());
          if (bounces < 3) { const normal = hit.face ? hit.face.normal.clone().transformDirection((hit.object as THREE.Mesh).matrixWorld) : pos.clone().sub(prevPos).normalize().negate(); vel.reflect(normal).multiplyScalar(0.5); pos.copy(hit.point).add(normal.multiplyScalar(0.02)); bounces++; } else break;
        }
      }
      if (pos.y < -10) break;
    }
    if (points.length < 2) points.push(startPos.clone().add(new THREE.Vector3(0, 0, -2).applyQuaternion(this.camera.quaternion)));
    if (this.grenadeTrajectoryLine) { this.scene.remove(this.grenadeTrajectoryLine); this.grenadeTrajectoryLine.geometry.dispose(); (this.grenadeTrajectoryLine.material as THREE.Material).dispose(); }
    this.grenadeTrajectoryLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x44ff44, transparent: true, opacity: 0.8, linewidth: 2 }));
    this.scene.add(this.grenadeTrajectoryLine);
  }

  private updateGrappleTrajectory(): void {
    if (!document.pointerLockElement) { if (this.grapplePreviewLine) { this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null; } return; }
    if (!(this.grappleKeyHeld && !this.isGrappling && !this.grappleProjectileActive && this.grappleCooldown <= 0)) { if (this.grapplePreviewLine) { this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null; } return; }
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera); raycaster.far = this.GRAPPLE_RANGE;
    const hits = raycaster.intersectObjects(this.getMeshes());
    if (hits.length > 0) {
      const start = this.group.position.clone().add(new THREE.Vector3(0, 0.3, 0)), end = hits[0].point.clone();
      if (this.grapplePreviewLine) { const posAttr = this.grapplePreviewLine.geometry.attributes.position as THREE.BufferAttribute; posAttr.setXYZ(0, start.x, start.y, start.z); posAttr.setXYZ(1, end.x, end.y, end.z); posAttr.needsUpdate = true; }
      else { this.grapplePreviewLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), new THREE.LineDashedMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.5, dashSize: 1, gapSize: 0.5 })); (this.grapplePreviewLine as THREE.Line).computeLineDistances(); this.scene.add(this.grapplePreviewLine); }
    } else if (this.grapplePreviewLine) {
      this.scene.remove(this.grapplePreviewLine); this.grapplePreviewLine.geometry.dispose(); (this.grapplePreviewLine.material as THREE.Material).dispose(); this.grapplePreviewLine = null;
    }
  }

  private baseFOV = 75;
  private adsFOV = 45;
  private currentFOV = 75;
  private syncCamera() {
    this.camera.quaternion.setFromEuler(this.euler); this.camera.position.copy(this.group.position); this.camera.position.y += 0.5;
    const isADS = this.isADSActive(), targetFOV = isADS ? (this.activeWeapon.name === 'Kraber' ? 20 : this.adsFOV) : this.baseFOV;
    this.currentFOV += (targetFOV - this.currentFOV) * 0.15; this.camera.fov = this.currentFOV; this.camera.updateProjectionMatrix();
    if (this.weaponMesh) {
      this.weaponMesh.visible = !this.shouldShowSniperScope();
      const target = isADS ? this.getADSViewOffset() : this.hipfirePos.clone(), speed = this.movement.hSpeed();
      if (speed > 1 && this.movement.isGrounded) { const bobFreq = isADS ? 6 : 10, bobAmpX = isADS ? 0.002 : 0.008, bobAmpY = isADS ? 0.002 : 0.006; this.weaponBobTime += speed * 0.06; target.x += Math.sin(this.weaponBobTime * bobFreq) * bobAmpX; target.y += Math.abs(Math.sin(this.weaponBobTime * bobFreq * 0.5)) * bobAmpY; }
      else this.weaponBobTime *= 0.95;
      const swayAmount = isADS ? 0.0005 : 0.002 * this.activeWeapon.accuracy, t = performance.now() * 0.001;
      this.weaponSwayX += (Math.sin(t * 1.1) * swayAmount - this.weaponSwayX) * 0.05; this.weaponSwayY += (Math.cos(t * 0.9) * swayAmount - this.weaponSwayY) * 0.05;
      target.x += this.weaponSwayX; target.y += this.weaponSwayY;
      this.weaponRecoilKick *= 0.85; target.z += this.weaponRecoilKick * 0.06; target.y += this.weaponRecoilKick * 0.01;
      this.weaponViewOffset.lerp(target, 0.15); this.syncWeaponMeshToCamera();
    }
  }

  private updateWeaponHUD(): void {
    const legacyHud = document.getElementById('weapon-hud');
    legacyHud?.remove();
  }

  getWeaponHUDData(): WeaponHUDData {
    const ammo = this.weaponManager.getCurrentAmmo();
    const magazineSize = this.weaponManager.getEffectiveMagazineSize(this.activeWeapon);
    const isReloading = this.weaponManager.isReloading();
    const grappleReady = this.grappleCooldown <= 0 && !this.grappleProjectileActive;
    const accentColor = '#' + this.activeWeapon.bulletVisuals.color.toString(16).padStart(6, '0');

    return {
      weaponName: this.activeWeapon.name,
      ammo,
      magazineSize,
      isReloading,
      reloadProgress: this.weaponManager.getReloadProgress(),
      accentColor,
      weaponSlots: this.weaponManager.getAllWeapons().map((weapon, index) => ({
        index,
        name: weapon.name,
        active: index === this.weaponManager.getCurrentIndex(),
      })),
      attachments: [
        this.activeWeapon.attachments.optic?.name,
        this.activeWeapon.attachments.barrel?.name,
        this.activeWeapon.attachments.magazine?.name,
      ].filter((attachment): attachment is string => Boolean(attachment)),
      grenadeCount: this.grenadeCount,
      grappleLabel: this.isGrappling
        ? 'GRAPPLING'
        : this.grappleProjectileActive
          ? 'HOOKING...'
          : grappleReady
            ? 'READY'
            : `${this.grappleCooldown.toFixed(1)}s`,
      grappleColor: this.isGrappling ? '#00ffcc' : grappleReady ? '#88cc88' : '#666666',
      grappleProgress: grappleReady ? 1 : Math.max(0.05, 1 - this.grappleCooldown / this.GRAPPLE_COOLDOWN),
    };
  }

  getDebugHUDData(): DebugHUDData {
    const movementState = this.movement.isMantling
      ? "MANTLE"
      : this.movement.isSliding
        ? "SLIDE"
        : this.movement.isWallRunning
          ? "WALLRUN"
          : this.movement.isGrounded
            ? "GROUND"
            : "AIR";

    return {
      speed: this.movement.hSpeed(),
      movementState,
      velocity: {
        x: this.movement.vel.x,
        y: this.movement.vel.y,
        z: this.movement.vel.z,
      },
      jumpCount: this.movement.jumpCount,
      sprinting: this.keys.sprint || this.gamepadSprint,
      crouching: this.keys.crouch || this.gamepadCrouch,
    };
  }

  private updateUI() {
    const legacyDebug = document.getElementById("debug-speed");
    legacyDebug?.remove();
  }
}

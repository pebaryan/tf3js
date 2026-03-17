export type AttachmentType = 'optic' | 'magazine' | 'barrel' | 'stock';

export interface Attachment {
  id: string;
  name: string;
  type: AttachmentType;
  description: string;
  modifiers?: {
    recoilMult?: number;
    reloadTimeMult?: number;
    magSizeBonus?: number;
    accuracyMult?: number;
    zoomMult?: number;
    damageMult?: number;
  };
}

export const ATTACHMENTS: Record<string, Attachment> = {
  // Optics
  'hcog': { id: 'hcog', name: 'HCog', type: 'optic', description: 'Red dot sight. 1.2x zoom.', modifiers: { zoomMult: 1.2 } },
  'ranger': { id: 'ranger', name: 'HCOG Ranger', type: 'optic', description: 'Enhanced zoom optic. 2.0x zoom.', modifiers: { zoomMult: 2.0, accuracyMult: 0.8 } },
  'threat': { id: 'threat', name: 'Threat Scope', type: 'optic', description: 'Thermal optic. Highlights targets. 1.5x zoom.', modifiers: { zoomMult: 1.5 } },
  
  // Magazines
  'extended_mag': { id: 'extended_mag', name: 'Extended Mag', type: 'magazine', description: 'Increases magazine capacity.', modifiers: { magSizeBonus: 8 } },
  'fast_mag': { id: 'fast_mag', name: 'Quick Reload', type: 'magazine', description: 'Faster reload speeds.', modifiers: { reloadTimeMult: 0.7 } },
  
  // Barrels
  'stabilizer': { id: 'stabilizer', name: 'Stabilizer', type: 'barrel', description: 'Reduces recoil.', modifiers: { recoilMult: 0.7 } },
  'suppressor': { id: 'suppressor', name: 'Suppressor', type: 'barrel', description: 'Reduced muzzle flash and sound.', modifiers: { recoilMult: 1.1, damageMult: 0.9 } },
};

export interface BulletVisuals {
  meshType: 'capsule' | 'sphere';
  color: number;
  radius: number;
  length: number; // only used for capsule
  hasTrail: boolean;
  trailColor: number;
  trailLength: number; // max trail positions
  gravity: number; // per-second gravity applied to velocity.y (0 = straight, negative = drop)
  maxLifetime: number; // seconds before forced removal
  explosive: boolean; // triggers explosion on impact
  splashRadius: number; // radius of splash damage (0 = no splash)
}

export interface Weapon {
  name: string;
  damage: number;
  range: number;
  recoil: { x: number; y: number; z: number };
  accuracy: number; // 0.0-1.0, lower = more stable
  bulletSpeed: number;
  fireRate: number; // milliseconds between shots
  spread: number; // degrees
  bulletsPerShot: number; // 1 for single, >1 for shotgun
  magazineSize: number;
  reloadTime: number; // milliseconds
  muzzleFlash: boolean;
  soundId: string;
  bulletVisuals: BulletVisuals;
  attachments: {
    optic?: Attachment;
    magazine?: Attachment;
    barrel?: Attachment;
    stock?: Attachment;
  };
}

// --- Pilot weapons ---

// R-201: Versatile assault rifle, the baseline. ~810 RPM, balanced stats.
export const R201_WEAPON: Weapon = {
  name: 'R-201',
  damage: 25,
  range: 200,
  recoil: { x: 0.3, y: 0.8, z: 0 },
  accuracy: 0.15,
  bulletSpeed: 180,
  fireRate: 74,   // ~810 RPM
  spread: 1.5,
  bulletsPerShot: 1,
  magazineSize: 24,
  reloadTime: 1800,
  muzzleFlash: true,
  soundId: 'rifle_fire',
  bulletVisuals: {
    meshType: 'capsule',
    color: 0x00ffcc,
    radius: 0.02,
    length: 0.08,
    hasTrail: true,
    trailColor: 0x00ffcc,
    trailLength: 20,
    gravity: -10,
    maxLifetime: 3,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// EVA-8: Auto shotgun. Fast fire for a shotgun, wide spread, short range.
export const EVA8_WEAPON: Weapon = {
  name: 'EVA-8',
  damage: 12,
  range: 30,
  recoil: { x: 1.2, y: 2.5, z: 0 },
  accuracy: 0.6,
  bulletSpeed: 95,
  fireRate: 400,
  spread: 8,
  bulletsPerShot: 8,
  magazineSize: 6,
  reloadTime: 2200,
  muzzleFlash: true,
  soundId: 'shotgun_fire',
  bulletVisuals: {
    meshType: 'sphere',
    color: 0xff8844,
    radius: 0.015,
    length: 0,
    hasTrail: false,
    trailColor: 0xff8844,
    trailLength: 0,
    gravity: -6,     // pellets still fall off, but not before practical shotgun range
    maxLifetime: 0.8,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// Kraber: Anti-materiel sniper. Bolt-action, one-shot kill, heavy bullet drop at range.
export const KRABER_WEAPON: Weapon = {
  name: 'Kraber',
  damage: 100,
  range: 500,
  recoil: { x: 0.5, y: 4.0, z: 0 },
  accuracy: 0.02,
  bulletSpeed: 300,
  fireRate: 1500,
  spread: 0.2,
  bulletsPerShot: 1,
  magazineSize: 4,
  reloadTime: 3000,
  muzzleFlash: true,
  soundId: 'sniper_fire',
  bulletVisuals: {
    meshType: 'capsule',
    color: 0xff2266,
    radius: 0.03,
    length: 0.15,
    hasTrail: true,
    trailColor: 0xff4488,
    trailLength: 30,
    gravity: -8,
    maxLifetime: 5,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// EPG-1: Energy grenade launcher. Slow projectile, splash damage, straight trajectory.
export const EPG_WEAPON: Weapon = {
  name: 'EPG-1',
  damage: 80,
  range: 100,
  recoil: { x: 0.2, y: 1.5, z: 0 },
  accuracy: 0.05,
  bulletSpeed: 40,
  fireRate: 900,
  spread: 0,
  bulletsPerShot: 1,
  magazineSize: 5,
  reloadTime: 2500,
  muzzleFlash: true,
  soundId: 'grenade_fire',
  bulletVisuals: {
    meshType: 'sphere',
    color: 0x44aaff,
    radius: 0.08,
    length: 0,
    hasTrail: true,
    trailColor: 0x2288ff,
    trailLength: 40,
    gravity: 0,
    maxLifetime: 4,
    explosive: true,
    splashRadius: 5,
  },
  attachments: {},
};

// Alternator: Slow-firing SMG with high damage per bullet. ~360 RPM, punchy.
export const ALTERNATOR_WEAPON: Weapon = {
  name: 'Alternator',
  damage: 35,
  range: 120,
  recoil: { x: 0.6, y: 1.0, z: 0 },
  accuracy: 0.18,
  bulletSpeed: 165,
  fireRate: 167,   // ~360 RPM — slow but hits hard
  spread: 2.0,
  bulletsPerShot: 1,
  magazineSize: 20,
  reloadTime: 1600,
  muzzleFlash: true,
  soundId: 'rifle_fire',
  bulletVisuals: {
    meshType: 'capsule',
    color: 0xffaa00,
    radius: 0.02,
    length: 0.06,
    hasTrail: true,
    trailColor: 0xffaa00,
    trailLength: 15,
    gravity: -11,
    maxLifetime: 2.5,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// CAR: High fire rate SMG, very accurate, low damage per shot. ~900 RPM.
export const CAR_WEAPON: Weapon = {
  name: 'CAR',
  damage: 18,
  range: 140,
  recoil: { x: 0.25, y: 0.5, z: 0 },
  accuracy: 0.12,
  bulletSpeed: 185,
  fireRate: 67,    // ~900 RPM — bullet hose
  spread: 2.0,
  bulletsPerShot: 1,
  magazineSize: 25,
  reloadTime: 1500,
  muzzleFlash: true,
  soundId: 'rifle_fire',
  bulletVisuals: {
    meshType: 'capsule',
    color: 0x66ffcc,
    radius: 0.018,
    length: 0.06,
    hasTrail: true,
    trailColor: 0x66ffcc,
    trailLength: 18,
    gravity: -9,
    maxLifetime: 2.5,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// Flatline: Heavy AR. Higher damage than R-201, more horizontal recoil, slower fire. ~540 RPM.
export const FLATLINE_WEAPON: Weapon = {
  name: 'Flatline',
  damage: 30,
  range: 180,
  recoil: { x: 1.0, y: 1.0, z: 0 },  // more horizontal kick than R-201
  accuracy: 0.22,
  bulletSpeed: 170,
  fireRate: 111,   // ~540 RPM
  spread: 2.0,
  bulletsPerShot: 1,
  magazineSize: 20,
  reloadTime: 2000,
  muzzleFlash: true,
  soundId: 'rifle_fire',
  bulletVisuals: {
    meshType: 'capsule',
    color: 0xff4400,
    radius: 0.025,
    length: 0.08,
    hasTrail: true,
    trailColor: 0xff4400,
    trailLength: 18,
    gravity: -12,
    maxLifetime: 3,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// Mastiff: Energy shotgun. Horizontal spread, slow fire, devastating up close.
export const MASTIFF_WEAPON: Weapon = {
  name: 'Mastiff',
  damage: 18,
  range: 25,
  recoil: { x: 1.5, y: 3.0, z: 0 },
  accuracy: 0.5,
  bulletSpeed: 70,
  fireRate: 600,
  spread: 12,
  bulletsPerShot: 6,
  magazineSize: 4,
  reloadTime: 2800,
  muzzleFlash: true,
  soundId: 'shotgun_fire',
  bulletVisuals: {
    meshType: 'sphere',
    color: 0x88ccff,
    radius: 0.02,
    length: 0,
    hasTrail: true,
    trailColor: 0x88ccff,
    trailLength: 8,
    gravity: -8,     // energy pellets, less drop than ballistic
    maxLifetime: 0.6,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// Wingman Elite: Heavy revolver. High damage, slow fire, precise. ~240 RPM.
export const WINGMAN_WEAPON: Weapon = {
  name: 'Wingman',
  damage: 55,
  range: 250,
  recoil: { x: 0.4, y: 2.5, z: 0 },
  accuracy: 0.05,
  bulletSpeed: 220,
  fireRate: 250,   // ~240 RPM — deliberate, rewarding shots
  spread: 0.5,
  bulletsPerShot: 1,
  magazineSize: 6,
  reloadTime: 2000,
  muzzleFlash: true,
  soundId: 'sniper_fire',
  bulletVisuals: {
    meshType: 'capsule',
    color: 0xff6644,
    radius: 0.025,
    length: 0.1,
    hasTrail: true,
    trailColor: 0xff8866,
    trailLength: 12,
    gravity: -10,
    maxLifetime: 3,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// L-STAR: Energy LMG. Large slow projectiles, no bullet drop, high spread. ~480 RPM.
export const LSTAR_WEAPON: Weapon = {
  name: 'L-STAR',
  damage: 22,
  range: 100,
  recoil: { x: 0.3, y: 0.4, z: 0 },
  accuracy: 0.3,
  bulletSpeed: 60,
  fireRate: 125,   // ~480 RPM
  spread: 3.0,
  bulletsPerShot: 1,
  magazineSize: 40,
  reloadTime: 2500,
  muzzleFlash: true,
  soundId: 'grenade_fire',
  bulletVisuals: {
    meshType: 'sphere',
    color: 0x22ff44,
    radius: 0.06,
    length: 0,
    hasTrail: true,
    trailColor: 0x44ff66,
    trailLength: 25,
    gravity: 0,      // energy orbs, no drop
    maxLifetime: 2,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

// --- Pilot weapon loadout ---

export const PILOT_WEAPONS: Weapon[] = [
  R201_WEAPON,
  EVA8_WEAPON,
  KRABER_WEAPON,
  EPG_WEAPON,
  ALTERNATOR_WEAPON,
  CAR_WEAPON,
  FLATLINE_WEAPON,
  MASTIFF_WEAPON,
  WINGMAN_WEAPON,
  LSTAR_WEAPON,
];

// --- Titan weapon ---

export const TITAN_WEAPON: Weapon = {
  name: 'XO-16',
  damage: 35,
  range: 500,
  recoil: { x: 0.1, y: 0.3, z: 0 },
  accuracy: 0.1,
  bulletSpeed: 150,
  fireRate: 150,
  spread: 0.5,
  bulletsPerShot: 1,
  magazineSize: 100,
  reloadTime: 2000,
  muzzleFlash: true,
  soundId: 'titan_fire',
  bulletVisuals: {
    meshType: 'sphere',
    color: 0xff6600,
    radius: 0.2,
    length: 0,
    hasTrail: false,
    trailColor: 0xff6600,
    trailLength: 0,
    gravity: 0,
    maxLifetime: 3,
    explosive: false,
    splashRadius: 0,
  },
  attachments: {},
};

export class WeaponManager {
  private weapons: Weapon[] = [];
  private currentIndex = 0;
  private ammo: number[] = [];
  private reloading = false;
  private reloadTimer = 0;

  addWeapon(weapon: Weapon): Weapon {
    this.weapons.push(weapon);
    this.ammo.push(this.getEffectiveMagazineSize(weapon));
    return weapon;
  }

  addWeapons(weapons: Weapon[]): void {
    for (const w of weapons) this.addWeapon(w);
  }

  getCurrentWeapon(): Weapon | null {
    return this.weapons[this.currentIndex] ?? null;
  }

  switchTo(index: number): Weapon | null {
    if (index >= 0 && index < this.weapons.length) {
      this.currentIndex = index;
      return this.weapons[index];
    }
    return null;
  }

  nextWeapon(): Weapon | null {
    if (this.weapons.length === 0) return null;
    this.currentIndex = (this.currentIndex + 1) % this.weapons.length;
    return this.weapons[this.currentIndex];
  }

  prevWeapon(): Weapon | null {
    if (this.weapons.length === 0) return null;
    this.currentIndex = (this.currentIndex - 1 + this.weapons.length) % this.weapons.length;
    return this.weapons[this.currentIndex];
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getWeaponCount(): number {
    return this.weapons.length;
  }

  getWeaponByName(name: string): Weapon | null {
    return this.weapons.find(w => w.name === name) ?? null;
  }

  getAllWeapons(): Weapon[] {
    return this.weapons;
  }

  replaceWeapon(index: number, newWeapon: Weapon): Weapon | null {
    if (index < 0 || index >= this.weapons.length) return null;
    const old = this.weapons[index];
    this.weapons[index] = newWeapon;
    this.ammo[index] = this.getEffectiveMagazineSize(newWeapon);
    this.cancelReload();
    return old;
  }

  // --- Attachment Support ---

  attach(index: number, attachment: Attachment): void {
    const weapon = this.weapons[index];
    if (!weapon) return;
    weapon.attachments[attachment.type] = attachment;
    // Cap ammo to new magazine size if needed
    const newMax = this.getEffectiveMagazineSize(weapon);
    if (this.ammo[index] > newMax) this.ammo[index] = newMax;
  }

  detach(index: number, type: AttachmentType): void {
    const weapon = this.weapons[index];
    if (!weapon) return;
    delete weapon.attachments[type];
    const newMax = this.getEffectiveMagazineSize(weapon);
    if (this.ammo[index] > newMax) this.ammo[index] = newMax;
  }

  // --- Effective Stat Helpers ---

  getEffectiveRecoil(weapon: Weapon): { x: number, y: number, z: number } {
    let mult = 1.0;
    if (weapon.attachments.barrel?.modifiers?.recoilMult) mult *= weapon.attachments.barrel.modifiers.recoilMult;
    if (weapon.attachments.stock?.modifiers?.recoilMult) mult *= weapon.attachments.stock.modifiers.recoilMult;
    return { x: weapon.recoil.x * mult, y: weapon.recoil.y * mult, z: weapon.recoil.z * mult };
  }

  getEffectiveReloadTime(weapon: Weapon): number {
    let mult = 1.0;
    if (weapon.attachments.magazine?.modifiers?.reloadTimeMult) mult *= weapon.attachments.magazine.modifiers.reloadTimeMult;
    return weapon.reloadTime * mult;
  }

  getEffectiveMagazineSize(weapon: Weapon): number {
    let bonus = 0;
    if (weapon.attachments.magazine?.modifiers?.magSizeBonus) bonus += weapon.attachments.magazine.modifiers.magSizeBonus;
    return weapon.magazineSize + bonus;
  }

  getEffectiveZoom(weapon: Weapon): number {
    if (weapon.attachments.optic?.modifiers?.zoomMult) return weapon.attachments.optic.modifiers.zoomMult;
    return 1.0;
  }

  getEffectiveAccuracy(weapon: Weapon): number {
    let mult = 1.0;
    if (weapon.attachments.optic?.modifiers?.accuracyMult) mult *= weapon.attachments.optic.modifiers.accuracyMult;
    if (weapon.attachments.stock?.modifiers?.accuracyMult) mult *= weapon.attachments.stock.modifiers.accuracyMult;
    return weapon.accuracy * mult;
  }

  // --- Ammo & Reload ---

  getCurrentAmmo(): number {
    return this.ammo[this.currentIndex] ?? 0;
  }

  consumeAmmo(count: number = 1): boolean {
    if (this.reloading) return false;
    if (this.ammo[this.currentIndex] < count) return false;
    this.ammo[this.currentIndex] -= count;
    return true;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  startReload(): boolean {
    const w = this.weapons[this.currentIndex];
    if (!w) return false;
    if (this.reloading) return false;
    const max = this.getEffectiveMagazineSize(w);
    if (this.ammo[this.currentIndex] >= max) return false;
    this.reloading = true;
    this.reloadTimer = this.getEffectiveReloadTime(w);
    return true;
  }

  cancelReload(): void {
    this.reloading = false;
    this.reloadTimer = 0;
  }

  updateReload(deltaMs: number): boolean {
    if (!this.reloading) return false;
    this.reloadTimer -= deltaMs;
    if (this.reloadTimer <= 0) {
      this.reloading = false;
      this.reloadTimer = 0;
      const w = this.weapons[this.currentIndex];
      if (w) this.ammo[this.currentIndex] = this.getEffectiveMagazineSize(w);
      return true; // reload finished
    }
    return false;
  }

  getReloadProgress(): number {
    if (!this.reloading) return 1;
    const w = this.weapons[this.currentIndex];
    if (!w) return 1;
    return 1 - this.reloadTimer / this.getEffectiveReloadTime(w);
  }
}

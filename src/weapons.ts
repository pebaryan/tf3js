export interface BulletVisuals {
  meshType: 'capsule' | 'sphere';
  color: number;
  radius: number;
  length: number; // only used for capsule
  hasTrail: boolean;
  trailColor: number;
  trailLength: number; // max trail positions
  gravity: number; // per-frame gravity, e.g. -35 for player, 0 for titan
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
  trajectory: 'straight' | 'parabolic';
  spread: number; // degrees
  bulletsPerShot: number; // 1 for single, >1 for shotgun
  magazineSize: number;
  reloadTime: number; // milliseconds
  muzzleFlash: boolean;
  soundId: string;
  bulletVisuals: BulletVisuals;
}

// --- Pilot weapons ---

export const R201_WEAPON: Weapon = {
  name: 'R-201',
  damage: 25,
  range: 200,
  recoil: { x: 0.3, y: 0.8, z: 0 },
  accuracy: 0.15,
  bulletSpeed: 120,
  fireRate: 100,
  trajectory: 'parabolic',
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
    gravity: -35,
    maxLifetime: 3,
    explosive: false,
    splashRadius: 0,
  },
};

export const EVA8_WEAPON: Weapon = {
  name: 'EVA-8',
  damage: 12,
  range: 30,
  recoil: { x: 1.2, y: 2.5, z: 0 },
  accuracy: 0.6,
  bulletSpeed: 80,
  fireRate: 400,
  trajectory: 'straight',
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
    gravity: -20,
    maxLifetime: 0.8,
    explosive: false,
    splashRadius: 0,
  },
};

export const KRABER_WEAPON: Weapon = {
  name: 'Kraber',
  damage: 100,
  range: 500,
  recoil: { x: 0.5, y: 4.0, z: 0 },
  accuracy: 0.02,
  bulletSpeed: 250,
  fireRate: 1500,
  trajectory: 'parabolic',
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
    gravity: -15,
    maxLifetime: 5,
    explosive: false,
    splashRadius: 0,
  },
};

export const EPG_WEAPON: Weapon = {
  name: 'EPG-1',
  damage: 80,
  range: 100,
  recoil: { x: 0.2, y: 1.5, z: 0 },
  accuracy: 0.05,
  bulletSpeed: 40,
  fireRate: 900,
  trajectory: 'parabolic',
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
    gravity: -12,
    maxLifetime: 4,
    explosive: true,
    splashRadius: 5,
  },
};

// --- Pilot weapon loadout ---

export const PILOT_WEAPONS: Weapon[] = [
  R201_WEAPON,
  EVA8_WEAPON,
  KRABER_WEAPON,
  EPG_WEAPON,
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
  trajectory: 'straight',
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
};

export class WeaponManager {
  private weapons: Weapon[] = [];
  private currentIndex = 0;
  private ammo: number[] = [];
  private reloading = false;
  private reloadTimer = 0;

  addWeapon(weapon: Weapon): Weapon {
    this.weapons.push(weapon);
    this.ammo.push(weapon.magazineSize);
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
    this.ammo[index] = newWeapon.magazineSize;
    this.cancelReload();
    return old;
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
    if (this.reloading) return false;
    const w = this.weapons[this.currentIndex];
    if (!w || this.ammo[this.currentIndex] >= w.magazineSize) return false;
    this.reloading = true;
    this.reloadTimer = w.reloadTime;
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
      if (w) this.ammo[this.currentIndex] = w.magazineSize;
      return true; // reload finished
    }
    return false;
  }

  getReloadProgress(): number {
    if (!this.reloading) return 1;
    const w = this.weapons[this.currentIndex];
    if (!w) return 1;
    return 1 - this.reloadTimer / w.reloadTime;
  }
}

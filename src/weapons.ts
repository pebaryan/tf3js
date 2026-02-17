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
}

export interface Weapon {
  name: string;
  damage: number;
  range: number;
  recoil: { x: number; y: number; z: number };
  accuracy: number; // 0.0-1.0, lower = more stable
  bulletSpeed: number;
  trajectory: 'straight' | 'parabolic';
  spread: number; // degrees
  magazineSize: number;
  muzzleFlash: boolean;
  soundId: string;
  bulletVisuals: BulletVisuals;
}

export const R201_WEAPON: Weapon = {
  name: 'R-201',
  damage: 25,
  range: 200,
  recoil: { x: 0.3, y: 0.8, z: 0 },
  accuracy: 0.15,
  bulletSpeed: 120,
  trajectory: 'parabolic',
  spread: 1.5,
  magazineSize: 24,
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
  },
};

export const TITAN_WEAPON: Weapon = {
  name: 'XO-16',
  damage: 35,
  range: 500,
  recoil: { x: 0.1, y: 0.3, z: 0 },
  accuracy: 0.1,
  bulletSpeed: 150,
  trajectory: 'straight',
  spread: 0.5,
  magazineSize: 100,
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
  },
};

export class WeaponManager {
  private weapons: Weapon[] = [];

  addWeapon(weapon: Weapon): Weapon {
    this.weapons.push(weapon);
    return weapon;
  }

  getCurrentWeapon(): Weapon | null {
    return this.weapons[0] ?? null;
  }

  getWeaponByName(name: string): Weapon | null {
    return this.weapons.find(w => w.name === name) ?? null;
  }

  getAllWeapons(): Weapon[] {
    return this.weapons;
  }
}

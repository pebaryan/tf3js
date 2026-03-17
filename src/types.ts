export enum GameState {
  MAIN_MENU = 'main_menu',
  PLAYING = 'playing',
  PAUSED = 'paused',
  LEVEL_COMPLETE = 'level_complete',
  GAME_OVER = 'game_over'
}

export interface GameStats {
  level: number;
  score: number;
  kills: number;
  time: number;
  objectivesCompleted: number;
  titanMeter: number;
  health: number;
}

export interface WeaponSlotHUDData {
  index: number;
  name: string;
  active: boolean;
}

export interface WeaponHUDData {
  weaponName: string;
  ammo: number;
  magazineSize: number;
  isReloading: boolean;
  reloadProgress: number;
  accentColor: string;
  weaponSlots: WeaponSlotHUDData[];
  attachments: string[];
  grenadeCount: number;
  grappleLabel: string;
  grappleColor: string;
  grappleProgress: number;
}

export interface DebugHUDData {
  speed: number;
  movementState: string;
  velocity: {
    x: number;
    y: number;
    z: number;
  };
  jumpCount: number;
  sprinting: boolean;
  crouching: boolean;
}

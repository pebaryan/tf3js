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

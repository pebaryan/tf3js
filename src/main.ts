import { Game } from './game';
import { GameState } from './types';
import { getBindings } from './keybindings';

// Initialize the game
document.addEventListener('DOMContentLoaded', () => {
  const game = new Game('game-container');

  // In-game shortcut keys (restart / return to menu)
  document.addEventListener('keydown', (e) => {
    if (game['state'] === GameState.PLAYING) {
      const b = getBindings();
      if (e.code === b.restart) {
        game['startGame'](game['currentLevel']?.id || 1);
      } else if (e.code === b.mainMenu) {
        game['showMainMenu']();
      }
    }
  });
});
import { Game } from './game';
import { GameState } from './types';
import { getBindings } from './keybindings';

// Initialize the game
document.addEventListener('DOMContentLoaded', () => {
  const game = new Game('game-container');
  if (import.meta.env.DEV) {
    // Handy for poking at state from the devtools console / browser tests (dev server only)
    (window as unknown as { __game: Game }).__game = game;
  }

  // In-game shortcut keys (restart / return to menu)
  document.addEventListener('keydown', (e) => {
    if (e.repeat || game.state !== GameState.PLAYING) return;
    const b = getBindings();
    if (e.code === b.restart) {
      game.restartLevel();
    } else if (e.code === b.mainMenu) {
      game.showMainMenu();
    }
  });
});

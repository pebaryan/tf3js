import { Game, GameState } from './game';

// Initialize the game
document.addEventListener('DOMContentLoaded', () => {
  const game = new Game('game-container');
  
  // Add event listeners for pause controls
  document.addEventListener('keydown', (e) => {
    if (game['state'] === GameState.PLAYING) {
      if (e.key === 'r' || e.key === 'R') {
        game['startGame'](game['currentLevel']?.id || 1);
      } else if (e.key === 'm' || e.key === 'M') {
        game['showMainMenu']();
      }
    }
  });
});
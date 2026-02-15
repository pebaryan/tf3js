# Titanfall 3JS

A browser-based 3D first-person shooter inspired by Titanfall, built with Three.js and Cannon.js physics engine.

## Demo

[![Watch the demo](https://img.youtube.com/vi/l3LYOUOZzCk/0.jpg)](https://www.youtube.com/watch?v=l3LYOUOZzCk)

Click the image above to watch a gameplay demo on YouTube.

## Features

- **First-person shooter gameplay** with smooth movement and aiming
- **Parkour mechanics** including wall-running and double-jumping
- **Physics-based interactions** powered by Cannon.js
- **Multiple levels** with increasing difficulty
- **Score system** with accuracy tracking
- **Responsive controls** with mouse and keyboard support

## Controls

| Key | Action |
|-----|--------|
| `W` `A` `S` `D` | Move |
| `SPACE` | Jump / Wall-run |
| `SHIFT` | Sprint |
| `MOUSE` | Aim |
| `CLICK` | Shoot |
| `R` | Restart level (during gameplay) |
| `M` | Return to menu (during gameplay) |

## Tech Stack

- **Three.js** - 3D rendering
- **Cannon-es** - Physics engine
- **TypeScript** - Type-safe JavaScript
- **Vite** - Build tool and dev server

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <repository-url>

# Navigate to project directory
cd titanfall-3js

# Install dependencies
npm install

# Start development server
npm run dev
```

The game will be available at `http://localhost:5173`

### Building for Production

```bash
npm run build
```

This will create an optimized build in the `dist/` directory.

## Project Structure

```
titanfall-3js/
├── src/
│   ├── game.ts      # Main game logic and state management
│   ├── player.ts    # Player mechanics and controls
│   ├── level.ts     # Level loading and management
│   ├── target.ts    # Target/enemy entities
│   ├── sound.ts     # Audio management
│   └── main.ts      # Entry point
├── dist/            # Production build
├── index.html       # HTML entry point
├── package.json     # Dependencies and scripts
└── tsconfig.json    # TypeScript configuration
```

## Game Mechanics

### Movement
- **Sprint**: Hold SHIFT while moving for increased speed
- **Jump**: Press SPACE to jump
- **Double Jump**: Press SPACE again while in mid-air
- **Wall-run**: Jump towards a wall and hold SPACE to run along it

### Shooting
- Aim with your mouse
- Click to shoot projectiles
- Targets will be destroyed on hit

### Scoring
- Earn points by destroying targets
- Accuracy affects your final score
- Complete levels to unlock new challenges

## Development

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally

### Adding New Levels

1. Create a new level configuration in `src/level.ts`
2. Define target positions, wall placements, and objectives
3. Add the level to the level registry

## License

MIT License - feel free to use this project for learning or as a base for your own games.

## Acknowledgments

- Inspired by Respawn Entertainment's Titanfall series
- Built with Three.js and the amazing web graphics community
- Physics powered by Cannon.js

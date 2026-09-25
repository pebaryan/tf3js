# Titanfall 3JS

A browser-based 3D first-person shooter inspired by Titanfall, built with Three.js and the Cannon-es physics engine.

## Demo

[![Watch the demo](https://img.youtube.com/vi/l3LYOUOZzCk/0.jpg)](https://www.youtube.com/watch?v=l3LYOUOZzCk)

Click the image above to watch a gameplay demo on YouTube.

## Features

- **Pilot movement**: sprint, slide, double jump, wall-run, wall-jump, mantle, bunny-hop and a grappling hook
- **Titans**: fill your meter, call in a Titan, embark, dash and fight with the XO-16 chaingun
- **10 pilot weapons** with distinct ballistics (bullet drop, shotgun spreads, explosive EPG rounds) and per-weapon reticles
- **Attachments**: optics, extended/quick-reload magazines, stabilizer and suppressor
- **Enemies**:
  - **Grunts** fight in squads: whoever spots you radios the rest; they take cover behind real geometry, peek out to fire bursts, reload, and run from titans
  - **Ticks** lie dormant until they see you, then scuttle in on a weave, arm with an accelerating beep and explode (shooting one nearby still hurts — and their blasts hurt other enemies)
  - **Reapers** are 3 m bipedal machines that fire homing rocket salvos, stomp anything underfoot and launch ticks from their backs
- **Pilot health regenerates** after a few seconds out of fire
- **Seven missions** across training, capture, race and survival modes
- **Rebindable keys** and full **gamepad** support (menus and gameplay), with selectable aim response curves
- **Modern rendering**: HDR post-processing with bloom, MSAA/FXAA, ground-truth ambient occlusion (Ultra), image-based lighting from the sky, camera-following soft shadows, dynamic muzzle-flash/explosion lights and hit-feedback colour grading
- **Graphics quality presets** (Low / Medium / High / Ultra) in **Configurations**

## Controls

All keyboard bindings can be changed in **Configurations**.

| Keyboard / mouse | Gamepad | Action |
|---|---|---|
| `W` `A` `S` `D` | Left stick | Move |
| Mouse | Right stick | Look |
| `SPACE` | LB | Jump / double jump / wall-jump |
| `L-SHIFT` | Push left stick fully | Sprint (Titan: dash) |
| `L-CTRL` | RB | Crouch / slide |
| Left click | RT | Fire |
| Right click | LT | Aim down sights |
| `R` | Tap X | Reload |
| `G` (hold, release to throw) | B | Frag grenade |
| `Q` | A | Grapple hook (gamepad A also dashes in a Titan) |
| `1`–`4` / mouse wheel | Y | Switch weapon |
| Hold `E` | Hold X | Pick up weapon/attachment, embark Titan |
| Hold `E` for 1s in a Titan | Hold X for 1s | Disembark |
| `T` | D-pad down | Call Titan (when the meter is full) |
| `ESC` | Menu | Pause |
| `Y` | — | Restart level |
| `M` | — | Main menu |

You can carry two weapons. Picking one up fills a free slot, or swaps it for the weapon you're holding.

## Missions

| # | Mission | Goal |
|---|---|---|
| 1 | Training: Basics | Destroy 5 targets |
| 2 | Training: Wall Runs | Destroy 8 targets within 2 minutes |
| 3 | Training: Sliding | Destroy 3 targets within 90 seconds |
| 4 | Capture: Outpost Alpha | Hold the capture points for 30 seconds |
| 5 | Race: Speed Course | Reach all checkpoints within 60 seconds |
| 6 | Survival: Last Stand | Survive 60 seconds against escalating waves (grunts, then ticks, then reapers) |
| 7 | Survival: Iron Tide | Survive 90 seconds against reapers, ticks and grunt squads |

## Getting Started

### Prerequisites

- Node.js 18 or newer
- npm

### Installation

```bash
git clone <repository-url>
cd tf3js
npm install
npm run dev
```

The game will be available at `http://localhost:5173`.

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server with hot reload |
| `npm run build` | Type-check and build for production into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the unit tests (Vitest) |
| `npm run typecheck` | Type-check without building |

In dev mode the running `Game` instance is available as `window.__game` for debugging from the browser console.

## Project Structure

```
src/
├── main.ts          # Entry point: creates Game, global shortcut keys
├── game.ts          # Game loop, state machine, level lifecycle, objectives
├── player.ts        # Pilot controller: input, shooting, grapple, grenades, viewmodel
├── movement.ts      # Pilot movement physics (slide, wall-run, mantle, ...)
├── titan.ts         # Titan entity: drop-in, embark/exit, piloting, chaingun
├── titanModel.ts    # Titan model, rig and leg IK
├── hostile.ts       # Shared enemy interface, steering and cover helpers
├── grunt.ts         # Grunt squad AI and model
├── tick.ts          # Tick (frag drone) AI and model
├── reaper.ts        # Reaper AI, model, rockets and tick launcher
├── target.ts        # Training targets
├── weapons.ts       # Weapon/attachment definitions and WeaponManager
├── ballistics.ts    # Projectile simulation and trails
├── collision.ts     # Pure collision/damage helpers and scene disposal
├── graphics.ts      # Render pipeline: post-processing, shadows, IBL, flash lights
├── graphicsSettings.ts # Graphics quality presets
├── geometryUtils.ts # Bevelled boxes and geometry merging
├── effects.ts       # Impacts, muzzle flashes, explosions
├── reticle.ts       # Per-weapon crosshairs and hitmarkers
├── radar.ts         # Enemy radar and damage-direction indicators
├── aiming.ts        # Gamepad aim assist / recoil compensation
├── ui.ts            # All HUD and menu DOM, gamepad menu navigation
├── keybindings.ts   # Rebindable keys, aim curves, persistence
├── level.ts         # Level geometry builder
├── levels.ts        # Mission definitions
├── sound.ts         # Procedurally synthesised sound effects
└── types.ts         # Shared types
```

### Adding a mission

1. Add an entry to `LEVELS` in `src/levels.ts`.
2. Add any mission-specific geometry in `createLevel()` in `src/level.ts`.
3. Set `enemyCount` / `tickCount` / `reaperCount` on the level, and add target and enemy spawn points in `Game.getTargetSpawnPositions()`, `Game.getEnemySpawnPositions()` and `Game.getTickSpawnPositions()`.

## License

MIT License. Feel free to use this project for learning or as a base for your own games.

## Acknowledgments

- Inspired by Respawn Entertainment's Titanfall series
- Built with Three.js and the amazing web graphics community
- Physics powered by Cannon-es

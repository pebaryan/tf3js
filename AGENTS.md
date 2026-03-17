# Agent Guidelines for Titanfall 3JS

## Project Overview

Browser-based 3D first-person shooter inspired by Titanfall, built with Three.js, Cannon-es, and TypeScript. Bundled with Vite.

## Commands

```bash
npm run dev      # Start dev server (http://localhost:5173)
npm run build    # tsc + vite build → dist/
npm run preview  # Preview production build
```

Always run `npm run build` to verify there are no TypeScript errors after making changes.

## Architecture

```
src/
├── main.ts      # Entry point — creates Game, wires keydown shortcuts
├── game.ts      # Core game loop, state machine, physics world, orchestration
├── player.ts    # Player controller: movement, parkour, shooting, camera
├── ui.ts        # All DOM/HUD creation, menu management, gamepad navigation
├── level.ts     # Map geometry builder (createLevel)
├── levels.ts    # Level data: LevelType enum, Level interface, LEVELS array
├── types.ts     # Shared types: GameState enum, GameStats interface
├── titan.ts     # Titan entity logic
├── enemy.ts     # Enemy entity logic
├── target.ts    # Destructible target entities
└── sound.ts     # Audio management (currently commented out in game.ts)
```

## Key Conventions

- **Shared types** (used by both `game.ts` and `ui.ts`) live in `src/types.ts` to avoid circular imports. Do not re-export them through `game.ts`.
- **Level data** lives in `src/levels.ts`. Map geometry creation is in `src/level.ts`.
- `GameUI` is instantiated in `Game` constructor as `this.ui`. All DOM manipulation goes through `GameUI` — do not add DOM code to `game.ts`.
- `GameUI.init()` accepts callbacks (`onTogglePause`, `onCallTitan`) rather than holding a reference to `Game`, keeping `ui.ts` decoupled.
- Physics body velocity is set directly on `body.velocity` (Cannon-es Vector3), not via forces, for responsive player movement.
- Wall run: `wallNormal` is set by `checkWall()` raycasts (left/right). Movement is projected onto the wall tangent plane to prevent camera-look direction from pulling the player off the wall.

## Gamepad Support

- Gamepad state is polled each frame in `GameUI.updateMenuNavigation()`.
- Edge detection uses `*Prev` boolean fields (e.g. `gamepadAPrev`, `leftStickUpPrev`).
- When `GameState.MAIN_MENU` is active, navigation targets `#level-select` if it is visible, otherwise `#main-menu`.
- In-game actions (pause toggle, titan call) are handled via button callbacks set in `GameUI.init()`.

## Build Notes

- TypeScript strict mode is on — avoid `any` and uninitialized `!` fields unless already established in the file.
- `export type` is erased at build time; use plain `export` for enums and values that are read at runtime (e.g. `GameState`).
- Vite bundles as ES modules (`"type": "module"` in package.json).

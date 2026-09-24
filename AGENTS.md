# Agent Guidelines for Titanfall 3JS

## Project Overview

Browser-based 3D first-person shooter inspired by Titanfall, built with Three.js, Cannon-es, and TypeScript. Bundled with Vite.

## Commands

```bash
npm run dev      # Start dev server (http://localhost:5173)
npm run build    # tsc + vite build → dist/
npm run preview  # Preview production build
npm test         # Unit tests (Vitest, *.test.ts next to the source)
```

Always run `npm run build` and `npm test` to verify there are no TypeScript errors or test failures after making changes.

## Architecture

```
src/
├── main.ts        # Entry point — creates Game, wires restart/menu shortcut keys
├── game.ts        # Core game loop, state machine, level setup/teardown, objectives
├── player.ts      # Player controller: input, shooting, grapple, grenades, camera
├── movement.ts    # Pilot movement physics (ground, slide, wall run, mantle)
├── ui.ts          # All DOM/HUD creation, menu management, gamepad navigation
├── level.ts       # Map geometry builder (createLevel)
├── levels.ts      # Level data: LevelType enum, Level interface, LEVELS array
├── types.ts       # Shared types: GameState enum, GameStats, Damageable, HUD data
├── titan.ts       # Titan entity logic
├── enemy.ts       # Enemy entity logic
├── target.ts      # Destructible target entities
├── weapons.ts     # Weapon definitions, cloneWeapon, WeaponManager
├── ballistics.ts  # Projectile simulation
├── collision.ts   # Pure collision/damage helpers, disposeObject3D
├── graphics.ts    # Render pipeline: post-processing, sun shadows, IBL, flash lights
├── graphicsSettings.ts # Quality presets (low/medium/high/ultra) + persistence
├── geometryUtils.ts    # bevelBox, placedBox, mergeAndDispose
├── effects.ts     # Impact/explosion particle effects
├── reticle.ts     # Crosshair canvas
├── radar.ts       # Radar / damage-direction canvas
├── keybindings.ts # Rebindable keys and aim curves (persisted in localStorage)
└── sound.ts       # Procedurally synthesised audio
```

## Key Conventions

- **Shared types** (used by both `game.ts` and `ui.ts`) live in `src/types.ts` to avoid circular imports. Do not re-export them through `game.ts`.
- **Level data** lives in `src/levels.ts`. Map geometry creation is in `src/level.ts`.
- `GameUI` is instantiated in `Game` constructor as `this.ui`. All DOM manipulation goes through `GameUI` — do not add DOM code to `game.ts`.
- `GameUI.init()` accepts callbacks (`onTogglePause`, `onCallTitan`) rather than holding a reference to `Game`, keeping `ui.ts` decoupled.
- Physics body velocity is set directly on `body.velocity` (Cannon-es Vector3), not via forces, for responsive player movement.
- Wall run: `wallNormal` is set by `checkWall()` raycasts (left/right). Movement is projected onto the wall tangent plane to prevent camera-look direction from pulling the player off the wall.
- **Lifecycle**: every level restart goes through `Game.teardownLevel()`. Anything that registers DOM listeners, appends DOM elements or allocates GPU resources must expose `dispose()`/`destroy()` and be called from there. Register listeners with an `AbortController` signal so they can be removed in one call (see `Player`).
- Weapon constants (`R201_WEAPON`, ...) are shared templates — never mutate them. `WeaponManager` stores copies via `cloneWeapon()`.
- Fast projectiles must be hit-tested along the segment travelled this frame (`segmentIntersectsSphere`, `Player.findSegmentHit`), not just at their new position, or they tunnel through targets.
- Game time (`stats.time`) accumulates simulated `delta`, so pausing doesn't count against level time limits.
- **Rendering**: never call `renderer.render()` directly — `GraphicsPipeline.render()` runs the post-processing chain (MSAA/FXAA, bloom, GTAO on ultra, colour grade, tone mapping). Tone mapping and sRGB conversion happen in the final `OutputPass`.
- **Glow**: bloom only picks up HDR values (threshold ≈ 2.4 luminance, above sunlit white walls). Make something glow with an HDR colour, e.g. `new THREE.Color(hex).multiplyScalar(4)` on a `MeshBasicMaterial`, or a high `emissiveIntensity`.
- **Canvas textures** that carry colour must set `texture.colorSpace = THREE.SRGBColorSpace`.
- **Dynamic lights**: use `flashLight()` from `graphics.ts` for muzzle flashes/explosions. It uses a fixed pool, so the scene's light count never changes (which would recompile every shader).
- **Geometry**: use `bevelBox()` instead of `BoxGeometry` for visible hard-surface parts. Decorative detail on level blocks is added as *children* (merged per material via `mergeAndDispose`) so gameplay raycasts, which only test top-level scene meshes, and physics are unaffected.
- **Per-frame allocation**: projectiles and particles share cached geometries/materials and only update transforms. Don't create geometries or materials per bullet/particle, and don't dispose shared ones in `disposeBullet`.

## Gamepad Support

- Gamepad state is polled each frame in `GameUI.updateMenuNavigation()`.
- Edge detection uses `*Prev` boolean fields (e.g. `gamepadAPrev`, `leftStickUpPrev`).
- When `GameState.MAIN_MENU` is active, navigation targets `#level-select` if it is visible, otherwise `#main-menu`.
- In-game actions (pause toggle, titan call) are handled via button callbacks set in `GameUI.init()`.

## Build Notes

- TypeScript strict mode is on — avoid `any` and uninitialized `!` fields unless already established in the file.
- Keep pure logic (math, data transforms) free of DOM/WebGL access so it can be unit-tested in Node.
- In dev builds the `Game` instance is exposed as `window.__game` for console debugging and browser tests.
- `export type` is erased at build time; use plain `export` for enums and values that are read at runtime (e.g. `GameState`).
- Vite bundles as ES modules (`"type": "module"` in package.json).

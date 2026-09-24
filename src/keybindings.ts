export interface Bindings {
  forward: string;
  backward: string;
  left: string;
  right: string;
  jump: string;
  sprint: string;
  crouch: string;
  pause: string;
  callTitan: string;
  embark: string;
  reload: string;
  grenade: string;
  grapple: string;
  restart: string;
  mainMenu: string;
}

export const DEFAULT_BINDINGS: Bindings = {
  forward:   'KeyW',
  backward:  'KeyS',
  left:      'KeyA',
  right:     'KeyD',
  jump:      'Space',
  sprint:    'ShiftLeft',
  crouch:    'ControlLeft',
  pause:     'Escape',
  callTitan: 'KeyT',
  embark:    'KeyE',
  reload:    'KeyR',
  grenade:   'KeyG',
  grapple:   'KeyQ',
  restart:   'KeyY',
  mainMenu:  'KeyM',
};

export const ACTION_LABELS: Record<keyof Bindings, string> = {
  forward:   'Move Forward',
  backward:  'Move Backward',
  left:      'Move Left',
  right:     'Move Right',
  jump:      'Jump / Wall Run',
  sprint:    'Sprint',
  crouch:    'Crouch / Slide',
  pause:     'Pause',
  callTitan: 'Call Titan',
  embark:    'Embark / Interact',
  reload:    'Reload',
  grenade:   'Frag Grenade (hold to aim)',
  grapple:   'Grapple Hook',
  restart:   'Restart Level',
  mainMenu:  'Main Menu',
};

// --- Aim response curves (gamepad only) ---

export type AimCurve = 'classic' | 'steady' | 'fine' | 'linear';

export const AIM_CURVE_LABELS: Record<AimCurve, string> = {
  classic: 'Classic',
  steady:  'Steady',
  fine:    'Fine',
  linear:  'Linear',
};

/**
 * Apply a response curve to a raw stick axis value (-1 to 1).
 *
 * - Classic: gentle acceleration (TF2 default) — power curve ~2.5
 * - Steady:  moderate curve ~2.0, smoother mid-range tracking
 * - Fine:    high exponent ~3.5 for precise small adjustments, fast snaps
 * - Linear:  1:1 mapping, no curve applied
 */
export function applyAimCurve(raw: number, curve: AimCurve): number {
  const sign = Math.sign(raw);
  const abs = Math.abs(raw);
  switch (curve) {
    case 'classic': return sign * Math.pow(abs, 2.5);
    case 'steady':  return sign * Math.pow(abs, 2.0);
    case 'fine':    return sign * Math.pow(abs, 3.5);
    case 'linear':  return raw;
  }
}

const AIM_CURVE_STORAGE_KEY = 'tf3js_aim_curve';
let _cachedCurve: AimCurve | null = null;

export function getAimCurve(): AimCurve {
  if (_cachedCurve) return _cachedCurve;
  try {
    const stored = localStorage.getItem(AIM_CURVE_STORAGE_KEY);
    if (stored && stored in AIM_CURVE_LABELS) {
      _cachedCurve = stored as AimCurve;
      return _cachedCurve;
    }
  } catch {}
  _cachedCurve = 'classic';
  return _cachedCurve;
}

export function setAimCurve(curve: AimCurve): void {
  _cachedCurve = curve;
  try {
    localStorage.setItem(AIM_CURVE_STORAGE_KEY, curve);
  } catch {
    // Storage may be unavailable (private mode, quota); keep the in-memory value.
  }
}

const STORAGE_KEY = 'tf3js_keybindings';

let _cached: Bindings | null = null;

/** Merge stored bindings over the defaults, ignoring unknown actions and non-string values. */
export function parseStoredBindings(raw: string | null): Bindings {
  const bindings = { ...DEFAULT_BINDINGS };
  if (!raw) return bindings;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const action of Object.keys(DEFAULT_BINDINGS) as (keyof Bindings)[]) {
        const value = (parsed as Record<string, unknown>)[action];
        if (typeof value === 'string' && value.length > 0) bindings[action] = value;
      }
    }
  } catch {
    // Corrupt JSON: fall back to defaults.
  }
  return bindings;
}

export function getBindings(): Bindings {
  if (_cached) return _cached;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable.
  }
  _cached = parseStoredBindings(stored);
  return _cached;
}

export function setBindings(b: Bindings): void {
  _cached = { ...b };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_cached));
  } catch {
    // Storage may be unavailable (private mode, quota); keep the in-memory value.
  }
}

/**
 * Bind `code` to `action`. If another action already uses `code`, it takes
 * over the key `action` previously had, so no two actions share a key.
 */
export function rebind(bindings: Bindings, action: keyof Bindings, code: string): Bindings {
  const next = { ...bindings };
  const previous = next[action];
  for (const other of Object.keys(next) as (keyof Bindings)[]) {
    if (other !== action && next[other] === code) next[other] = previous;
  }
  next[action] = code;
  return next;
}

export function keyCodeToLabel(code: string): string {
  const map: Record<string, string> = {
    Space:        'SPACE',
    Escape:       'ESC',
    ShiftLeft:    'L-SHIFT',
    ShiftRight:   'R-SHIFT',
    ControlLeft:  'L-CTRL',
    ControlRight: 'R-CTRL',
    AltLeft:      'L-ALT',
    AltRight:     'R-ALT',
    ArrowUp:      'UP',
    ArrowDown:    'DOWN',
    ArrowLeft:    'LEFT',
    ArrowRight:   'RIGHT',
    Tab:          'TAB',
    CapsLock:     'CAPS',
    Backquote:    '`',
    Minus:        '-',
    Equal:        '=',
    BracketLeft:  '[',
    BracketRight: ']',
    Backslash:    '\\',
    Semicolon:    ';',
    Quote:        "'",
    Comma:        ',',
    Period:       '.',
    Slash:        '/',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key'))   return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM' + code.slice(6);
  if (code.startsWith('F') && !isNaN(Number(code.slice(1)))) return code;
  return code;
}

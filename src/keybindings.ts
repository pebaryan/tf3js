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
  restart:   'KeyR',
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
  restart:   'Restart Level',
  mainMenu:  'Main Menu',
};

const STORAGE_KEY = 'tf3js_keybindings';

let _cached: Bindings | null = null;

export function getBindings(): Bindings {
  if (_cached) return _cached;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      _cached = { ...DEFAULT_BINDINGS, ...JSON.parse(stored) };
      return _cached!;
    }
  } catch {}
  _cached = { ...DEFAULT_BINDINGS };
  return _cached;
}

export function setBindings(b: Bindings): void {
  _cached = { ...b };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_cached));
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

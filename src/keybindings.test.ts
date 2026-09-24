import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, applyAimCurve, keyCodeToLabel, parseStoredBindings, rebind } from './keybindings';

describe('applyAimCurve', () => {
  it('preserves sign and the endpoints for every curve', () => {
    for (const curve of ['classic', 'steady', 'fine', 'linear'] as const) {
      expect(applyAimCurve(1, curve)).toBeCloseTo(1);
      expect(applyAimCurve(-1, curve)).toBeCloseTo(-1);
      expect(applyAimCurve(0, curve)).toBeCloseTo(0);
      expect(Math.sign(applyAimCurve(-0.5, curve))).toBe(-1);
    }
  });

  it('is linear for the linear curve and damped for the others', () => {
    expect(applyAimCurve(0.5, 'linear')).toBe(0.5);
    expect(applyAimCurve(0.5, 'steady')).toBeCloseTo(0.25);
    expect(applyAimCurve(0.5, 'fine')).toBeLessThan(applyAimCurve(0.5, 'classic'));
  });
});

describe('keyCodeToLabel', () => {
  it('formats common key codes', () => {
    expect(keyCodeToLabel('KeyW')).toBe('W');
    expect(keyCodeToLabel('Digit3')).toBe('3');
    expect(keyCodeToLabel('Space')).toBe('SPACE');
    expect(keyCodeToLabel('ShiftLeft')).toBe('L-SHIFT');
    expect(keyCodeToLabel('Numpad5')).toBe('NUM5');
    expect(keyCodeToLabel('F5')).toBe('F5');
  });
});

describe('parseStoredBindings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(parseStoredBindings(null)).toEqual(DEFAULT_BINDINGS);
  });

  it('returns defaults for corrupt JSON', () => {
    expect(parseStoredBindings('{not json')).toEqual(DEFAULT_BINDINGS);
  });

  it('merges stored values and fills in actions added since they were saved', () => {
    const stored = JSON.stringify({ forward: 'ArrowUp' });
    const bindings = parseStoredBindings(stored);
    expect(bindings.forward).toBe('ArrowUp');
    expect(bindings.reload).toBe(DEFAULT_BINDINGS.reload);
  });

  it('ignores unknown actions and non-string values', () => {
    const bindings = parseStoredBindings(JSON.stringify({ jump: 42, bogus: 'KeyZ' }));
    expect(bindings.jump).toBe(DEFAULT_BINDINGS.jump);
    expect('bogus' in bindings).toBe(false);
  });
});

describe('rebind', () => {
  it('assigns the new key', () => {
    expect(rebind(DEFAULT_BINDINGS, 'jump', 'KeyJ').jump).toBe('KeyJ');
  });

  it('swaps keys when the new key was already bound to another action', () => {
    const next = rebind(DEFAULT_BINDINGS, 'jump', DEFAULT_BINDINGS.forward);
    expect(next.jump).toBe(DEFAULT_BINDINGS.forward);
    expect(next.forward).toBe(DEFAULT_BINDINGS.jump);
  });

  it('does not mutate the input', () => {
    const before = { ...DEFAULT_BINDINGS };
    rebind(DEFAULT_BINDINGS, 'jump', 'KeyJ');
    expect(DEFAULT_BINDINGS).toEqual(before);
  });
});

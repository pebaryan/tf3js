import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPHICS_QUALITY, QUALITY_PRESETS, isGraphicsQuality, resolvePixelRatio, snapToTexel } from './graphicsSettings';

describe('quality presets', () => {
  it('scale monotonically from low to ultra', () => {
    const order = ['low', 'medium', 'high', 'ultra'] as const;
    for (let i = 1; i < order.length; i++) {
      const prev = QUALITY_PRESETS[order[i - 1]];
      const cur = QUALITY_PRESETS[order[i]];
      expect(cur.shadowMapSize).toBeGreaterThanOrEqual(prev.shadowMapSize);
      expect(cur.maxPixelRatio).toBeGreaterThanOrEqual(prev.maxPixelRatio);
      expect(cur.dynamicLights).toBeGreaterThanOrEqual(prev.dynamicLights);
    }
  });

  it('always has some form of anti-aliasing', () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(preset.msaaSamples > 0 || preset.fxaa).toBe(true);
    }
  });

  it('only enables ambient occlusion on ultra', () => {
    expect(QUALITY_PRESETS.ultra.ambientOcclusion).toBe(true);
    expect(QUALITY_PRESETS.high.ambientOcclusion).toBe(false);
  });
});

describe('isGraphicsQuality', () => {
  it('accepts known presets and rejects anything else', () => {
    expect(isGraphicsQuality('ultra')).toBe(true);
    expect(isGraphicsQuality(DEFAULT_GRAPHICS_QUALITY)).toBe(true);
    expect(isGraphicsQuality('extreme')).toBe(false);
    expect(isGraphicsQuality(null)).toBe(false);
  });
});

describe('resolvePixelRatio', () => {
  it('caps the device pixel ratio at the preset maximum', () => {
    expect(resolvePixelRatio(3, QUALITY_PRESETS.high)).toBe(1.5);
    expect(resolvePixelRatio(1, QUALITY_PRESETS.ultra)).toBe(1);
  });

  it('falls back to 1 for invalid device ratios', () => {
    expect(resolvePixelRatio(NaN, QUALITY_PRESETS.ultra)).toBe(1);
    expect(resolvePixelRatio(0, QUALITY_PRESETS.ultra)).toBe(1);
  });
});

describe('snapToTexel', () => {
  it('snaps to multiples of one shadow-map texel', () => {
    // 100 m frustum over 1000 texels = 0.1 m per texel
    expect(snapToTexel(1.26, 50, 1000)).toBeCloseTo(1.3);
    expect(snapToTexel(-0.04, 50, 1000)).toBeCloseTo(0);
  });

  it('is stable: snapping twice gives the same value', () => {
    const once = snapToTexel(12.3456, 60, 4096);
    expect(snapToTexel(once, 60, 4096)).toBeCloseTo(once, 10);
  });
});

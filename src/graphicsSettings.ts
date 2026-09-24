/**
 * Graphics quality presets and their persistence. Pure data + localStorage so
 * it can be unit-tested without WebGL.
 */

export type GraphicsQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  /** Upper bound for renderer pixel ratio (the device ratio is used if lower). */
  maxPixelRatio: number;
  /** Directional-light shadow map resolution. */
  shadowMapSize: number;
  /** Half-size of the square shadow frustum that follows the camera (metres). */
  shadowExtent: number;
  /** Multisample anti-aliasing samples for the main render target (0 = off). */
  msaaSamples: number;
  /** Cheap post-process anti-aliasing, used when MSAA is off. */
  fxaa: boolean;
  bloom: boolean;
  /** Screen-space ground-truth ambient occlusion. */
  ambientOcclusion: boolean;
  /** Vignette, chromatic aberration, film grain and damage feedback. */
  colorGrade: boolean;
  /** Number of pooled point lights used for muzzle flashes and explosions. */
  dynamicLights: number;
}

export const GRAPHICS_QUALITY_LABELS: Record<GraphicsQuality, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
};

export const QUALITY_PRESETS: Record<GraphicsQuality, QualityPreset> = {
  low: {
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    shadowExtent: 35,
    msaaSamples: 0,
    fxaa: true,
    bloom: false,
    ambientOcclusion: false,
    colorGrade: true,
    dynamicLights: 0,
  },
  medium: {
    maxPixelRatio: 1,
    shadowMapSize: 2048,
    shadowExtent: 45,
    msaaSamples: 4,
    fxaa: false,
    bloom: true,
    ambientOcclusion: false,
    colorGrade: true,
    dynamicLights: 2,
  },
  high: {
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowExtent: 50,
    msaaSamples: 4,
    fxaa: false,
    bloom: true,
    ambientOcclusion: false,
    colorGrade: true,
    dynamicLights: 4,
  },
  ultra: {
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowExtent: 60,
    msaaSamples: 4,
    fxaa: false,
    bloom: true,
    ambientOcclusion: true,
    colorGrade: true,
    dynamicLights: 4,
  },
};

export const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = 'high';

const STORAGE_KEY = 'tf3js_graphics_quality';

export function isGraphicsQuality(value: unknown): value is GraphicsQuality {
  return typeof value === 'string' && value in QUALITY_PRESETS;
}

export function getGraphicsQuality(): GraphicsQuality {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isGraphicsQuality(stored)) return stored;
  } catch {
    // Storage unavailable.
  }
  return DEFAULT_GRAPHICS_QUALITY;
}

export function setGraphicsQuality(quality: GraphicsQuality): void {
  try {
    localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // Storage may be unavailable (private mode, quota); the change still applies this session.
  }
}

/** Effective renderer pixel ratio for a device and preset. */
export function resolvePixelRatio(devicePixelRatio: number, preset: QualityPreset): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, preset.maxPixelRatio);
}

/**
 * Snap a coordinate to the shadow-map texel grid so the shadow frustum moves in
 * whole-texel steps. Without this, shadow edges shimmer as the camera moves.
 */
export function snapToTexel(value: number, extent: number, mapSize: number): number {
  const texel = (2 * extent) / mapSize;
  return Math.round(value / texel) * texel;
}

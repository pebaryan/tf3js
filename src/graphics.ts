import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { GraphicsQuality, QUALITY_PRESETS, QualityPreset, resolvePixelRatio, snapToTexel } from './graphicsSettings';

/* ------------------------------------------------------------------ */
/*  Colour grade: vignette, chromatic aberration, grain, hit feedback  */
/* ------------------------------------------------------------------ */

/** Runs in linear HDR space, before tone mapping (OutputPass). */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    vignette: { value: 0.35 },
    aberration: { value: 0.0022 },
    grain: { value: 0.025 },
    damage: { value: 0 },
    lowHealth: { value: 0 },
    tint: { value: new THREE.Color(1, 1, 1) },
    tintMix: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time;
    uniform float vignette;
    uniform float aberration;
    uniform float grain;
    uniform float damage;
    uniform float lowHealth;
    uniform vec3 tint;
    uniform float tintMix;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 centered = vUv - 0.5;
      float r2 = dot(centered, centered);

      // Chromatic aberration grows towards the edges and spikes when hit
      float ca = aberration * (1.0 + damage * 4.0) * r2 * 4.0;
      vec3 color;
      color.r = texture2D(tDiffuse, vUv - centered * ca).r;
      color.g = texture2D(tDiffuse, vUv).g;
      color.b = texture2D(tDiffuse, vUv + centered * ca).b;

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));

      // Low health drains colour
      color = mix(color, vec3(luma), lowHealth * 0.65);

      // Cockpit / mode tint
      color = mix(color, color * tint, tintMix);

      // Damage: red bleed from the screen edges
      float edge = smoothstep(0.04, 0.42, r2);
      color = mix(color, vec3(1.6, 0.06, 0.03) * (luma + 0.35), clamp(damage * edge * 0.85 + lowHealth * edge * 0.25, 0.0, 1.0));

      // Vignette
      color *= 1.0 - vignette * smoothstep(0.06, 0.55, r2);

      // Film grain, proportional to brightness so darks stay clean
      float n = hash(vUv * resolution + fract(time) * 61.0) - 0.5;
      color += n * grain * (luma + 0.04);

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ */
/*  Pooled flash lights for muzzle flashes and explosions              */
/* ------------------------------------------------------------------ */

interface FlashSlot {
  light: THREE.PointLight;
  peak: number;
  life: number;
  maxLife: number;
}

/**
 * A fixed set of point lights that are always in the scene (at zero intensity
 * when idle), so the number of lights never changes mid-game and materials
 * never need to recompile their shaders.
 */
export class FlashLightPool {
  readonly group = new THREE.Group();
  private slots: FlashSlot[] = [];

  constructor(count: number) {
    this.group.name = 'flash-lights';
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      light.castShadow = false;
      this.group.add(light);
      this.slots.push({ light, peak: 0, life: 0, maxLife: 1 });
    }
  }

  flash(position: THREE.Vector3, color: THREE.ColorRepresentation, intensity: number, distance: number, duration: number): void {
    if (this.slots.length === 0) return;
    // Reuse an idle light, otherwise the one closest to fading out
    let slot = this.slots[0];
    for (const s of this.slots) {
      if (s.life <= 0) { slot = s; break; }
      if (s.life < slot.life) slot = s;
    }
    slot.light.position.copy(position);
    slot.light.color.set(color);
    slot.light.distance = distance;
    slot.peak = intensity;
    slot.life = duration;
    slot.maxLife = duration;
    slot.light.intensity = intensity;
  }

  update(delta: number): void {
    for (const s of this.slots) {
      if (s.life <= 0) continue;
      s.life = Math.max(0, s.life - delta);
      const t = s.life / s.maxLife;
      s.light.intensity = s.peak * t * t;
    }
  }

  dispose(): void {
    for (const s of this.slots) s.light.dispose();
    this.group.parent?.remove(this.group);
    this.slots = [];
  }
}

let activeFlashLights: FlashLightPool | null = null;

/** Flash a dynamic light if the current quality preset has any. Safe to call anywhere. */
export function flashLight(position: THREE.Vector3, color: THREE.ColorRepresentation, intensity: number, distance: number, duration: number): void {
  activeFlashLights?.flash(position, color, intensity, distance, duration);
}

/* ------------------------------------------------------------------ */
/*  Render pipeline                                                    */
/* ------------------------------------------------------------------ */

function isTransparentObject(object: THREE.Object3D): boolean {
  if ((object as THREE.Sprite).isSprite) return true;
  const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!material) return false;
  return Array.isArray(material) ? material.some((m) => m.transparent) : material.transparent;
}

export class GraphicsPipeline {
  private composer!: EffectComposer;
  private bloomPass: UnrealBloomPass | null = null;
  private gradePass: ShaderPass | null = null;
  private fxaaPass: ShaderPass | null = null;
  private preset!: QualityPreset;
  private quality!: GraphicsQuality;
  private flashLights: FlashLightPool | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private readonly sunOffset = new THREE.Vector3();
  private environment: THREE.WebGLRenderTarget | null = null;
  private pmrem: THREE.PMREMGenerator;

  private damage = 0;
  private lowHealth = 0;
  private tintMix = 0;
  private targetTintMix = 0;
  private elapsed = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    quality: GraphicsQuality,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.setQuality(quality);
  }

  getQuality(): GraphicsQuality {
    return this.quality;
  }

  /** The directional light whose shadow frustum should follow the camera. */
  setSun(light: THREE.DirectionalLight): void {
    this.sun = light;
    this.sunOffset.copy(light.position).sub(light.target.position);
    if (!light.target.parent) this.scene.add(light.target);
    this.applyShadowSettings();
  }

  /**
   * Image-based lighting from the sky: gives metals something to reflect and fills
   * shadows with sky colour. `intensity` scales the whole environment (three r160
   * has no scene-wide environment intensity, so it is baked into the map).
   */
  setEnvironmentFromEquirect(texture: THREE.Texture, intensity = 1): void {
    const envScene = new THREE.Scene();
    const skyMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      color: new THREE.Color(intensity, intensity, intensity),
      toneMapped: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), skyMaterial);
    envScene.add(sky);
    this.environment?.dispose();
    this.environment = this.pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.environment.texture;
    sky.geometry.dispose();
    skyMaterial.dispose();
  }

  setQuality(quality: GraphicsQuality): void {
    this.quality = quality;
    this.preset = QUALITY_PRESETS[quality];
    this.renderer.setPixelRatio(resolvePixelRatio(window.devicePixelRatio, this.preset));
    this.buildComposer();
    this.applyShadowSettings();

    // Resize the flash light pool (one shader recompile, only when the setting changes)
    this.flashLights?.dispose();
    this.flashLights = null;
    activeFlashLights = null;
    if (this.preset.dynamicLights > 0) {
      this.flashLights = new FlashLightPool(this.preset.dynamicLights);
      this.scene.add(this.flashLights.group);
      activeFlashLights = this.flashLights;
    }
  }

  /** Objects the level teardown must keep (the flash lights and the sun target). */
  getPersistentObjects(): THREE.Object3D[] {
    const objects: THREE.Object3D[] = [];
    if (this.flashLights) objects.push(this.flashLights.group);
    if (this.sun) objects.push(this.sun.target);
    return objects;
  }

  private buildComposer(): void {
    this.disposeComposer();

    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();
    const preset = this.preset;

    const target = new THREE.WebGLRenderTarget(width * pixelRatio, height * pixelRatio, {
      type: THREE.HalfFloatType,
      samples: preset.msaaSamples,
    });
    target.texture.name = 'GraphicsPipeline.hdr';
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (preset.ambientOcclusion) {
      const gtao = new GTAOPass(this.scene, this.camera, width * pixelRatio, height * pixelRatio);
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 16, distanceFallOff: 0.5, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      gtao.blendIntensity = 0.85;
      // Keep sprites, particles and glass out of the normal/depth buffer so they don't cast AO smudges
      const hidden: THREE.Object3D[] = [];
      const scene = this.scene;
      gtao.overrideVisibility = () => {
        scene.traverse((object) => {
          if (!object.visible) return;
          if ((object as THREE.Points).isPoints || (object as THREE.Line).isLine || isTransparentObject(object)) {
            object.visible = false;
            hidden.push(object);
          }
        });
      };
      gtao.restoreVisibility = () => {
        for (const object of hidden) object.visible = true;
        hidden.length = 0;
      };
      this.composer.addPass(gtao);
    }

    if (preset.bloom) {
      // Threshold sits above sunlit white walls, so only emissive neon, tracers and flashes glow
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.55, 0.45, 2.4);
      this.composer.addPass(this.bloomPass);
    }

    if (preset.colorGrade) {
      this.gradePass = new ShaderPass(GradeShader);
      this.composer.addPass(this.gradePass);
    }

    // Tone mapping + sRGB conversion
    this.composer.addPass(new OutputPass());

    if (preset.fxaa) {
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaaPass);
    }

    this.updateResolutionUniforms(width, height, pixelRatio);
  }

  private applyShadowSettings(): void {
    const sun = this.sun;
    if (!sun) return;
    const { shadowMapSize, shadowExtent } = this.preset;
    const shadow = sun.shadow;
    if (shadow.mapSize.x !== shadowMapSize) {
      shadow.mapSize.set(shadowMapSize, shadowMapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
    const cam = shadow.camera;
    cam.left = -shadowExtent;
    cam.right = shadowExtent;
    cam.top = shadowExtent;
    cam.bottom = -shadowExtent;
    cam.near = 1;
    cam.far = this.sunOffset.length() + shadowExtent * 2;
    cam.updateProjectionMatrix();
    shadow.bias = -0.0004;
    shadow.normalBias = 0.03;
    shadow.radius = 3;
  }

  /** Keep the shadow frustum centred on `focus`, moving in whole shadow-map texels to avoid shimmering. */
  private updateSun(focus: THREE.Vector3): void {
    const sun = this.sun;
    if (!sun) return;
    const { shadowMapSize, shadowExtent } = this.preset;

    // Snap in the light's own view space, where texels are axis-aligned
    const lightDir = this.sunOffset.clone().normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), lightDir);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(lightDir, right).normalize();

    const x = snapToTexel(focus.dot(right), shadowExtent, shadowMapSize);
    const y = snapToTexel(focus.dot(up), shadowExtent, shadowMapSize);
    const z = focus.dot(lightDir);
    const snapped = right.multiplyScalar(x).add(up.multiplyScalar(y)).add(lightDir.clone().multiplyScalar(z));

    sun.target.position.copy(snapped);
    sun.position.copy(snapped).add(this.sunOffset);
    sun.target.updateMatrixWorld();
  }

  /** Feedback for the grade pass: `hit` briefly flashes the screen edges, low health desaturates. */
  registerDamage(amount: number): void {
    this.damage = Math.min(1, this.damage + 0.25 + amount / 40);
  }

  setHealthFraction(fraction: number): void {
    this.lowHealth = THREE.MathUtils.clamp((0.4 - fraction) / 0.4, 0, 1);
  }

  /** Warm cockpit tint while piloting a titan. */
  setTitanView(active: boolean): void {
    this.targetTintMix = active ? 1 : 0;
  }

  update(delta: number, focus: THREE.Vector3): void {
    this.elapsed += delta;
    this.damage = Math.max(0, this.damage - delta * 1.8);
    this.tintMix += (this.targetTintMix - this.tintMix) * Math.min(1, delta * 4);
    this.flashLights?.update(delta);
    this.updateSun(focus);

    if (this.gradePass) {
      const u = this.gradePass.uniforms;
      u.time.value = this.elapsed;
      u.damage.value = this.damage;
      u.lowHealth.value = this.lowHealth;
      u.tintMix.value = this.tintMix * 0.18;
      (u.tint.value as THREE.Color).setRGB(1.25, 0.95, 0.75);
    }
  }

  render(): void {
    this.composer.render();
  }

  setSize(width: number, height: number): void {
    const pixelRatio = resolvePixelRatio(window.devicePixelRatio, this.preset);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.updateResolutionUniforms(width, height, pixelRatio);
  }

  private updateResolutionUniforms(width: number, height: number, pixelRatio: number): void {
    if (this.fxaaPass) {
      (this.fxaaPass.uniforms.resolution.value as THREE.Vector2).set(1 / (width * pixelRatio), 1 / (height * pixelRatio));
    }
    if (this.gradePass) {
      (this.gradePass.uniforms.resolution.value as THREE.Vector2).set(width * pixelRatio, height * pixelRatio);
    }
  }

  private disposeComposer(): void {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.bloomPass = null;
    this.gradePass = null;
    this.fxaaPass = null;
  }
}

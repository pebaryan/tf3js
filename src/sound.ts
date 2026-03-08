export class SoundManager {
  private audioContext: AudioContext | null = null;
  private soundMap: Map<string, AudioBuffer> = new Map();
  private volume: number = 0.5;
  private isMuted: boolean = false;
  private playbackRate: number = 1;

  constructor() {
    this.initAudioContext();
    this.generateSounds();
  }

  private initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }

  // --- Synthesis helpers ---

  private async synth(
    duration: number,
    recipe: (ctx: OfflineAudioContext) => void,
  ): Promise<AudioBuffer> {
    const sampleRate = 44100;
    const ctx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
    recipe(ctx);
    return ctx.startRendering();
  }

  private noiseSource(ctx: OfflineAudioContext, duration: number): AudioBufferSourceNode {
    const buf = ctx.createBuffer(1, Math.ceil(duration * ctx.sampleRate), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  // --- Generate all sounds ---

  private async generateSounds() {

    // rifle_fire: short noise burst + bass thump
    this.soundMap.set('rifle_fire', await this.synth(0.15, (ctx) => {
      const noise = this.noiseSource(ctx, 0.15);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2000; bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.8, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.1);
      noise.connect(bp).connect(g).connect(ctx.destination);
      noise.start(0);

      const osc = ctx.createOscillator();
      osc.frequency.value = 80;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.5, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.08);
      osc.connect(g2).connect(ctx.destination);
      osc.start(0); osc.stop(0.08);
    }));

    // shotgun_fire: wider noise, more bass, longer
    this.soundMap.set('shotgun_fire', await this.synth(0.25, (ctx) => {
      const noise = this.noiseSource(ctx, 0.25);
      const bp = ctx.createBiquadFilter();
      bp.type = 'lowpass'; bp.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.0, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.2);
      noise.connect(bp).connect(g).connect(ctx.destination);
      noise.start(0);

      const osc = ctx.createOscillator();
      osc.frequency.value = 60;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.7, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.15);
      osc.connect(g2).connect(ctx.destination);
      osc.start(0); osc.stop(0.15);
    }));

    // sniper_fire: sharp crack + deep boom
    this.soundMap.set('sniper_fire', await this.synth(0.4, (ctx) => {
      // High crack
      const noise = this.noiseSource(ctx, 0.4);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 4000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.05);
      noise.connect(hp).connect(g).connect(ctx.destination);
      noise.start(0);

      // Deep boom
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(100, 0);
      osc.frequency.exponentialRampToValueAtTime(30, 0.3);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.6, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.35);
      osc.connect(g2).connect(ctx.destination);
      osc.start(0); osc.stop(0.35);

      // Tail noise
      const noise2 = this.noiseSource(ctx, 0.4);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 600;
      const g3 = ctx.createGain();
      g3.gain.setValueAtTime(0, 0);
      g3.gain.linearRampToValueAtTime(0.15, 0.05);
      g3.gain.exponentialRampToValueAtTime(0.01, 0.4);
      noise2.connect(lp).connect(g3).connect(ctx.destination);
      noise2.start(0);
    }));

    // grenade_fire: sci-fi energy sweep down + pop
    this.soundMap.set('grenade_fire', await this.synth(0.3, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(800, 0);
      osc.frequency.exponentialRampToValueAtTime(100, 0.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.25);
      osc.connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.25);

      const noise = this.noiseSource(ctx, 0.1);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 3;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.4, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.08);
      noise.connect(bp).connect(g2).connect(ctx.destination);
      noise.start(0);
    }));

    // titan_fire: heavy mechanical thump
    this.soundMap.set('titan_fire', await this.synth(0.2, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = 50;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.8, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.15);
      osc.connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.15);

      const noise = this.noiseSource(ctx, 0.1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 800;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.5, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.08);
      noise.connect(lp).connect(g2).connect(ctx.destination);
      noise.start(0);
    }));

    // jump: rising sine sweep
    this.soundMap.set('jump', await this.synth(0.12, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(200, 0);
      osc.frequency.exponentialRampToValueAtTime(800, 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.1);
      osc.connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.1);
    }));

    // slide: low noise with filter sweep down
    this.soundMap.set('slide', await this.synth(0.3, (ctx) => {
      const noise = this.noiseSource(ctx, 0.3);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2000, 0);
      lp.frequency.exponentialRampToValueAtTime(200, 0.25);
      lp.Q.value = 5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.25);
      noise.connect(lp).connect(g).connect(ctx.destination);
      noise.start(0);
    }));

    // wallrun: mid-frequency pulse
    this.soundMap.set('wallrun', await this.synth(0.15, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = 400;
      osc.type = 'square';
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.12);
      osc.connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.12);
    }));

    // mantle: short thump rising
    this.soundMap.set('mantle', await this.synth(0.15, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(120, 0);
      osc.frequency.exponentialRampToValueAtTime(300, 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.4, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.12);
      osc.connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.12);
    }));

    // hit: impact thump + crackle
    this.soundMap.set('hit', await this.synth(0.2, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = 80;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.6, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.12);
      osc.connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.12);

      const noise = this.noiseSource(ctx, 0.15);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 3000;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.3, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.1);
      noise.connect(hp).connect(g2).connect(ctx.destination);
      noise.start(0);
    }));

    // explosion: long noise + bass rumble
    this.soundMap.set('explosion', await this.synth(0.8, (ctx) => {
      const noise = this.noiseSource(ctx, 0.8);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1200, 0);
      lp.frequency.exponentialRampToValueAtTime(100, 0.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.8, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.7);
      noise.connect(lp).connect(g).connect(ctx.destination);
      noise.start(0);

      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(60, 0);
      osc.frequency.exponentialRampToValueAtTime(20, 0.5);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.7, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.6);
      osc.connect(g2).connect(ctx.destination);
      osc.start(0); osc.stop(0.6);
    }));

    // reload: metallic click sequence
    this.soundMap.set('reload', await this.synth(0.4, (ctx) => {
      // Click 1 — mag out
      const o1 = ctx.createOscillator();
      o1.frequency.value = 3000; o1.type = 'sine';
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(0, 0);
      g1.gain.linearRampToValueAtTime(0.4, 0.005);
      g1.gain.exponentialRampToValueAtTime(0.01, 0.05);
      o1.connect(g1).connect(ctx.destination);
      o1.start(0); o1.stop(0.05);

      // Click 2 — mag in
      const o2 = ctx.createOscillator();
      o2.frequency.value = 4000; o2.type = 'sine';
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, 0.15);
      g2.gain.linearRampToValueAtTime(0.5, 0.155);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.2);
      o2.connect(g2).connect(ctx.destination);
      o2.start(0.15); o2.stop(0.2);

      // Click 3 — chamber
      const o3 = ctx.createOscillator();
      o3.frequency.value = 2500; o3.type = 'sine';
      const g3 = ctx.createGain();
      g3.gain.setValueAtTime(0, 0.3);
      g3.gain.linearRampToValueAtTime(0.3, 0.305);
      g3.gain.exponentialRampToValueAtTime(0.01, 0.35);
      o3.connect(g3).connect(ctx.destination);
      o3.start(0.3); o3.stop(0.35);
    }));

    // weapon_switch: metallic slide
    this.soundMap.set('weapon_switch', await this.synth(0.15, (ctx) => {
      const noise = this.noiseSource(ctx, 0.15);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(3000, 0);
      bp.frequency.exponentialRampToValueAtTime(1000, 0.12);
      bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.3, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.12);
      noise.connect(bp).connect(g).connect(ctx.destination);
      noise.start(0);
    }));

    // enemy_fire: similar to rifle but lower, different tone
    this.soundMap.set('enemy_fire', await this.synth(0.12, (ctx) => {
      const noise = this.noiseSource(ctx, 0.12);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.6, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.08);
      noise.connect(bp).connect(g).connect(ctx.destination);
      noise.start(0);

      const osc = ctx.createOscillator();
      osc.frequency.value = 60;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.3, 0);
      g2.gain.exponentialRampToValueAtTime(0.01, 0.06);
      osc.connect(g2).connect(ctx.destination);
      osc.start(0); osc.stop(0.06);
    }));

    // grapple: rising electronic whine
    this.soundMap.set('grapple', await this.synth(0.25, (ctx) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(300, 0);
      osc.frequency.exponentialRampToValueAtTime(2000, 0.2);
      osc.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25, 0);
      g.gain.exponentialRampToValueAtTime(0.01, 0.2);
      osc.connect(lp).connect(g).connect(ctx.destination);
      osc.start(0); osc.stop(0.2);
    }));

    // pickup: ascending chime
    this.soundMap.set('pickup', await this.synth(0.3, (ctx) => {
      const notes = [600, 800, 1000];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq;
        osc.type = 'sine';
        const g = ctx.createGain();
        const t = i * 0.08;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.3, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
        osc.connect(g).connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.1);
      });
    }));

  }

  playSound(name: string, volume: number = 1.0) {
    if (this.isMuted || !this.audioContext || !this.soundMap.has(name)) {
      return;
    }

    this.initAudioContext();
    // Resume context if suspended (browsers require user interaction)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    const buffer = this.soundMap.get(name);
    if (!buffer) return;

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.playbackRate;

    const gainNode = this.audioContext.createGain();
    const clampedVolume = Math.max(0, Math.min(1, volume));
    gainNode.gain.value = this.volume * clampedVolume;

    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    source.start(0);
  }

  setVolume(newVolume: number) {
    this.volume = Math.min(1, Math.max(0, newVolume));
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
  }

  isPlaying() {
    return !this.isMuted;
  }

  setPlaybackRate(rate: number) {
    this.playbackRate = Math.max(0.1, Math.min(4, rate));
  }
}

export const soundManager = new SoundManager();

export class SoundManager {
  private audioContext: AudioContext | null = null;
  private soundMap: Map<string, AudioBuffer> = new Map();
  private volume: number = 0.5;
  private isMuted: boolean = false;
  private playbackRate: number = 1;
  
  constructor() {
    this.initAudioContext();
    this.loadSounds();
  }
  
  private initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  }
  
  private loadSounds() {
    const soundPaths = [
      { name: 'jump', path: '/sounds/jump.mp3' },
      { name: 'shoot', path: '/sounds/shoot.mp3' },
      { name: 'hit', path: '/sounds/hit.mp3' },
      { name: 'slide', path: '/sounds/slide.mp3' },
      { name: 'wallrun', path: '/sounds/wallrun.mp3' },
      { name: 'mantle', path: '/sounds/mantle.mp3' },
      { name: 'level_complete', path: '/sounds/level_complete.mp3' },
      { name: 'game_over', path: '/sounds/game_over.mp3' }
    ];
    
    soundPaths.forEach(sound => {
      this.loadSound(sound.name, sound.path);
    });
  }
  
  private async loadSound(name: string, path: string) {
    try {
      const response = await fetch(path);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        if (this.audioContext) {
          const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
          this.soundMap.set(name, audioBuffer);
        }
      }
    } catch (error) {
      console.warn(`Failed to load sound: ${name}`);
    }
  }
  
  playSound(name: string, volume: number = 1.0) {
    if (this.isMuted || !this.audioContext || !this.soundMap.has(name)) {
      return;
    }
    
    this.initAudioContext();
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
  
  // Playback rate adjustment for game speed effects
  setPlaybackRate(rate: number) {
    this.playbackRate = Math.max(0.1, Math.min(4, rate));
  }
}

export const soundManager = new SoundManager();

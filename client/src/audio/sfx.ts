/** Procedural sound effects (no asset files => loads instantly, fully original, zero licensing). */
export type SfxName =
  'fire' | 'hit' | 'wall' | 'explode' | 'powerup' | 'ability' | 'beep' | 'go' | 'victory' | 'defeat';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  volume = 0.6;
  muted = false;

  /** Browsers only allow audio after a user gesture; call this from a click/tap/key handler. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.apply();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(percent: number, muted: boolean): void {
    this.volume = Math.max(0, Math.min(1, percent / 100));
    this.muted = muted;
    this.apply();
  }

  private apply(): void {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume * 0.5; // headroom: never painfully loud
  }

  play(name: SfxName): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || this.volume === 0 || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    switch (name) {
      case 'fire':
        this.tone(t, 620, 160, 0.09, 'square', 0.18);
        break;
      case 'hit':
        this.tone(t, 240, 90, 0.07, 'square', 0.2);
        break;
      case 'wall':
        this.noise(t, 0.09, 0.22, 2200);
        break;
      case 'explode':
        this.noise(t, 0.55, 0.45, 900);
        this.tone(t, 110, 35, 0.5, 'sawtooth', 0.3);
        break;
      case 'powerup':
        [520, 660, 880].forEach((f, i) => this.tone(t + i * 0.07, f, f, 0.09, 'triangle', 0.2));
        break;
      case 'ability':
        this.tone(t, 280, 1000, 0.28, 'sawtooth', 0.14);
        break;
      case 'beep':
        this.tone(t, 440, 440, 0.12, 'square', 0.16);
        break;
      case 'go':
        this.tone(t, 880, 880, 0.3, 'square', 0.18);
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(t + i * 0.12, f, f, 0.2, 'triangle', 0.24));
        break;
      case 'defeat':
        [392, 330, 262, 196].forEach((f, i) => this.tone(t + i * 0.16, f, f * 0.97, 0.24, 'triangle', 0.24));
        break;
    }
  }

  private tone(start: number, f0: number, f1: number, dur: number, type: OscillatorType, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dur);
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  private noise(start: number, dur: number, gain: number, cutoff: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff / 6), start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(start);
  }
}

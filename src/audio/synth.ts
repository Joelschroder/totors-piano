// Enkel pianoliknande synt (additiv syntes) för ljud när man spelar med
// datorns tangentbord/mus och för "Lyssna"-läget. Ingen nedladdning krävs.

export class PianoSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<number, { gain: GainNode; oscs: OscillatorNode[] }>();
  volume = 0.5;

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  noteOn(midi: number, velocity = 0.8): void {
    const ctx = this.ensure();
    this.noteOff(midi, 0.03);
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(12000, f0 * 10), t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(400, f0 * 2.5), t + 1.2);
    // Längre efterklang för låga toner, som ett riktigt piano.
    const decay = 1.2 + (1 - Math.min(1, (midi - 21) / 87)) * 3.5;
    const peak = 0.22 * (0.35 + 0.65 * velocity);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    gain.connect(filter).connect(this.master!);
    const B = 0.0004;
    const partials = [1, 0.45, 0.22, 0.12, 0.07, 0.04];
    const oscs = partials.map((amp, i) => {
      const h = i + 1;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = h * f0 * Math.sqrt(1 + B * h * h);
      const g = ctx.createGain();
      g.gain.value = amp;
      osc.connect(g).connect(gain);
      osc.start(t);
      osc.stop(t + decay + 0.1);
      return osc;
    });
    this.voices.set(midi, { gain, oscs });
  }

  noteOff(midi: number, release = 0.25): void {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, release / 3);
    for (const o of v.oscs) o.stop(t + release + 0.1);
    this.voices.delete(midi);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }
}

// Mikrofoningång: getUserMedia → AudioWorklet (samlar block) → Worker (detektor).
//
// Viktigt för korrekt tonigenkänning: stäng av webbläsarens ekosläckning,
// brusreducering och automatiska volymkontroll – de förvränger övertonerna
// som detektorn bygger på.

export interface MicEvent {
  type: 'note' | 'onset' | 'wrong';
  midi?: number;
  onsetTime?: number;
  latency?: number;
}

export interface MicLevel {
  db: number;
  pitch: { midi: number; freq: number; clarity: number } | null;
}

const WORKLET_SRC = `
class Collector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.pos = 0;
    this.out = null;
    this.port.onmessage = (e) => { this.out = e.data; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.out) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.pos++] = ch[i];
        if (this.pos === this.buf.length) {
          this.out.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(512);
          this.pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pitch-collector', Collector);
`;

export class MicInput {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private node: AudioWorkletNode | null = null;
  sampleRate = 0;
  deviceLabel = '';

  constructor(
    private onEvents: (events: MicEvent[]) => void,
    private onLevel: (level: MicLevel) => void,
  ) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined';
  }

  async start(opts: { a4: number; sensitivity: number; deviceId?: string }): Promise<void> {
    if (!MicInput.supported()) throw new Error('Webbläsaren saknar stöd för mikrofon/AudioWorklet.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.deviceLabel = this.stream.getAudioTracks()[0]?.label ?? '';
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.sampleRate = this.ctx.sampleRate;
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pitch-collector', { numberOfInputs: 1, numberOfOutputs: 0 });
    src.connect(this.node);

    this.worker = new Worker(new URL('../audio/detector.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      if (e.data.type === 'events') this.onEvents(e.data.events);
      else if (e.data.type === 'level') this.onLevel({ db: e.data.db, pitch: e.data.pitch });
    };
    const channel = new MessageChannel();
    this.worker.postMessage(
      { type: 'init', sampleRate: this.sampleRate, a4: opts.a4, sensitivity: opts.sensitivity, port: channel.port2 },
      [channel.port2],
    );
    this.node.port.postMessage(channel.port1, [channel.port1]);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setExpected(midis: number[]): void {
    this.worker?.postMessage({ type: 'expected', midis });
  }

  confirm(onsetTime: number): void {
    this.worker?.postMessage({ type: 'confirm', onsetTime });
  }

  configure(cfg: { a4?: number; sensitivity?: number }): void {
    this.worker?.postMessage({ type: 'config', ...cfg });
  }

  stop(): void {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worker?.terminate();
    void this.ctx?.close();
    this.node = null;
    this.stream = null;
    this.worker = null;
    this.ctx = null;
  }

  get running(): boolean {
    return this.ctx !== null;
  }
}

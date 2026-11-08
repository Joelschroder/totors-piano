// Mikrofoningång: getUserMedia → AudioWorklet (samlar block) → Worker (detektor).
//
// Viktigt för korrekt tonigenkänning: stäng av webbläsarens ekosläckning,
// brusreducering och automatiska volymkontroll – de förvränger övertonerna
// som detektorn bygger på.
//
// iOS/Safari-detaljer som måste stämma:
//  - AudioContext måste skapas (och resume() anropas) SYNKRONT i användarens
//    tryck – innan vi väntar på mikrofontillståndet. Annars startar den pausad.
//  - Safari bearbetar bara noder som leder till högtalarutgången, så insamlings-
//    noden kopplas dit via en förstärkare med volym 0.
//  - iOS kan pausa ljudet ("interrupted") t.ex. vid samtal eller appbyte; då
//    meddelar vi appen så att användaren kan trycka för att fortsätta.

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

export type MicState = 'running' | 'paused' | 'ended';

export class MicInput {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private nodes: AudioNode[] = [];
  sampleRate = 0;
  deviceLabel = '';

  constructor(
    private onEvents: (events: MicEvent[]) => void,
    private onLevel: (level: MicLevel) => void,
    private onState: (state: MicState) => void = () => {},
  ) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';
  }

  /**
   * Måste anropas direkt från ett klick/tryck (utan await före), så att iOS
   * tillåter ljudet.
   */
  async start(opts: { a4: number; sensitivity: number; deviceId?: string }): Promise<void> {
    if (!MicInput.supported()) throw new Error('Webbläsaren saknar stöd för mikrofon.');
    // 1) Synkront i användarens tryck: skapa och starta ljudmotorn.
    let ctx = new AudioContext({ latencyHint: 'interactive' });
    void ctx.resume();
    this.ctx = ctx;

    // 2) Be om mikrofonen.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.stop();
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error('Appen fick inte använda mikrofonen. Tillåt mikrofon för sidan (på iPhone: Inställningar → Safari → Mikrofon) och försök igen.');
      }
      if (name === 'NotFoundError') throw new Error('Hittade ingen mikrofon.');
      throw err;
    }
    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = track?.label ?? '';
    track?.addEventListener('ended', () => this.onState('ended'));

    // 3) Koppla mikrofonen. Firefox kräver samma samplingsfrekvens som mikrofonen.
    let src: MediaStreamAudioSourceNode;
    try {
      src = ctx.createMediaStreamSource(this.stream);
    } catch {
      const rate = track?.getSettings().sampleRate;
      void ctx.close();
      ctx = new AudioContext(rate ? { sampleRate: rate } : undefined);
      this.ctx = ctx;
      src = ctx.createMediaStreamSource(this.stream);
    }
    this.sampleRate = ctx.sampleRate;

    // 4) Detektorn i en Worker.
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

    // 5) Insamling: AudioWorklet om möjligt, annars ScriptProcessor (äldre webbläsare).
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let collector: AudioNode;
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      await ctx.audioWorklet.addModule(new URL('pitch-collector.js', document.baseURI).href);
      const node = new AudioWorkletNode(ctx, 'pitch-collector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.postMessage(channel.port1, [channel.port1]);
      collector = node;
    } catch {
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const port = channel.port1;
      proc.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        port.postMessage(data, [data.buffer]);
      };
      collector = proc;
    }
    src.connect(collector);
    collector.connect(sink);
    this.nodes = [src, collector, sink];

    ctx.onstatechange = () => this.onState(ctx.state === 'running' ? 'running' : 'paused');
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* kräver ett nytt tryck – appen visar en knapp */
      }
    }
    this.onState(ctx.state === 'running' ? 'running' : 'paused');
  }

  /** Försök starta ljudet igen (anropas från ett tryck). */
  resume(): void {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume();
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
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
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worker?.terminate();
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.stream = null;
    this.worker = null;
    this.ctx = null;
  }

  get running(): boolean {
    return this.ctx !== null;
  }
}

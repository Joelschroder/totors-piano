// Väntläge ("wait mode"): låten står still tills rätt ton/ackord spelats,
// sedan flyttas tidslinjen fram till nästa steg.
//
// Logiken är oberoende av hur tonerna kommer in (MIDI, mikrofon, tangentbord,
// mus) – allt blir noteOn/noteOff.

import { buildSteps, filterHands, type Hand, type NoteEvent, type Song, type Step } from '../music/song';

export type InputSource = 'midi' | 'mic' | 'keyboard' | 'pointer' | 'demo';

export type SessionEvent =
  | { type: 'correct'; midi: number; step: Step; source: InputSource }
  | { type: 'wrong'; midi: number; step: Step | null; source: InputSource }
  | { type: 'advance'; from: number; to: number }
  | { type: 'finished' }
  | { type: 'reset' };

export interface SessionStats {
  correct: number;
  wrong: number;
  stepsDone: number;
  stepsTotal: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export class PracticeSession {
  readonly song: Song;
  readonly hands: 'both' | Hand;
  readonly notes: NoteEvent[];
  readonly steps: Step[];
  index = 0;
  /** Förväntade toner i aktuellt steg som redan spelats. */
  satisfied = new Set<number>();
  stats: SessionStats;
  private listeners: ((e: SessionEvent) => void)[] = [];

  constructor(song: Song, hands: 'both' | Hand = 'both') {
    this.song = song;
    this.hands = hands;
    this.notes = filterHands(song.notes, hands);
    this.steps = buildSteps(this.notes);
    this.stats = this.freshStats();
  }

  private freshStats(): SessionStats {
    return { correct: 0, wrong: 0, stepsDone: 0, stepsTotal: this.steps.length, startedAt: null, finishedAt: null };
  }

  on(fn: (e: SessionEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) l(e);
  }

  get finished(): boolean {
    return this.index >= this.steps.length;
  }

  get current(): Step | null {
    return this.steps[this.index] ?? null;
  }

  get expected(): number[] {
    return this.current ? this.current.notes.map((n) => n.midi) : [];
  }

  /** Taktslag (beat) där tidslinjen ska stå just nu. */
  get targetBeat(): number {
    if (this.current) return this.current.time;
    const last = this.steps[this.steps.length - 1];
    return last ? last.time + Math.max(...last.notes.map((n) => n.dur)) : 0;
  }

  noteOn(midi: number, source: InputSource): void {
    const step = this.current;
    if (!step) return;
    if (this.stats.startedAt === null) this.stats.startedAt = performance.now();
    const expected = step.notes.some((n) => n.midi === midi);
    if (!expected) {
      this.stats.wrong++;
      this.emit({ type: 'wrong', midi, step, source });
      return;
    }
    if (this.satisfied.has(midi)) return;
    this.satisfied.add(midi);
    this.stats.correct++;
    this.emit({ type: 'correct', midi, step, source });
    if (step.notes.every((n) => this.satisfied.has(n.midi))) this.advance();
  }

  /** Mikrofonen kan rapportera "fel ton" utan att vi vet exakt vilket steg. */
  reportWrong(midi: number, source: InputSource): void {
    this.stats.wrong++;
    this.emit({ type: 'wrong', midi, step: this.current, source });
  }

  private advance(): void {
    const from = this.index;
    this.index++;
    this.satisfied = new Set();
    this.stats.stepsDone = this.index;
    this.emit({ type: 'advance', from, to: this.index });
    if (this.finished) {
      this.stats.finishedAt = performance.now();
      this.emit({ type: 'finished' });
    }
  }

  /** Hoppa (t.ex. via piltangenter) till ett visst steg. */
  seek(index: number): void {
    const to = Math.max(0, Math.min(this.steps.length, index));
    if (to === this.index) return;
    const from = this.index;
    this.index = to;
    this.satisfied = new Set();
    this.stats.stepsDone = to;
    this.emit({ type: 'advance', from, to });
  }

  reset(): void {
    this.index = 0;
    this.satisfied = new Set();
    this.stats = this.freshStats();
    this.emit({ type: 'reset' });
  }
}

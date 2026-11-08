import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoteDetector, type DetectorEvent } from '../../src/audio/pitch/detector';
import { midiToFreq, parseNoteName } from '../../src/music/theory';

export const SR = 48000;
export const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'samples');

/** Enkel syntetisk pianoton: inharmoniska övertoner, snabb attack, exponentiell avklingning. */
export function synthPiano(midi: number, seconds = 1.2, amp = 0.3, sr = SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const f0 = midiToFreq(midi);
  const B = 0.0004;
  for (let h = 1; h <= 12; h++) {
    const f = h * f0 * Math.sqrt(1 + B * h * h);
    if (f > sr / 2 - 1000) break;
    const a = (amp / h) * (h === 1 ? 1 : 0.8);
    const decay = 2 + h * 0.6;
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < out.length; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.004) * Math.exp(-decay * t);
      out[i] += a * env * Math.sin(2 * Math.PI * f * t + phase);
    }
  }
  return out;
}

const sampleCache = new Map<string, Float32Array>();
export function hasSamples(): boolean {
  return existsSync(join(SAMPLE_DIR, 'C4.f32'));
}
export function loadSample(name: string): Float32Array {
  let s = sampleCache.get(name);
  if (!s) {
    const buf = readFileSync(join(SAMPLE_DIR, `${name}.f32`));
    s = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    sampleCache.set(name, s);
  }
  return s;
}
export const SAMPLE_NAMES = 'A1 C2 E2 G2 C3 E3 F3 G3 A3 B3 C4 Db4 D4 E4 F4 Gb4 G4 Ab4 A4 B4 C5 Db5 D5 E5 G5 C6 E6 C7'.split(' ');
export const sampleMidi = (name: string) => parseNoteName(name)!;
export function sampleFor(midi: number): string | undefined {
  return SAMPLE_NAMES.find((n) => sampleMidi(n) === midi);
}

export interface Hit {
  time: number;
  audio: Float32Array;
  gain?: number;
}

/** Mixar anslag till en buffert, med lite bakgrundsbrus. */
export function mix(hits: Hit[], seconds: number, noise = 0.0005, sr = SR): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * noise;
  for (const h of hits) {
    const start = Math.floor(h.time * sr);
    const g = h.gain ?? 1;
    for (let i = 0; i < h.audio.length && start + i < out.length; i++) out[start + i] += h.audio[i] * g;
  }
  return out;
}

export interface Schedule {
  time: number;
  expected: number[];
  /** Om true: anropa markConfirmed på senaste anslag innan expected byts (som övningslogiken gör). */
  confirmPrevious?: boolean;
}

/** Kör detektorn över ljud i block om 128 samples (som en AudioWorklet), med schemalagda förväntningar. */
export function run(audio: Float32Array, schedule: Schedule[], opts: { sensitivity?: number } = {}): DetectorEvent[] {
  const det = new NoteDetector({ sampleRate: SR, sensitivity: opts.sensitivity ?? 0.5 });
  const events: DetectorEvent[] = [];
  const sched = [...schedule].sort((a, b) => a.time - b.time);
  let si = 0;
  let lastNoteOnset = -Infinity;
  for (let pos = 0; pos < audio.length; pos += 128) {
    const t = pos / SR;
    while (si < sched.length && sched[si].time <= t) {
      if (sched[si].confirmPrevious) det.markConfirmed(lastNoteOnset);
      det.setExpected(sched[si].expected);
      si++;
    }
    for (const e of det.push(audio.subarray(pos, Math.min(pos + 128, audio.length)))) {
      events.push(e);
      if (e.type === 'note') lastNoteOnset = e.onsetTime;
    }
  }
  return events;
}

export const notesOf = (ev: DetectorEvent[]) => ev.filter((e): e is Extract<DetectorEvent, { type: 'note' }> => e.type === 'note');

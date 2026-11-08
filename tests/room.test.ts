import { expect, test } from 'vitest';
import { hasSamples, loadSample, sampleMidi, SR } from './helpers/audio';
import { NoteDetector } from '../src/audio/pitch/detector';
import { PracticeSession } from '../src/practice/session';
import { LIBRARY } from '../src/music/library';

/** Enkel rumssimulering: efterklang (RT60), högpass (telefonmikrofon), brus och låg nivå. */
export function room(dry: Float32Array, opts: { rt60: number; wet: number; noiseDb: number; gain: number }): Float32Array {
  const irLen = Math.floor(opts.rt60 * SR);
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  // Gles impulssvar (snabbare än full faltning): 1500 reflexer med exponentiell avklingning.
  const taps: [number, number][] = [];
  for (let i = 0; i < 1500; i++) {
    const d = Math.floor(Math.pow(Math.random() * 0 + i / 1500, 1.5) * irLen) + Math.floor(0.008 * SR);
    taps.push([d, rnd() * Math.exp((-6.9 * d) / irLen) * 0.08]);
  }
  const out = new Float32Array(dry.length);
  for (let i = 0; i < dry.length; i++) out[i] = dry[i];
  for (const [d, a] of taps) {
    const g = a * opts.wet;
    for (let i = d; i < dry.length; i++) out[i] += dry[i - d] * g;
  }
  // Högpass ~120 Hz (enpolig) som en liten mikrofon.
  let prevX = 0, prevY = 0;
  const rc = 1 / (2 * Math.PI * 120), dt = 1 / SR, al = rc / (rc + dt);
  const noise = Math.pow(10, opts.noiseDb / 20);
  for (let i = 0; i < out.length; i++) {
    const y = al * (prevY + out[i] - prevX);
    prevX = out[i];
    prevY = y;
    out[i] = y * opts.gain + rnd() * noise;
  }
  return out;
}

export function melody(names: string[], gap: number): Float32Array {
  const lead = 1;
  const out = new Float32Array(Math.floor((lead + names.length * gap + 2) * SR));
  names.forEach((n, i) => {
    const s = loadSample(n);
    const start = Math.floor((lead + i * gap) * SR);
    const len = Math.min(s.length, Math.floor((gap + 0.1) * SR));
    for (let k = 0; k < len && start + k < out.length; k++) out[start + k] += s[k] * (k > len - 2400 ? (len - k) / 2400 : 1);
  });
  return out;
}

/** Kör hela kedjan detektor → övningslogik (som i appen) och returnerar antal klarade steg + fel. */
export function playThrough(audio: Float32Array, sensitivity = 0.5) {
  const song = LIBRARY.find((s) => s.id === 'ja-ma-han-leva')!;
  const session = new PracticeSession(song);
  const det = new NoteDetector({ sampleRate: SR, sensitivity });
  det.setExpected(session.expected);
  for (let pos = 0; pos < audio.length; pos += 128) {
    for (const e of det.push(audio.subarray(pos, pos + 128))) {
      if (e.type === 'note') {
        const before = session.index;
        session.noteOn(e.midi, 'mic');
        if (session.index !== before) {
          det.markConfirmed(e.onsetTime);
          det.setExpected(session.expected);
        }
      } else if (e.type === 'wrong') session.reportWrong(e.midi, 'mic');
    }
  }
  return { steps: session.index, total: session.steps.length, wrong: session.stats.wrong };
}

export const seq = ['G4', 'E4', 'E4', 'G4', 'E4', 'G4', 'E4', 'E4', 'G4', 'E4', 'G4', 'E4', 'E4', 'G4', 'E4', 'F4', 'E4', 'D4', 'E4', 'D4', 'C4'];

test.runIf(hasSamples()).each([
  ['torrt, normal nivå', { rt60: 0.01, wet: 0, noiseDb: -70, gain: 1 }],
  ['vardagsrum (RT60 0,5 s), telefon 2 m bort (−20 dB)', { rt60: 0.5, wet: 1, noiseDb: -62, gain: 0.1 }],
  ['ekande rum (RT60 1,2 s), −26 dB, mer brus', { rt60: 1.2, wet: 1.5, noiseDb: -58, gain: 0.05 }],
])('Ja, må han leva genom mikrofon: %s', (_label, opts) => {
  void sampleMidi;
  const r = playThrough(room(melody(seq, 0.6), opts));
  expect(r).toEqual({ steps: 21, total: 21, wrong: 0 });
}, 60000);

// Före varje rätt ton spelas en FEL ton (halvton, oktav eller kvint bredvid). Ingen fel ton
// får föra låten framåt, även i ett brusigt rum med låg nivå.
const WRONG_FOR: Record<string, string> = { G4: 'Ab4', E4: 'F4', F4: 'E4', D4: 'Db4', C4: 'C5' };
const ALT_WRONG: Record<string, string> = { G4: 'G3', E4: 'E5', F4: 'Gb4', D4: 'A3', C4: 'B3' };

test.runIf(hasSamples()).each([
  ['torrt', { rt60: 0.01, wet: 0, noiseDb: -70, gain: 1 }],
  ['vardagsrum, telefon 2 m bort', { rt60: 0.5, wet: 1, noiseDb: -62, gain: 0.1 }],
])('fel toner för inte låten framåt: %s', (_label, opts) => {
  const notes: string[] = [];
  const correct: boolean[] = [];
  seq.forEach((n, i) => {
    notes.push(i % 2 ? ALT_WRONG[n] : WRONG_FOR[n], n);
    correct.push(false, true);
  });
  const gap = 0.7;
  const audio = room(melody(notes, gap), opts);
  const song = LIBRARY.find((s) => s.id === 'ja-ma-han-leva')!;
  const session = new PracticeSession(song);
  const det = new NoteDetector({ sampleRate: SR });
  det.setExpected(session.expected);
  const advancedBy: number[] = [];
  for (let pos = 0; pos < audio.length; pos += 128) {
    for (const e of det.push(audio.subarray(pos, pos + 128))) {
      if (e.type !== 'note') continue;
      const before = session.index;
      session.noteOn(e.midi, 'mic');
      if (session.index !== before) {
        advancedBy.push(Math.round((e.onsetTime - 1) / gap));
        det.markConfirmed(e.onsetTime);
        det.setExpected(session.expected);
      }
    }
  }
  const byWrong = advancedBy.filter((i) => !correct[i]);
  expect({ steps: session.index, advancedByWrongNote: byWrong.map((i) => notes[i]) }).toEqual({ steps: 21, advancedByWrongNote: [] });
}, 60000);

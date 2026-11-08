import { describe, expect, test } from 'vitest';
import { hasSamples, loadSample, mix, notesOf, run, sampleFor, sampleMidi, SAMPLE_NAMES, synthPiano, type Hit } from './helpers/audio';
import { noteName } from '../src/music/theory';

// Ljudkälla: riktiga pianosamplingar om de finns (npm run fetch-samples), annars syntetiska.
const real = hasSamples();
function tone(midi: number): Float32Array {
  const name = real ? sampleFor(midi) : undefined;
  return name ? loadSample(name) : synthPiano(midi);
}
const C4 = 60, Db4 = 61, D4 = 62, E4 = 64, G4 = 67, A4 = 69, C5 = 72, C3 = 48, F3 = 53;

describe('enstaka toner', () => {
  test('rätt ton godkänns snabbt', () => {
    const ev = run(mix([{ time: 0.2, audio: tone(C4) }], 1), [{ time: 0, expected: [C4] }]);
    const n = notesOf(ev);
    expect(n.map((e) => e.midi)).toEqual([C4]);
    expect(n[0].latency).toBeLessThan(0.15);
  });

  test.each([
    ['grannhalvton', Db4],
    ['heltonen över', D4],
    ['oktaven under', C3],
    ['oktaven över', C5],
    ['kvarten under (F3)', F3],
  ])('fel ton (%s) godkänns inte', (_label, played) => {
    const ev = run(mix([{ time: 0.2, audio: tone(played) }], 1), [{ time: 0, expected: [C4] }]);
    expect(notesOf(ev)).toEqual([]);
  });

  test('oktaven under förväntad (C4 spelas, C5 väntas) godkänns inte', () => {
    const ev = run(mix([{ time: 0.2, audio: tone(C4) }], 1), [{ time: 0, expected: [C5] }]);
    expect(notesOf(ev)).toEqual([]);
  });

  test('fel ton rapporteras som "wrong" med rätt tonhöjd', () => {
    const ev = run(mix([{ time: 0.2, audio: tone(E4) }], 1), [{ time: 0, expected: [C4] }]);
    const wrong = ev.filter((e) => e.type === 'wrong');
    expect(wrong.length).toBe(1);
    expect((wrong[0] as { midi: number }).midi).toBe(E4);
  });

  test('tystnad och brus ger inga toner', () => {
    const ev = run(mix([], 1.5, 0.003), [{ time: 0, expected: [C4, E4, G4] }]);
    expect(notesOf(ev)).toEqual([]);
    expect(ev.filter((e) => e.type === 'onset')).toEqual([]);
  });

  test('svagt anslag (−20 dB) godkänns ändå', () => {
    const ev = run(mix([{ time: 0.2, audio: tone(G4), gain: 0.1 }], 1, 0.0002), [{ time: 0, expected: [G4] }]);
    expect(notesOf(ev).map((e) => e.midi)).toEqual([G4]);
  });
});

describe('ackord', () => {
  const chord = (midis: number[], t = 0.2, spread = 0): Hit[] => midis.map((m, i) => ({ time: t + i * spread, audio: tone(m), gain: 0.7 }));

  test('C-durackord: alla tre toner hittas', () => {
    const ev = run(mix(chord([C4, E4, G4]), 1), [{ time: 0, expected: [C4, E4, G4] }]);
    expect(notesOf(ev).map((e) => e.midi).sort()).toEqual([C4, E4, G4]);
  });

  test('lite brutet ackord (30 ms mellan tonerna) hittas', () => {
    const ev = run(mix(chord([C4, E4, G4], 0.2, 0.03), 1.2), [{ time: 0, expected: [C4, E4, G4] }]);
    expect(notesOf(ev).map((e) => e.midi).sort()).toEqual([C4, E4, G4]);
  });

  test('ackord med en fel ton: bara de rätta godkänns', () => {
    const ev = run(mix(chord([C4, E4, A4]), 1), [{ time: 0, expected: [C4, E4, G4] }]);
    expect(notesOf(ev).map((e) => e.midi).sort()).toEqual([C4, E4]);
  });

  test('bas + ackord (C3 + C4 E4 G4)', () => {
    const ev = run(mix(chord([C3, C4, E4, G4]), 1), [{ time: 0, expected: [C3, C4, E4, G4] }]);
    expect(notesOf(ev).map((e) => e.midi).sort()).toEqual([C3, C4, E4, G4].sort());
  });
});

describe('tidslinje (väntläge)', () => {
  test('upprepad ton (G G): ett anslag klarar inte två steg', () => {
    // Bara ETT anslag, men två steg med G4 i rad.
    const audio = mix([{ time: 0.2, audio: tone(G4) }], 1.5);
    const ev = run(audio, [
      { time: 0, expected: [G4] },
      { time: 0.5, expected: [G4], confirmPrevious: true },
    ]);
    expect(notesOf(ev).length).toBe(1);
  });

  test('upprepad ton (G G): två anslag klarar två steg', () => {
    const audio = mix([{ time: 0.2, audio: tone(G4), length: 0.5 }, { time: 0.7, audio: tone(G4) }], 1.5);
    const ev = run(audio, [
      { time: 0, expected: [G4] },
      { time: 0.5, expected: [G4], confirmPrevious: true },
    ]);
    expect(notesOf(ev).length).toBe(2);
  });

  test('snabb upprepning (G G med 250 ms mellanrum)', () => {
    const audio = mix([{ time: 0.2, audio: tone(G4), length: 0.25 }, { time: 0.45, audio: tone(G4) }], 1.5);
    const ev = run(audio, [
      { time: 0, expected: [G4] },
      { time: 0.35, expected: [G4], confirmPrevious: true },
    ]);
    expect(notesOf(ev).length).toBe(2);
  });

  test('klingande ton från förra steget räknas inte igen', () => {
    // C4 spelas och klingar; nästa steg är E4 och sedan C4 igen – utan nytt C4-anslag.
    const audio = mix([{ time: 0.2, audio: tone(C4) }, { time: 0.8, audio: tone(E4) }], 2);
    const ev = run(audio, [
      { time: 0, expected: [C4] },
      { time: 0.6, expected: [E4], confirmPrevious: true },
      { time: 1.3, expected: [C4], confirmPrevious: true },
    ]);
    expect(notesOf(ev).map((e) => e.midi)).toEqual([C4, E4]);
  });

  test('ny ton medan föregående klingar (legato C4 → G4)', () => {
    const audio = mix([{ time: 0.2, audio: tone(C4) }, { time: 0.5, audio: tone(G4) }], 1.5);
    const ev = run(audio, [
      { time: 0, expected: [C4] },
      { time: 0.45, expected: [G4], confirmPrevious: true },
    ]);
    expect(notesOf(ev).map((e) => e.midi)).toEqual([C4, G4]);
  });
});

describe.runIf(real)('alla inspelade pianotoner (FluidR3): förväxlingsmatris', () => {
  // För varje inspelad ton: förvänta tonen själv och vanliga förväxlingar
  // (halvton, oktav, kvint, duodecima). Endast tonen själv får godkännas.
  const offsets = [0, -1, 1, -12, 12, -19, 19, -7, 7, -24];
  test.each(SAMPLE_NAMES)('%s', (name) => {
    const m = sampleMidi(name);
    const audio = mix([{ time: 0.3, audio: loadSample(name) }], 1.2);
    const result: Record<string, boolean> = {};
    for (const off of offsets) {
      result[noteName(m + off)] = notesOf(run(audio, [{ time: 0, expected: [m + off] }])).length > 0;
    }
    const expected = Object.fromEntries(offsets.map((off) => [noteName(m + off), off === 0]));
    expect(result).toEqual(expected);
  });
});

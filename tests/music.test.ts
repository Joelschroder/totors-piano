import { describe, expect, test } from 'vitest';
import { freqToMidi, midiToFreq, noteName, parseNoteName } from '../src/music/theory';
import { parseTextNotation } from '../src/music/import/textNotation';
import { buildSteps } from '../src/music/song';
import { LIBRARY } from '../src/music/library';
import { Midi } from '@tonejs/midi';
import { parseMidiFile } from '../src/music/import/midiImport';

describe('teori', () => {
  test('A4 = 440 Hz, mitt-C = 60', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(60)).toBeCloseTo(261.626, 2);
    expect(freqToMidi(261.626)).toBeCloseTo(60, 3);
  });
  test('tonnamn tolkas', () => {
    expect(parseNoteName('C4')).toBe(60);
    expect(parseNoteName('F#3')).toBe(54);
    expect(parseNoteName('Bb2')).toBe(46);
    expect(parseNoteName('H3')).toBe(59);
    expect(parseNoteName('B3')).toBe(59);
    expect(parseNoteName('B3', 'svensk')).toBe(58);
    expect(parseNoteName('Cis4')).toBe(61);
    expect(parseNoteName('X4')).toBeNull();
  });
  test('svenska namn: B-natural heter H', () => {
    expect(noteName(59, 'svensk')).toBe('H3');
    expect(noteName(58, 'svensk')).toBe('B3');
    expect(noteName(59)).toBe('B3');
  });
});

describe('textnotation', () => {
  test('toner, längder, ackord, pauser och händer', () => {
    const s = parseTextNotation(`title: Test
bpm: 120
R: C4 D4:2 | [E4 G4]:0.5 r:1/2 F4~la
L: C3:4`);
    expect(s.title).toBe('Test');
    expect(s.bpm).toBe(120);
    const r = s.notes.filter((n) => n.hand === 'R').map((n) => [n.midi, n.start, n.dur]);
    expect(r).toEqual([
      [60, 0, 1],
      [62, 1, 2],
      [64, 3, 0.5],
      [67, 3, 0.5],
      [65, 4, 1],
    ]);
    expect(s.notes.find((n) => n.midi === 65)?.lyric).toBe('la');
    expect(s.notes.filter((n) => n.hand === 'L')).toEqual([{ midi: 48, start: 0, dur: 4, hand: 'L', lyric: undefined }]);
  });

  test('kommentarer och F# krockar inte', () => {
    const s = parseTextNotation('# kommentar\nR: F#4 G4 # slut');
    expect(s.notes.map((n) => n.midi)).toEqual([66, 67]);
  });

  test('felaktig ton ger begripligt fel med radnummer', () => {
    expect(() => parseTextNotation('title: x\nR: C4 Q4')).toThrow(/Rad 2.*Q4/);
  });

  test('alla inbyggda låtar går att tolka och har toner', () => {
    for (const s of LIBRARY) expect(s.notes.length).toBeGreaterThan(0);
  });
});

describe('steg', () => {
  test('samtidiga toner blir ett steg, upprepade toner separata steg', () => {
    const s = parseTextNotation('R: G4 G4 [C4 E4]\nL: C3');
    const steps = buildSteps(s.notes);
    expect(steps.map((st) => st.notes.map((n) => n.midi).sort())).toEqual([[48, 67], [67], [60, 64]]);
  });
});

describe('MIDI-import', () => {
  test('tider räknas om till taktslag, två spår = två händer', () => {
    const m = new Midi();
    m.header.setTempo(100);
    const rh = m.addTrack();
    rh.addNote({ midi: 67, ticks: 0, durationTicks: m.header.ppq });
    rh.addNote({ midi: 64, ticks: m.header.ppq, durationTicks: m.header.ppq * 2 });
    const lh = m.addTrack();
    lh.addNote({ midi: 48, ticks: 0, durationTicks: m.header.ppq * 4 });
    const s = parseMidiFile(m.toArray(), 'test.mid');
    expect(s.bpm).toBe(100);
    expect(s.notes.map((n) => [n.midi, n.start, n.dur, n.hand])).toEqual([
      [67, 0, 1, 'R'],
      [64, 1, 2, 'R'],
      [48, 0, 4, 'L'],
    ]);
  });
});

// Grundläggande musikteori: MIDI-nummer <-> namn <-> frekvens.
// MIDI 60 = C4 (mitt-C), MIDI 69 = A4 = 440 Hz (standardstämning).

export type NoteNaming = 'international' | 'svensk';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SHARP_NAMES_SV = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'B', 'H'];

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

export function isBlack(midi: number): boolean {
  return BLACK[((midi % 12) + 12) % 12];
}

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function octaveOf(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/** Tonnamn utan oktav, t.ex. "C#" eller (svensk) "H" för B. */
export function pitchName(midi: number, naming: NoteNaming = 'international'): string {
  const names = naming === 'svensk' ? SHARP_NAMES_SV : SHARP_NAMES;
  return names[pitchClass(midi)];
}

/** Tonnamn med oktav, t.ex. "C4". */
export function noteName(midi: number, naming: NoteNaming = 'international'): string {
  return `${pitchName(midi, naming)}${octaveOf(midi)}`;
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** Kontinuerligt (flyttal) MIDI-värde för en frekvens. */
export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };

/**
 * Tolkar tonnamn som "C4", "F#3", "Bb2", "Eb5", "H3" (svenskt H = B), "Cis4", "Bes3".
 * Svenska/tyska: "B" tolkas som internationellt B (= svenskt H) om inte `naming` är 'svensk',
 * då "B" betyder Bb. "H" betyder alltid B-natural.
 */
export function parseNoteName(text: string, naming: NoteNaming = 'international'): number | null {
  const m = /^([A-Ha-h])(#{1,2}|b{1,2}|is|es|s)?(-?\d)$/.exec(text.trim());
  if (!m) return null;
  let letter = m[1].toUpperCase();
  const acc = m[2] ?? '';
  const octave = parseInt(m[3], 10);
  let pc: number;
  if (letter === 'B' && naming === 'svensk' && acc === '') {
    pc = 10; // svenskt B = Bb
  } else {
    if (!(letter in LETTER_PC)) return null;
    pc = LETTER_PC[letter];
  }
  let shift = 0;
  if (acc === '#' || acc === 'is') shift = 1;
  else if (acc === '##') shift = 2;
  else if (acc === 'b' || acc === 'es' || acc === 's') shift = -1;
  else if (acc === 'bb') shift = -2;
  // Notera: oktavnumret följer bokstaven (Cb4 = B3 i klingande ton, B#3 = C4).
  return (octave + 1) * 12 + pc + shift;
}

export const PIANO_LOWEST = 21; // A0
export const PIANO_HIGHEST = 108; // C8

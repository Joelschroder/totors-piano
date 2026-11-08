// Låtmodellen är instrumentoberoende: en låt är en lista med toner (MIDI-nummer)
// med starttid och längd i taktslag. Instrumentvyn (piano, gitarr, ...) avgör
// sedan hur tonerna ritas och var på instrumentet de spelas.

export type Hand = 'L' | 'R';

export interface NoteEvent {
  midi: number;
  /** Starttid i taktslag (beats) från låtens början. */
  start: number;
  /** Längd i taktslag. */
  dur: number;
  hand?: Hand;
  finger?: number;
  /** Valfri sångtext/stavelse som hör till tonen. */
  lyric?: string;
}

export interface Song {
  id: string;
  title: string;
  composer?: string;
  /** Kort notering, t.ex. om källan är osäker. */
  note?: string;
  bpm: number;
  beatsPerBar: number;
  notes: NoteEvent[];
  /** Källtext om låten skapades från textnotation (för redigering). */
  source?: string;
}

/** Ett steg = allt som ska slås an samtidigt (en ton eller ett ackord). */
export interface Step {
  index: number;
  time: number;
  notes: NoteEvent[];
}

const EPS = 1e-6;

export function sortNotes(notes: NoteEvent[]): NoteEvent[] {
  return [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
}

/**
 * Grupperar toner i steg. Toner vars start ligger inom `tolerance` taktslag
 * räknas som samma anslag (vanligt i MIDI-filer där ackord inte är exakt samtidiga).
 */
export function buildSteps(notes: NoteEvent[], tolerance = 0.02): Step[] {
  const sorted = sortNotes(notes);
  const steps: Step[] = [];
  for (const n of sorted) {
    const last = steps[steps.length - 1];
    if (last && n.start - last.time <= tolerance + EPS) {
      // Samma tangent två gånger i samma steg ger ingen mening – hoppa över dubletter.
      if (!last.notes.some((x) => x.midi === n.midi)) last.notes.push(n);
    } else {
      steps.push({ index: steps.length, time: n.start, notes: [n] });
    }
  }
  return steps;
}

export function filterHands(notes: NoteEvent[], hands: 'both' | Hand): NoteEvent[] {
  if (hands === 'both') return notes;
  return notes.filter((n) => (n.hand ?? 'R') === hands);
}

export function songRange(notes: NoteEvent[]): { min: number; max: number } | null {
  if (notes.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes) {
    if (n.midi < min) min = n.midi;
    if (n.midi > max) max = n.midi;
  }
  return { min, max };
}

export function songLength(notes: NoteEvent[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.start + n.dur);
  return end;
}

/**
 * Om låten saknar handinformation: gissa hand utifrån tonhöjd (under mitt-C = vänster).
 */
export function assignHandsBySplit(notes: NoteEvent[], split = 60): NoteEvent[] {
  return notes.map((n) => (n.hand ? n : { ...n, hand: n.midi < split ? 'L' : 'R' }));
}

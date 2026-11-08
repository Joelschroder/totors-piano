// Import av standard-MIDI-filer (.mid). Tider räknas om till taktslag (beats)
// så att väntläget inte bryr sig om tempo.

import { Midi } from '@tonejs/midi';
import type { Hand, NoteEvent, Song } from '../song';
import { assignHandsBySplit } from '../song';

function guessHandFromTrackName(name: string): Hand | undefined {
  const n = name.toLowerCase();
  if (/(left|vänster|venstre|links|\blh\b|bass|bas\b)/.test(n)) return 'L';
  if (/(right|höger|høyre|rechts|\brh\b|melody|melodi|treble)/.test(n)) return 'R';
  return undefined;
}

export function parseMidiFile(data: ArrayBuffer | Uint8Array, fileName = 'MIDI'): Song {
  const midi = new Midi(data instanceof Uint8Array ? data : new Uint8Array(data));
  const ppq = midi.header.ppq || 480;
  const tracks = midi.tracks.filter((t) => t.notes.length > 0 && t.channel !== 9);
  const notes: NoteEvent[] = [];

  tracks.forEach((track, i) => {
    let hand = guessHandFromTrackName(track.name ?? '');
    // Vanlig konvention för pianofiler med två spår: spår 1 = höger, spår 2 = vänster.
    if (!hand && tracks.length === 2) hand = i === 0 ? 'R' : 'L';
    for (const n of track.notes) {
      notes.push({
        midi: n.midi,
        start: round(n.ticks / ppq),
        dur: Math.max(round(n.durationTicks / ppq), 1 / 16),
        hand,
      });
    }
  });

  const bpm = midi.header.tempos[0]?.bpm ?? 100;
  const ts = midi.header.timeSignatures[0]?.timeSignature;
  const title = (midi.header.name || fileName.replace(/\.(mid|midi)$/i, '')).trim() || 'MIDI-låt';
  return {
    id: `midi-${title}`,
    title,
    bpm: Math.round(bpm),
    beatsPerBar: ts ? ts[0] : 4,
    notes: assignHandsBySplit(notes),
  };
}

/** Avrundar till närmaste 1/96 taktslag för att ta bort små tidsavvikelser. */
function round(beats: number): number {
  return Math.round(beats * 96) / 96;
}

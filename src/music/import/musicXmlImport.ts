// Import av MusicXML (.musicxml / .xml) och komprimerad MusicXML (.mxl).
// MusicXML är det format som MuseScore, Sibelius, Finale, Dorico m.fl. exporterar
// notblad till, så det är huvudvägen för "lägga in notblad".
//
// Stöd: flera stämmor (parts), <chord/>, <backup>/<forward>, ackord, bindebågar (tie),
// paus, flera system (staff 1 = höger hand, staff 2 = vänster hand för piano).
// Ej stöd ännu: repriser/volta, grace notes (hoppas över), transponerande instrument.

import { unzipSync, strFromU8 } from 'fflate';
import type { Hand, NoteEvent, Song } from '../song';
import { assignHandsBySplit } from '../song';

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function child(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) if (c.tagName === name) return c;
  return null;
}
function childText(el: Element, name: string): string | null {
  return child(el, name)?.textContent?.trim() ?? null;
}

export function extractMxl(data: Uint8Array): string {
  const files = unzipSync(data);
  const container = files['META-INF/container.xml'];
  let rootPath: string | undefined;
  if (container) {
    const m = /full-path="([^"]+)"/.exec(strFromU8(container));
    rootPath = m?.[1];
  }
  if (!rootPath || !files[rootPath]) {
    rootPath = Object.keys(files).find((f) => !f.startsWith('META-INF') && /\.(xml|musicxml)$/i.test(f));
  }
  if (!rootPath) throw new Error('Hittade ingen MusicXML-fil i .mxl-arkivet');
  return strFromU8(files[rootPath]);
}

export function parseMusicXml(xml: string, parser: { parseFromString(s: string, t: string): Document } = new DOMParser()): Song {
  const doc = parser.parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.tagName === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('Kunde inte läsa MusicXML (felaktig XML)');
  }
  if (root.tagName === 'score-timewise') throw new Error('score-timewise stöds inte – exportera som partwise');

  const title =
    doc.getElementsByTagName('work-title')[0]?.textContent?.trim() ||
    doc.getElementsByTagName('movement-title')[0]?.textContent?.trim() ||
    'MusicXML-låt';
  const composer = Array.from(doc.getElementsByTagName('creator')).find((c) => c.getAttribute('type') === 'composer')?.textContent?.trim();

  const notes: NoteEvent[] = [];
  let bpm = 0;
  let beatsPerBar = 4;
  const parts = Array.from(root.children).filter((c) => c.tagName === 'part');

  parts.forEach((part, partIndex) => {
    let divisions = 1;
    let time = 0; // i kvartsnoter (MusicXML:s divisions anges per kvartsnot)
    // Öppna bindebågar: midi -> NoteEvent som ska förlängas.
    const openTies = new Map<string, NoteEvent>();
    let lastNoteStart = 0;

    for (const measure of Array.from(part.children).filter((c) => c.tagName === 'measure')) {
      for (const el of Array.from(measure.children)) {
        switch (el.tagName) {
          case 'attributes': {
            const d = childText(el, 'divisions');
            if (d) divisions = parseFloat(d) || 1;
            const t = child(el, 'time');
            if (t && partIndex === 0) {
              const beats = parseInt(childText(t, 'beats') ?? '4', 10);
              beatsPerBar = beats;
            }
            break;
          }
          case 'sound': {
            const tempo = el.getAttribute('tempo');
            if (tempo && !bpm) bpm = parseFloat(tempo);
            break;
          }
          case 'direction': {
            const s = el.getElementsByTagName('sound')[0];
            const tempo = s?.getAttribute('tempo');
            if (tempo && !bpm) bpm = parseFloat(tempo);
            break;
          }
          case 'backup': {
            time -= parseFloat(childText(el, 'duration') ?? '0') / divisions;
            break;
          }
          case 'forward': {
            time += parseFloat(childText(el, 'duration') ?? '0') / divisions;
            break;
          }
          case 'note': {
            if (child(el, 'grace')) break; // förslag hoppas över
            const isChord = !!child(el, 'chord');
            const dur = parseFloat(childText(el, 'duration') ?? '0') / divisions;
            const start = isChord ? lastNoteStart : time;
            const pitch = child(el, 'pitch');
            if (pitch && !child(el, 'rest')) {
              const step = childText(pitch, 'step') ?? 'C';
              const alter = Math.round(parseFloat(childText(pitch, 'alter') ?? '0'));
              const octave = parseInt(childText(pitch, 'octave') ?? '4', 10);
              const midi = (octave + 1) * 12 + STEP_PC[step] + alter;
              const staff = childText(el, 'staff');
              const hand: Hand | undefined = staff === '2' ? 'L' : staff === '1' ? 'R' : undefined;
              const ties = Array.from(el.children).filter((c) => c.tagName === 'tie').map((c) => c.getAttribute('type'));
              const key = `${midi}:${staff ?? ''}:${childText(el, 'voice') ?? ''}`;
              const open = openTies.get(key);
              if (ties.includes('stop') && open) {
                open.dur += dur;
                if (!ties.includes('start')) openTies.delete(key);
              } else {
                const lyricEl = child(el, 'lyric');
                const lyric = lyricEl ? childText(lyricEl, 'text') ?? undefined : undefined;
                const ev: NoteEvent = { midi, start: round(start), dur: Math.max(dur, 1 / 16), hand, lyric };
                notes.push(ev);
                if (ties.includes('start')) openTies.set(key, ev);
              }
            }
            if (!isChord) {
              lastNoteStart = time;
              time += dur;
            }
            break;
          }
        }
      }
    }
  });

  return {
    id: `xml-${title}`,
    title,
    composer,
    bpm: bpm > 0 ? Math.round(bpm) : 90,
    beatsPerBar,
    notes: assignHandsBySplit(notes),
  };
}

function round(beats: number): number {
  return Math.round(beats * 96) / 96;
}

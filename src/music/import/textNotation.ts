// Enkel textnotation för att snabbt skriva in låtar för hand.
//
//   title: Blinka lilla stjärna
//   bpm: 90
//   time: 4            (taktslag per takt)
//   naming: svensk     (valfritt: då betyder B = Bb och H = B)
//   R: C4 C4 G4 G4 | A4 A4 G4:2
//   L: [C3 E3 G3]:4 | [F3 A3 C4]:2 [C3 E3 G3]:2
//
// Token:
//   C4        ton, 1 taktslag (fjärdedel i 4/4)
//   F#4:2     ton med längd 2 taktslag. Längd kan vara 0.5, 1.5 eller 1/2.
//   [C4 E4]:2 ackord
//   r:2  -    paus (r = rest; "-" = 1 taktslag)
//   |         taktstreck (ignoreras, bara för läsbarhet)
//   G4~Ja     sångtext/stavelse kopplad till tonen
// Rader som börjar med "R:" eller "L:" anger hand; varje hand har en egen tidslinje
// som fortsätter där föregående rad för samma hand slutade. Rader utan prefix = höger hand.
// "#" eller "//" inleder kommentar.

import type { Hand, NoteEvent, Song } from '../song';
import { parseNoteName, type NoteNaming } from '../theory';

export class NotationError extends Error {
  constructor(message: string, public line: number) {
    super(`Rad ${line}: ${message}`);
  }
}

function parseDuration(text: string, line: number): number {
  const frac = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(text);
  const v = frac ? parseFloat(frac[1]) / parseFloat(frac[2]) : parseFloat(text);
  if (!isFinite(v) || v <= 0) throw new NotationError(`Ogiltig längd "${text}"`, line);
  return v;
}

/** Delar upp en rad i token, där [ ... ] hålls ihop. */
function tokenize(body: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '[') {
      const close = body.indexOf(']', i);
      if (close < 0) {
        tokens.push(body.slice(i));
        break;
      }
      let end = close + 1;
      while (end < body.length && !/\s/.test(body[end])) end++;
      tokens.push(body.slice(i, end));
      i = end;
      continue;
    }
    let end = i;
    while (end < body.length && !/\s/.test(body[end])) end++;
    tokens.push(body.slice(i, end));
    i = end;
  }
  return tokens;
}

export function parseTextNotation(text: string, id = 'custom'): Song {
  const meta: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  // Första passet: metadata (så att t.ex. naming gäller oavsett ordning).
  for (const raw of lines) {
    const m = /^\s*(title|titel|bpm|tempo|time|takt|naming|namn|composer|kompositör|note|notering)\s*:\s*(.*)$/i.exec(raw);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  const naming: NoteNaming = /sv|h/i.test(meta.naming ?? meta.namn ?? '') ? 'svensk' : 'international';
  const cursor: Record<Hand, number> = { L: 0, R: 0 };
  const notes: NoteEvent[] = [];

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let line = raw.split('//')[0];
    // Kommentar med "#" i början av rad eller efter mellanslag (inte F#4).
    line = line.replace(/(^|\s)#.*$/, '');
    if (!line.trim()) return;
    if (/^\s*(title|titel|bpm|tempo|time|takt|naming|namn|composer|kompositör|note|notering)\s*:/i.test(line)) return;

    let hand: Hand = 'R';
    const hm = /^\s*([RLrlHVhv])\s*:\s*(.*)$/.exec(line);
    let body = line;
    if (hm) {
      const h = hm[1].toUpperCase();
      hand = h === 'L' || h === 'V' ? 'L' : 'R';
      body = hm[2];
    }

    for (const tok of tokenize(body)) {
      if (tok === '|' || tok === '||') continue;
      let core = tok;
      let lyric: string | undefined;
      const tilde = core.indexOf('~');
      if (tilde >= 0) {
        lyric = core.slice(tilde + 1).replace(/_/g, ' ');
        core = core.slice(0, tilde);
      }
      let dur = 1;
      let pitchPart = core;
      const colon = core.lastIndexOf(':');
      if (colon >= 0 && colon > core.lastIndexOf(']')) {
        dur = parseDuration(core.slice(colon + 1), lineNo);
        pitchPart = core.slice(0, colon);
      }
      if (pitchPart === '-' || /^r$/i.test(pitchPart) || /^p$/i.test(pitchPart)) {
        cursor[hand] += dur;
        continue;
      }
      let names: string[];
      if (pitchPart.startsWith('[')) {
        if (!pitchPart.endsWith(']')) throw new NotationError(`Ackord saknar "]": ${tok}`, lineNo);
        names = pitchPart.slice(1, -1).split(/[\s,]+/).filter(Boolean);
      } else {
        names = [pitchPart];
      }
      if (names.length === 0) throw new NotationError(`Tomt ackord: ${tok}`, lineNo);
      names.forEach((name, i) => {
        const midi = parseNoteName(name, naming);
        if (midi === null) throw new NotationError(`Okänd ton "${name}" (skriv t.ex. C4, F#3, Bb2)`, lineNo);
        notes.push({ midi, start: cursor[hand], dur, hand, lyric: i === 0 ? lyric : undefined });
      });
      cursor[hand] += dur;
    }
  });

  const bpm = parseFloat(meta.bpm ?? meta.tempo ?? '');
  const beats = parseInt(meta.time ?? meta.takt ?? '', 10);
  return {
    id,
    title: meta.title ?? meta.titel ?? 'Egen låt',
    composer: meta.composer ?? meta['kompositör'],
    note: meta.note ?? meta.notering,
    bpm: isFinite(bpm) && bpm > 0 ? bpm : 90,
    beatsPerBar: isFinite(beats) && beats > 0 ? beats : 4,
    notes,
    source: text,
  };
}

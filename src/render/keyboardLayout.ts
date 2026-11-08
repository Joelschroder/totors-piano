// Geometri för ett pianoklaviatur. Allt räknas i "vita tangent-bredder" och
// skalas sedan till pixlar. Svarta tangenter sitter inte mitt på skarven mellan
// två vita – på ett riktigt piano är C#/D# och F#/G#/A# förskjutna, vilket gör
// att klaviaturen ser rätt ut och att notstaplarna ovanför hamnar exakt över
// sina tangenter.

import { isBlack, pitchClass } from '../music/theory';

export interface KeyRect {
  midi: number;
  black: boolean;
  x: number;
  w: number;
}

/** Svart tangents mittpunkt relativt skarven mellan vita tangenter (i vita bredder). */
const BLACK_OFFSET: Record<number, number> = { 1: -0.1, 3: 0.1, 6: -0.13, 8: 0, 10: 0.13 };
export const BLACK_WIDTH_RATIO = 0.58;
export const BLACK_HEIGHT_RATIO = 0.63;

/** Antal vita tangenter före `midi` räknat från MIDI 0. */
function whiteIndex(midi: number): number {
  const oct = Math.floor(midi / 12);
  const pc = pitchClass(midi);
  const whitesBefore = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6][pc];
  return oct * 7 + whitesBefore;
}

export class KeyboardLayout {
  readonly lowest: number;
  readonly highest: number;
  readonly whiteCount: number;
  whiteWidth = 1;
  originX = 0;
  private firstWhite: number;
  private rects = new Map<number, KeyRect>();

  constructor(lowest: number, highest: number) {
    // Börja och sluta alltid på vita tangenter.
    if (isBlack(lowest)) lowest--;
    if (isBlack(highest)) highest++;
    this.lowest = lowest;
    this.highest = highest;
    this.firstWhite = whiteIndex(lowest);
    this.whiteCount = whiteIndex(highest) - this.firstWhite + 1;
  }

  /** Anpassa till en pixelbredd. */
  fit(width: number, originX = 0): void {
    this.whiteWidth = width / this.whiteCount;
    this.originX = originX;
    this.rects.clear();
    for (let m = this.lowest; m <= this.highest; m++) this.rects.set(m, this.compute(m));
  }

  private compute(midi: number): KeyRect {
    const W = this.whiteWidth;
    if (!isBlack(midi)) {
      return { midi, black: false, x: this.originX + (whiteIndex(midi) - this.firstWhite) * W, w: W };
    }
    const boundary = this.originX + (whiteIndex(midi) - this.firstWhite) * W; // skarven till höger om föregående vita
    const center = boundary + BLACK_OFFSET[pitchClass(midi)] * W;
    const w = W * BLACK_WIDTH_RATIO;
    return { midi, black: true, x: center - w / 2, w };
  }

  key(midi: number): KeyRect | undefined {
    return this.rects.get(midi);
  }

  contains(midi: number): boolean {
    return midi >= this.lowest && midi <= this.highest;
  }

  /** Vilken tangent finns vid (x, yFrac)? yFrac = 0 vid tangenternas överkant, 1 vid nederkant. */
  hit(x: number, yFrac: number): number | null {
    if (yFrac < BLACK_HEIGHT_RATIO) {
      for (const r of this.rects.values()) if (r.black && x >= r.x && x <= r.x + r.w) return r.midi;
    }
    for (const r of this.rects.values()) if (!r.black && x >= r.x && x < r.x + r.w) return r.midi;
    return null;
  }

  *keys(): IterableIterator<KeyRect> {
    yield* this.rects.values();
  }
}

/**
 * Välj ett tangentomfång som täcker låten med lite marginal, avrundat till hela
 * oktaver (C–B), minst `minOctaves` oktaver och aldrig utanför 88 tangenter.
 */
export function rangeForNotes(min: number, max: number, minOctaves = 2): { lowest: number; highest: number } {
  let lo = Math.floor(min / 12) * 12; // C vid eller under lägsta tonen
  let hi = Math.ceil((max + 1) / 12) * 12; // C över högsta tonen
  while ((hi - lo) / 12 < minOctaves) {
    if (lo > 21 + 12) lo -= 12;
    else hi += 12;
    if ((hi - lo) / 12 < minOctaves && hi >= 108) break;
  }
  return { lowest: Math.max(21, lo), highest: Math.min(108, hi) };
}

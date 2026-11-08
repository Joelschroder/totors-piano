// Spektral mallmatchning: "Finns tonen X i det här spektrumet?"
//
// Eftersom appen vet vilka toner som förväntas behöver vi inte lösa det svåra
// problemet "vilka toner spelas?" (polyfon transkription). Vi löser det mycket
// enklare och mer tillförlitliga problemet "spelas de förväntade tonerna?":
//
//  1. För tonen med grundfrekvens f0 letar vi efter spektraltoppar vid
//     övertonerna h·f0·√(1 + B·h²) (B = pianosträngens inharmonicitet, som gör
//     att övertonerna ligger lite högre än exakta heltalsmultiplar).
//  2. En topp räknas bara om den är ett riktigt lokalt maximum OCH ligger inom
//     ±toleranscent från förväntad frekvens (interpolerad toppfrekvens).
//     Det skiljer på grannhalvtoner.
//  3. Grundtonen måste finnas (för f0 över ~100 Hz). Det skyddar mot att man
//     spelar en kvint eller oktav under: de tonerna har övertoner som träffar
//     vår tons högre övertoner, men inte dess grundton.
//  4. Subharmonikontroll: om det finns tydlig energi vid f0/2 och 3f0/2
//     (eller f0/3 och 2f0/3) spelas troligen en ton en oktav (eller duodecima)
//     under — och då är "vår" ton bara en överton till den.
//
// Funktionen arbetar på ett magnitudspektrum. Detektorn (detector.ts) kör den
// på *differensspektrumet* efter ett anslag (ny energi minus gammal), så att
// toner som fortfarande klingar från förra steget inte räknas igen.

import { midiToFreq } from '../../music/theory';

export interface SpectrumView {
  /** Magnitud per bin (0..N/2). */
  mag: Float64Array;
  sampleRate: number;
  fftSize: number;
  /** Brusgolv (magnitud) att jämföra toppar mot. */
  floor: number;
}

export interface PartialMeasure {
  harmonic: number;
  /** Uppmätt toppfrekvens (Hz) eller 0 om ingen topp hittades. */
  freq: number;
  /** Toppens magnitud (0 om ingen). */
  amp: number;
  /** amp / floor. */
  snr: number;
  /** Avvikelse i cent från förväntad frekvens. */
  cents: number;
}

export interface NoteEvidence {
  midi: number;
  present: boolean;
  /** Sammanvägd styrka, ungefär "antal dB över golvet", för ranking/visning. */
  score: number;
  partials: PartialMeasure[];
  reason?: string;
}

export interface EvidenceOptions {
  a4?: number;
  /** Minsta SNR (linjärt) för att en överton ska räknas som närvarande. */
  minSnr?: number;
  /** Tolerans i cent för toppens frekvens. */
  toleranceCents?: number;
  /** Inharmonicitetskoefficient. */
  inharmonicity?: number;
  /** Högsta frekvens att leta övertoner på. */
  maxFreq?: number;
  /** Max antal övertoner. */
  maxHarmonics?: number;
  /** Toner som också förväntas (subharmoniker som är förväntade straffar inte). */
  alsoExpected?: readonly number[];
  /** Starkaste magnituden i spektrumet (för relativ tröskel). 0 = av. */
  peakRef?: number;
  /** Tonens starkaste delton måste vara minst så här stor andel av peakRef. */
  minRelative?: number;
}

/**
 * Lägre toner vars övertoner sammanfaller med vår tons. `ratios` är den lägre
 * tonens egna deltoner (som andel av vår f0) som INTE delas med vår ton.
 */
const SUBHARMONICS = [
  { semitones: 12, label: 'oktaven under', ratios: [1 / 2, 3 / 2] },
  { semitones: 19, label: 'duodecima under', ratios: [1 / 3, 2 / 3] },
  // Kvinten under delar bara våra jämna deltoner; i mellanregistret fångas den redan av
  // kravet på grundton, så kontrollen behövs bara för basen (där grundtonen kan saknas).
  { semitones: 7, label: 'kvinten under', ratios: [2 / 3, 4 / 3], lowOnly: true },
  { semitones: 24, label: 'två oktaver under', ratios: [1 / 4, 1 / 2, 3 / 4] },
];

const DEFAULTS = {
  a4: 440,
  minSnr: 6,
  toleranceCents: 40,
  inharmonicity: 0.0004,
  maxFreq: 6000,
  maxHarmonics: 6,
  peakRef: 0,
  minRelative: 0.05,
};

/** Söker toppen nära `freq` (Hz). Returnerar interpolerad frekvens och amplitud, eller null. */
export function findPeak(view: SpectrumView, freq: number, toleranceCents: number): { freq: number; amp: number } | null {
  const { mag, sampleRate, fftSize } = view;
  const binHz = sampleRate / fftSize;
  const lo = freq * Math.pow(2, -toleranceCents / 1200);
  const hi = freq * Math.pow(2, toleranceCents / 1200);
  // Fönstret är minst ±1 bin så att låga toner (där en halvton < 2 bins) ändå hittas.
  let kLo = Math.floor(Math.min(lo / binHz, freq / binHz - 1));
  let kHi = Math.ceil(Math.max(hi / binHz, freq / binHz + 1));
  kLo = Math.max(1, kLo);
  kHi = Math.min(mag.length - 2, kHi);
  if (kHi <= kLo) return null;
  let best = -1;
  let bestAmp = 0;
  for (let k = kLo; k <= kHi; k++) {
    if (mag[k] > bestAmp) {
      bestAmp = mag[k];
      best = k;
    }
  }
  if (best < 1) return null;
  // Måste vara ett äkta lokalt maximum (inte en sluttning mot en granntons topp).
  if (mag[best] < mag[best - 1] || mag[best] < mag[best + 1]) return null;
  // Parabolisk interpolation på log-magnitud ger noggrann toppfrekvens med Hann-fönster.
  const a = Math.log(mag[best - 1] + 1e-12);
  const b = Math.log(mag[best] + 1e-12);
  const c = Math.log(mag[best + 1] + 1e-12);
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const peakFreq = (best + shift) * binHz;
  const amp = Math.exp(b - 0.25 * (a - c) * shift);
  if (peakFreq < lo || peakFreq > hi) return null;
  return { freq: peakFreq, amp };
}

function measure(view: SpectrumView, freq: number, harmonic: number, tol: number): PartialMeasure {
  const p = findPeak(view, freq, tol);
  if (!p) return { harmonic, freq: 0, amp: 0, snr: 0, cents: 0 };
  return {
    harmonic,
    freq: p.freq,
    amp: p.amp,
    snr: p.amp / Math.max(view.floor, 1e-12),
    cents: 1200 * Math.log2(p.freq / freq),
  };
}

export function partialFreq(f0: number, h: number, B: number): number {
  return h * f0 * Math.sqrt(1 + B * h * h);
}

export function evaluateNote(view: SpectrumView, midi: number, opts: EvidenceOptions = {}): NoteEvidence {
  const o = { ...DEFAULTS, ...opts };
  const f0 = midiToFreq(midi, o.a4);
  const nyq = view.sampleRate / 2;
  const maxF = Math.min(o.maxFreq, nyq * 0.95);
  const partials: PartialMeasure[] = [];
  for (let h = 1; h <= o.maxHarmonics; h++) {
    const f = partialFreq(f0, h, o.inharmonicity);
    if (f > maxF) break;
    // Högre övertoner får lite större tolerans (inharmoniciteten varierar mellan pianon).
    partials.push(measure(view, f, h, o.toleranceCents + 4 * (h - 1)));
  }
  const ev: NoteEvidence = { midi, present: false, score: 0, partials };
  if (partials.length === 0) {
    ev.reason = 'utanför frekvensområdet';
    return ev;
  }
  // Två nivåer: grundtonen måste vara tydlig (minSnr), medan stödjande övertoner
  // räcker med en lägre nivå – vid låg mikrofonnivå drunknar de svagare övertonerna
  // annars i bruset fast tonen hörs tydligt.
  const weakSnr = Math.max(3, o.minSnr / 3);
  const present = partials.map((p, i) => p.snr >= (i === 0 ? o.minSnr : weakSnr));
  const nPresent = present.filter(Boolean).length;
  ev.score = partials.reduce((s, p) => s + (p.snr > 1 ? (20 * Math.log10(p.snr)) / p.harmonic : 0), 0);

  const lowNote = f0 < 100;
  if (!lowNote && !present[0]) {
    ev.reason = 'grundton saknas';
    return ev;
  }
  // Krav på stöd från övertoner. Höga toner har få övertoner under maxFreq,
  // då räcker en mycket tydlig grundton.
  const available = partials.length;
  if (available >= 3) {
    if (nPresent < 2) {
      ev.reason = 'för få övertoner';
      return ev;
    }
  } else if (available === 2) {
    if (!(present[0] && (present[1] || partials[0].snr >= o.minSnr * 3))) {
      ev.reason = 'för svag';
      return ev;
    }
  } else if (partials[0].snr < o.minSnr * 2) {
    ev.reason = 'för svag';
    return ev;
  }
  // Pianotoner i mellanregistret har nästan alltid en tydlig andra delton. Saknas den
  // är det troligen en högre tons grundton som råkar ligga på vår tredje delton.
  if (!lowNote && f0 < 1000 && partials.length >= 2 && !present[1]) {
    ev.reason = 'andra deltonen saknas';
    return ev;
  }
  if (lowNote && !(present[0] || (present[1] && present[2]))) {
    ev.reason = 'basens övertoner saknas';
    return ev;
  }

  // Tonens starkaste delton måste vara en rimlig andel av det starkaste i spektrumet
  // (annars är det bara resonans/läckage, t.ex. klangbotten eller en annan tons skvalp).
  const strongest = Math.max(...partials.map((p) => p.amp));
  if (o.peakRef > 0 && strongest < o.peakRef * o.minRelative) {
    ev.reason = 'för svag jämfört med resten av ljudet';
    return ev;
  }

  // "Övertonsmönster": spelas en ton en oktav (eller duodecima/kvint) ÖVER vår,
  // träffar den bara våra övertoner som är jämna (resp. delbara med 3). Hos en
  // äkta ton finns energi även på de andra (framför allt grundtonen).
  for (const k of [2, 3]) {
    const multiples = partials.filter((p) => p.harmonic % k === 0).map((p) => p.amp);
    if (multiples.length === 0) continue;
    const others = Math.max(...partials.filter((p) => p.harmonic % k !== 0).map((p) => p.amp));
    if (others < Math.max(...multiples) * 0.25) {
      ev.reason = k === 2 ? 'bara jämna övertoner (oktaven över?)' : 'bara var tredje överton (duodecima över?)';
      return ev;
    }
  }

  // Subharmonikontroll: spelas egentligen en lägre ton vars övertoner råkar
  // sammanfalla med våra? Vi letar efter den lägre tonens *egna* deltoner, som
  // inte delas med vår ton. Hittas tydlig energi där är vår ton bara en överton.
  const expected = new Set(o.alsoExpected ?? []);
  // Frekvenser som förklaras av ANDRA förväntade toners deltoner (i ett ackord)
  // kan inte användas som bevis för en felaktig lägre ton.
  const others = [...expected].filter((m) => m !== midi).map((m) => midiToFreq(m, o.a4));
  const explainedByOthers = (f: number) =>
    others.some((of) => {
      for (let h = 1; h <= 10; h++) {
        const pf = partialFreq(of, h, o.inharmonicity);
        if (Math.abs(1200 * Math.log2(f / pf)) < 35) return true;
        if (pf > f * 1.1) break;
      }
      return false;
    });
  const ownRef = Math.max(partials[0].amp, partials[1]?.amp ?? 0);
  for (const sub of SUBHARMONICS) {
    if ('lowOnly' in sub && sub.lowOnly && !lowNote) continue;
    const lowerMidi = midi - sub.semitones;
    if (expected.has(lowerMidi)) continue;
    let unshared = 0;
    for (const r of sub.ratios) {
      const f = f0 * r;
      if (f < 25 || explainedByOthers(f)) continue;
      const m = measure(view, f, 1, o.toleranceCents);
      if (m.snr >= o.minSnr) unshared = Math.max(unshared, m.amp);
    }
    // 0.35: den lägre tonens egna deltoner måste vara jämförbara med våra. Svagare
    // energi där kommer typiskt från klangbottenresonans/medsvängning, inte en spelad ton.
    if (unshared >= ownRef * 0.35) {
      ev.reason = `låter som ${sub.label}`;
      return ev;
    }
  }

  // Grannkonkurrens: är en icke förväntad grannton (±1–2 halvtoner) mycket starkare
  // är vår "topp" sannolikt bara läckage/medsvängning från den.
  for (const d of [-2, -1, 1, 2]) {
    if (expected.has(midi + d)) continue;
    const nf = midiToFreq(midi + d, o.a4);
    if (explainedByOthers(nf)) continue;
    const m = measure(view, nf, 1, 30);
    if (m.amp > partials[0].amp * 2.5 && m.snr >= o.minSnr) {
      ev.reason = 'en grannton är starkare';
      return ev;
    }
  }

  ev.present = true;
  return ev;
}

/** Median av magnitud i ett frekvensband – används som brusgolv. */
export function bandMedian(mag: Float64Array, sampleRate: number, fftSize: number, fLo = 40, fHi = 5000): number {
  const binHz = sampleRate / fftSize;
  const k0 = Math.max(1, Math.floor(fLo / binHz));
  const k1 = Math.min(mag.length - 1, Math.ceil(fHi / binHz));
  const arr = Array.from(mag.subarray(k0, k1 + 1));
  arr.sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] ?? 0;
}

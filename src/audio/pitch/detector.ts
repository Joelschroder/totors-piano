// Strömmande tondetektor för mikrofon.
//
// Flöde per "hop" (512 samples ≈ 11 ms):
//   1. Kort FFT (2048) → spektralt flöde (spectral flux) → anslagsdetektion (onset).
//   2. Lång FFT (8192 ≈ 170 ms vid 48 kHz) → fin frekvensupplösning för tonverifiering.
//   3. Vid ett anslag sparas spektrumet från strax innan som referens. Under de
//      följande ~250 ms jämförs nytt spektrum med referensen: differensen
//      (endast ny energi) matchas mot övertonsmallar för de *förväntade* tonerna.
//   4. MPM (monofon tonhöjd) körs parallellt för att visa vilken ton som hörs
//      och för att kunna säga "fel ton" när inget förväntat hittas.
//
// All logik är ren TypeScript utan Web Audio, så den kan testas i Node med
// syntetiska och inspelade pianoljud (se tests/detector.test.ts).

import { FFT, hann } from './fft';
import { mpm } from './mpm';
import { bandMedian, evaluateNote, type NoteEvidence } from './noteEvidence';
import { freqToMidi, midiToFreq } from '../../music/theory';

export type DetectorEvent =
  | { type: 'onset'; time: number; strength: number }
  | { type: 'note'; midi: number; time: number; onsetTime: number; latency: number; evidence: NoteEvidence }
  | { type: 'pitch'; time: number; midi: number; freq: number; clarity: number }
  | { type: 'wrong'; time: number; midi: number };

export interface DetectorOptions {
  sampleRate: number;
  a4?: number;
  /** 0..1, högre = känsligare (lägre trösklar). */
  sensitivity?: number;
  hop?: number;
}

/** Antal hop i rad (à ~11 ms) en ton måste vara närvarande innan den godkänns. */
const CONFIRM_HOPS = 3;

interface EvalWindow {
  onsetTime: number;
  onsetHop: number;
  ref: Float64Array;
  found: Set<number>;
  /** Antal hop i rad som en ton varit närvarande (kräver CONFIRM_HOPS i rad). */
  candidates: Map<number, number>;
  /** Senaste MPM-tonhöjder under fönstret (för fel-ton-feedback). */
  pitches: number[];
  closed: boolean;
  /** Skapat av den riktade (tonspecifika) anslagsdetektorn – rapporterar inte "fel ton". */
  targeted?: boolean;
}

/** Antal hop som den riktade anslagsdetektorn ser bakåt (~350 ms). */
const TARGET_HISTORY = 32;
/** Energiökning (linjär amplitud) på förväntad tons deltoner som räknas som anslag (≈ +10 dB). */
const TARGET_RISE = 3.2;

export class NoteDetector {
  readonly sampleRate: number;
  readonly hop: number;
  readonly longSize: number;
  readonly shortSize = 2048;
  a4: number;
  sensitivity: number;

  private ring: Float32Array;
  private ringPos = 0;
  private filled = 0;
  private pending = 0;
  private hopCount = 0;

  private longFft: FFT;
  private shortFft: FFT;
  private longWin: Float64Array;
  private shortWin: Float64Array;
  private longScale: number;
  private shortScale: number;
  private frame: Float64Array;

  private magHistory: Float64Array[] = [];
  /** Per förväntad ton: energi på dess första deltoner, ett värde per hop. */
  private noteEnergy = new Map<number, number[]>();
  /** Antal hop i rad som stigningsvillkoret varit uppfyllt per ton. */
  private targetStreak = new Map<number, number>();
  private lastTargetHop = -1000;
  private prevShortLog: Float64Array | null = null;
  private fluxHistory: number[] = [];
  private lastFlux = [0, 0];
  private lastOnsetHop = -1000;
  private lastOnsetStrength = 0;
  private noiseRms = 0.0005;

  private expected: number[] = [];
  private windows: EvalWindow[] = [];
  private lastConfirmTime = -Infinity;

  /** Valfri felsökningskrok: anropas för varje utvärdering av en förväntad ton. */
  onEvaluate?: (midi: number, evidence: NoteEvidence, ageSec: number) => void;
  /** Senaste nivå i dBFS (för nivåmätare). */
  levelDb = -100;
  /** Senaste tydliga tonhöjd (för visning). */
  lastPitch: { midi: number; freq: number; clarity: number } | null = null;

  constructor(opts: DetectorOptions) {
    this.sampleRate = opts.sampleRate;
    this.a4 = opts.a4 ?? 440;
    this.sensitivity = opts.sensitivity ?? 0.5;
    this.hop = opts.hop ?? 512;
    // ~170 ms fönster oavsett samplingsfrekvens: 8192 @ 44.1/48 kHz, 16384 @ 88.2/96 kHz.
    this.longSize = opts.sampleRate > 60000 ? 16384 : 8192;
    this.ring = new Float32Array(this.longSize);
    this.longFft = new FFT(this.longSize);
    this.shortFft = new FFT(this.shortSize);
    this.longWin = hann(this.longSize);
    this.shortWin = hann(this.shortSize);
    this.longScale = 2 / this.longWin.reduce((a, b) => a + b, 0);
    this.shortScale = 2 / this.shortWin.reduce((a, b) => a + b, 0);
    this.frame = new Float64Array(this.longSize);
  }

  /** Sätt vilka toner som förväntas just nu (nästa steg i låten). */
  setExpected(midis: readonly number[]): void {
    this.expected = [...midis];
    // Den riktade anslagsdetektorn börjar om: bara stigningar EFTER detta räknas.
    this.noteEnergy = new Map(this.expected.map((m) => [m, []]));
    this.targetStreak.clear();
    // Anslag som redan godkänt föregående steg får inte räknas igen för nästa
    // (annars skulle t.ex. "G G" klaras av med ett enda anslag).
    for (const w of this.windows) if (w.onsetTime <= this.lastConfirmTime) w.closed = true;
  }

  /**
   * Markera att ett steg precis klarades av ett anslag vid `onsetTime`
   * (från note-händelsen). Fönster från det anslaget eller tidigare stängs;
   * senare anslag (snabbt spel) får fortsätta räknas mot nästa steg.
   */
  markConfirmed(onsetTime: number): void {
    this.lastConfirmTime = Math.max(this.lastConfirmTime, onsetTime);
    for (const w of this.windows) if (w.onsetTime <= this.lastConfirmTime) w.closed = true;
  }

  get minSnr(): number {
    // Känslighet 0 → 14 (≈23 dB), 1 → 4 (≈12 dB).
    return 14 - 10 * this.sensitivity;
  }

  timeNow(): number {
    return (this.hopCount * this.hop) / this.sampleRate;
  }

  push(samples: Float32Array): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringPos] = samples[i];
      this.ringPos = (this.ringPos + 1) % this.ring.length;
      if (this.filled < this.ring.length) this.filled++;
      this.pending++;
      if (this.pending >= this.hop) {
        this.pending = 0;
        this.hopCount++;
        this.processHop(events);
      }
    }
    return events;
  }

  private partialEnergy(mag: Float64Array, midi: number): number {
    const f0 = midiToFreq(midi, this.a4);
    const binHz = this.sampleRate / this.longSize;
    let e = 0;
    for (let h = 1; h <= 3; h++) {
      const f = h * f0 * Math.sqrt(1 + 0.0004 * h * h);
      const lo = Math.max(1, Math.floor(Math.min((f * 0.977) / binHz, f / binHz - 1)));
      const hi = Math.min(mag.length - 1, Math.ceil(Math.max((f * 1.024) / binHz, f / binHz + 1)));
      let m = 0;
      for (let k = lo; k <= hi; k++) if (mag[k] > m) m = mag[k];
      e += m;
    }
    return e;
  }

  private detectTargetedOnsets(mag: Float64Array, t: number, events: DetectorEvent[]): void {
    const floor = bandMedian(mag, this.sampleRate, this.longSize);
    for (const midi of this.expected) {
      const hist = this.noteEnergy.get(midi);
      if (!hist) continue;
      const e = this.partialEnergy(mag, midi);
      hist.push(e);
      if (hist.length > TARGET_HISTORY) hist.shift();
      if (hist.length < 4) continue;
      // Minsta energin under de senaste ~350 ms (ej de allra senaste hoppen).
      let minIdx = 0;
      for (let i = 1; i < hist.length - 2; i++) if (hist[i] < hist[minIdx]) minIdx = i;
      const minE = hist[minIdx];
      const loud = e > floor * 3 * 8; // deltonerna i snitt ~18 dB över brusgolvet
      if (!(e > minE * TARGET_RISE && loud)) {
        this.targetStreak.set(midi, 0);
        continue;
      }
      // Inom ett långt FFT-fönster (+ marginal) efter ett anslag stiger energin fortfarande
      // av SAMMA anslag (fönstret fylls). Då får den riktade detektorn inte lösa ut –
      // annars kunde ett enda anslag räknas två gånger (t.ex. för "G G").
      const settle = Math.ceil(this.longSize / this.hop) + 6;
      const recent = this.windows.some((w) => this.hopCount - w.onsetHop < settle);
      if (recent || this.hopCount - this.lastTargetHop < settle) {
        hist.splice(0, hist.length - 1);
        this.targetStreak.set(midi, 0);
        continue;
      }
      // Ge den globala anslagsdetektorn företräde: stigningen måste hålla i sig några hop.
      const streak = (this.targetStreak.get(midi) ?? 0) + 1;
      this.targetStreak.set(midi, streak);
      if (streak < 3) continue;
      // Anslagstid ≈ sista hoppet där energin fortfarande låg nära miniminivån.
      let startIdx = minIdx;
      for (let i = minIdx; i < hist.length; i++) if (hist[i] <= minE * 1.5) startIdx = i;
      const back = hist.length - 1 - startIdx;
      const refIdx = Math.max(0, this.magHistory.length - 1 - back);
      this.lastTargetHop = this.hopCount;
      this.targetStreak.set(midi, 0);
      this.windows.push({
        onsetTime: t - (back * this.hop) / this.sampleRate,
        onsetHop: this.hopCount - back,
        ref: this.magHistory[refIdx],
        found: new Set(),
        candidates: new Map(),
        pitches: [],
        closed: false,
        targeted: true,
      });
      if (this.windows.length > 4) this.windows.shift();
      events.push({ type: 'onset', time: t, strength: e / Math.max(minE, 1e-12) });
      hist.splice(0, hist.length - 1);
    }
  }

  private processHop(events: DetectorEvent[]): void {
    const N = this.longSize;
    // Linjärisera ringbufferten (äldst först).
    for (let i = 0; i < N; i++) this.frame[i] = this.ring[(this.ringPos + i) % N];
    const t = this.timeNow();

    // --- Nivå ---
    const shortStart = N - this.shortSize;
    let sumSq = 0;
    for (let i = shortStart; i < N; i++) sumSq += this.frame[i] * this.frame[i];
    const rms = Math.sqrt(sumSq / this.shortSize);
    this.levelDb = 20 * Math.log10(rms + 1e-9);

    // --- Kort FFT: anslagsdetektion ---
    this.shortFft.forwardReal(this.frame.subarray(shortStart), this.shortWin);
    const shortMag = new Float64Array(this.shortSize / 2 + 1);
    this.shortFft.magnitudes(shortMag, this.shortScale);
    const binHzS = this.sampleRate / this.shortSize;
    const k0 = Math.max(1, Math.floor(40 / binHzS));
    const k1 = Math.min(shortMag.length - 1, Math.ceil(6000 / binHzS));
    // Log-kompression relativt brusgolvet: flödet mäter då "hur många dB steg
    // komponenterna över bruset", oberoende av hur högt man spelar.
    const gamma = Math.min(50000, Math.max(1000, 9 / Math.max(this.noiseRms, 2e-5)));
    const logMag = new Float64Array(shortMag.length);
    for (let k = k0; k <= k1; k++) logMag[k] = Math.log1p(gamma * shortMag[k]);
    let flux = 0;
    if (this.prevShortLog) {
      for (let k = k0; k <= k1; k++) {
        const d = logMag[k] - this.prevShortLog[k];
        if (d > 0) flux += d;
      }
    }
    this.prevShortLog = logMag;

    // Peak picking med en hops fördröjning: flux[t-1] är lokal topp över tröskeln.
    const [f2, f1] = this.lastFlux; // f2 = t-2, f1 = t-1
    // Adaptiv tröskel från bakgrundens egen statistik: median + k·MAD (medianavvikelse).
    // Vid starkt brus är bakgrundsflödet högt men jämnt, så tröskeln följer spridningen
    // i stället för att multiplicera medianen (vilket missade svaga anslag).
    const hist = this.fluxHistory.slice(-32).sort((a, b) => a - b);
    const med = hist.length ? hist[Math.floor(hist.length / 2)] : 0;
    const devs = hist.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = devs.length ? devs[Math.floor(devs.length / 2)] : 0;
    const kMad = 3 + 3 * (1 - this.sensitivity);
    const minDelta = 3 + 6 * (1 - this.sensitivity);
    // Efter ett starkt anslag höjs tröskeln tillfälligt (avklingar på ~150 ms) så att
    // efterklang/dubbeltoppar i samma anslag inte räknas som ett nytt anslag.
    const sinceLast = ((this.hopCount - 1 - this.lastOnsetHop) * this.hop) / this.sampleRate;
    const masking = this.lastOnsetStrength * 0.5 * Math.exp(-sinceLast / 0.15);
    const threshold = Math.max(med + Math.max(minDelta, kMad * mad), masking);
    // Låg spärr: en telefon en bit från pianot ger bara ~10–20 dB över bruset.
    // Själva anslagsbeslutet tas av flödet (flux) med adaptiv tröskel.
    const gate = Math.max(0.00015, this.noiseRms * 1.6);
    const isOnset = f1 > threshold && f1 >= f2 && f1 >= flux && rms > gate && this.hopCount - this.lastOnsetHop > 5;
    this.lastFlux = [f1, flux];
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 64) this.fluxHistory.shift();

    // Brusnivå ("minimum statistics"): följer snabbt nedåt, kryper långsamt uppåt
    // (≈ +0,5 dB/s), så att ihållande toner inte tolkas som brus.
    if (rms < this.noiseRms) this.noiseRms = 0.7 * this.noiseRms + 0.3 * rms;
    else this.noiseRms = Math.min(rms, this.noiseRms * 1.0006);

    // --- Lång FFT ---
    this.longFft.forwardReal(this.frame, this.longWin);
    const mag = new Float64Array(N / 2 + 1);
    this.longFft.magnitudes(mag, this.longScale);
    this.magHistory.push(mag);
    if (this.magHistory.length > TARGET_HISTORY) this.magHistory.shift();

    if (isOnset && this.filled >= N / 4) {
      this.lastOnsetHop = this.hopCount - 1;
      this.lastOnsetStrength = f1;
      // Referens = spektrum från innan anslaget nådde det långa fönstret märkbart.
      const ref = this.magHistory[Math.max(0, this.magHistory.length - 4)];
      this.windows.push({
        onsetTime: t - this.hop / this.sampleRate,
        onsetHop: this.hopCount - 1,
        ref,
        found: new Set(),
        candidates: new Map(),
        pitches: [],
        closed: false,
      });
      if (this.windows.length > 4) this.windows.shift();
      events.push({ type: 'onset', time: t, strength: f1 });
    }

    // --- Riktad anslagsdetektion ---
    // Vi vet vilka toner som väntas, så vi bevakar energin på just deras deltoner.
    // Stiger den kraftigt räknas det som ett anslag även om det globala flödet
    // inte märkte något (svagt anslag, brus, efterklang från föregående ton).
    this.detectTargetedOnsets(mag, t, events);

    // --- Monofon tonhöjd (visning / fel-ton) ---
    if (rms > gate && this.hopCount % 2 === 0) {
      const p = mpm(this.frame.subarray(N - 4096), this.sampleRate, 40, 4200, 0.9);
      if (p && p.clarity > 0.85) {
        const m = freqToMidi(p.freq, this.a4);
        this.lastPitch = { midi: m, freq: p.freq, clarity: p.clarity };
        events.push({ type: 'pitch', time: t, midi: m, freq: p.freq, clarity: p.clarity });
        for (const w of this.windows) if (!w.closed) w.pitches.push(Math.round(m));
      }
    } else if (rms <= gate) {
      this.lastPitch = null;
    }

    // --- Verifiera förväntade toner i öppna fönster ---
    const evalHops = Math.ceil((0.3 * this.sampleRate) / this.hop);
    const minSnr = this.minSnr;
    const magFloor = bandMedian(mag, this.sampleRate, N);
    for (const w of this.windows) {
      if (w.closed) continue;
      const age = this.hopCount - w.onsetHop;
      if (age > evalHops) {
        w.closed = true;
        if (w.found.size === 0 && !w.targeted && w.pitches.length >= 2) {
          // Inget förväntat hittades: vanligaste tydliga tonhöjden = fel ton.
          const counts = new Map<number, number>();
          for (const p of w.pitches) counts.set(p, (counts.get(p) ?? 0) + 1);
          let best = -1;
          let bestN = 0;
          for (const [m, n] of counts) if (n > bestN) [best, bestN] = [m, n];
          if (best > 0 && !this.expected.includes(best)) events.push({ type: 'wrong', time: t, midi: best });
        }
        continue;
      }
      if (age < 3 || this.expected.length === 0) continue;
      const diff = new Float64Array(mag.length);
      let maxDiff = 0;
      for (let k = 0; k < mag.length; k++) {
        const d = mag[k] - w.ref[k];
        diff[k] = d > 0 ? d : 0;
        if (diff[k] > maxDiff) maxDiff = diff[k];
      }
      const diffFloor = Math.max(bandMedian(diff, this.sampleRate, N), magFloor * 0.5, maxDiff * 0.004, 1e-7);
      const view = { mag: diff, sampleRate: this.sampleRate, fftSize: N, floor: diffFloor };
      const nextCandidates = new Map<number, number>();
      const ageSec = (age * this.hop) / this.sampleRate;
      for (const midi of this.expected) {
        if (w.found.has(midi)) continue;
        // Låga frekvenser (och kontrollen av subharmoniker f0/2, f0/3) behöver
        // fler perioder i fönstret innan beslutet är tillförlitligt.
        if (ageSec < Math.min(0.2, 24 / midiToFreq(midi, this.a4))) continue;
        const ev = evaluateNote(view, midi, { a4: this.a4, minSnr, alsoExpected: this.expected, peakRef: maxDiff });
        // Riktade anslag (utan globalt flöde) är en reserv för svaga/brusiga lägen. De
        // måste även hålla mot HELA spektrumet: en klingande lägre ton vars delton råkar
        // "blomma upp" får inte se ut som en ny ton.
        if (ev.present && w.targeted) {
          const full = evaluateNote({ mag, sampleRate: this.sampleRate, fftSize: N, floor: magFloor }, midi, {
            a4: this.a4,
            minSnr,
            alsoExpected: this.expected,
          });
          if (!full.present) {
            ev.present = false;
            ev.reason = `helspektrum: ${full.reason}`;
          }
        }
        this.onEvaluate?.(midi, ev, ageSec);
        if (!ev.present) continue;
        // Tonen måste synas i flera hop i rad – slumpmässiga toppar från anslagets
        // brus (hammarslag) och tidiga, ännu ej utvecklade spektra sorteras bort.
        const streak = (w.candidates.get(midi) ?? 0) + 1;
        if (streak >= CONFIRM_HOPS) {
          // Markera tonen som hittad i alla öppna fönster med närliggande anslag,
          // så att ett brutet ackord inte rapporterar samma ton flera gånger.
          for (const o of this.windows) if (Math.abs(o.onsetTime - w.onsetTime) < 0.15) o.found.add(midi);
          events.push({ type: 'note', midi, time: t, onsetTime: w.onsetTime, latency: t - w.onsetTime, evidence: ev });
        } else {
          nextCandidates.set(midi, streak);
        }
      }
      w.candidates = nextCandidates;
    }
    this.windows = this.windows.filter((w) => !w.closed || this.hopCount - w.onsetHop < 200);
  }
}

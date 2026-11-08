// McLeod Pitch Method (MPM): robust monofon tonhöjdsdetektion via
// normaliserad kvadratisk differensfunktion (NSDF). Används för att visa
// "du spelar: X" och för att ge feedback på fel ton. Själva godkännandet av
// förväntade toner görs med spektral mallmatchning (noteEvidence.ts) som
// även klarar ackord.

import { FFT } from './fft';

export interface PitchEstimate {
  freq: number;
  /** 0..1, hur periodisk signalen är. > 0.9 = tydlig ton. */
  clarity: number;
}

const fftCache = new Map<number, FFT>();

export function mpm(buf: ArrayLike<number>, sampleRate: number, minFreq = 27, maxFreq = 4200, k = 0.9): PitchEstimate | null {
  const n = buf.length;
  const maxLag = Math.min(n - 2, Math.floor(sampleRate / minFreq));
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const nsdf = new Float64Array(maxLag + 2);

  // Autokorrelation via FFT (O(n log n)) istället för O(n·lag).
  let size = 1;
  while (size < 2 * n) size <<= 1;
  let fft = fftCache.get(size);
  if (!fft) {
    fft = new FFT(size);
    fftCache.set(size, fft);
  }
  fft.forwardReal(buf);
  const { re, im } = fft;
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  // Invers FFT = konjugera, framåt, konjugera (realdelen räcker).
  const power = Float64Array.from(re);
  fft.forwardReal(power);
  // Kumulativa kvadratsummor för normaliseringen m(tau).
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sq[i + 1] = sq[i] + buf[i] * buf[i];
  for (let tau = 0; tau <= maxLag + 1; tau++) {
    const acf = fft.re[tau] / size;
    const m = sq[n - tau] + (sq[n] - sq[tau]);
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Hitta topp i varje positiv "lob" efter första nollgenomgången.
  const peaks: number[] = [];
  let tau = 1;
  while (tau < maxLag && nsdf[tau] > 0) tau++;
  while (tau < maxLag) {
    while (tau < maxLag && nsdf[tau] <= 0) tau++;
    let best = -1;
    let bestVal = -Infinity;
    while (tau < maxLag && nsdf[tau] > 0) {
      if (nsdf[tau] > bestVal) {
        bestVal = nsdf[tau];
        best = tau;
      }
      tau++;
    }
    if (best > 0) peaks.push(best);
  }
  if (peaks.length === 0) return null;

  let highest = 0;
  for (const p of peaks) highest = Math.max(highest, nsdf[p]);
  const threshold = k * highest;
  const chosen = peaks.find((p) => nsdf[p] >= threshold && p >= minLag);
  if (chosen === undefined) return null;

  // Parabolisk interpolation för sub-sample-precision.
  const a = nsdf[chosen - 1];
  const b = nsdf[chosen];
  const c = nsdf[chosen + 1] ?? b;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  const period = chosen + shift;
  const clarity = Math.min(1, b - 0.25 * (a - c) * shift);
  return { freq: sampleRate / period, clarity };
}

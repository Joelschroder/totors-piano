// Liten, beroendefri radix-2 FFT. Tabeller förberäknas per storlek.

export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT-storlek måste vara en tvåpotens');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** Transformerar `input` (realvärd) multiplicerad med `window`. Resultat i this.re/this.im. */
  forwardReal(input: ArrayLike<number>, window?: Float64Array): void {
    const n = this.size;
    const { re, im, rev } = this;
    for (let i = 0; i < n; i++) {
      const v = i < input.length ? input[i] * (window ? window[i] : 1) : 0;
      re[rev[i]] = v;
      im[rev[i]] = 0;
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const wr = this.cos[j * step];
          const wi = this.sin[j * step];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /** Magnitud för bin 0..N/2 skalad så att en sinus med amplitud A ger toppvärde ≈ A/2 (med Hann). */
  magnitudes(out: Float64Array, scale: number): void {
    const { re, im } = this;
    for (let k = 0; k < out.length; k++) out[k] = Math.hypot(re[k], im[k]) * scale;
  }
}

export function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

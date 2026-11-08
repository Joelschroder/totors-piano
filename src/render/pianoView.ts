// Pianovyn: "notfall"/tidslinje ovanför ett liggande klaviatur.
//
// Layout (uppifrån och ner):
//   ┌──────────────────────────────────────────┐
//   │  kommande toner (staplar)  ↓ rör sig ner │  ← tidslinje, 1 taktslag = pxPerBeat
//   │  ▮     ▮▮                                │    stapelns längd = tonens längd
//   │══════════ träfflinje (glöd) ═════════════│  ← aktuellt steg vilar här
//   │ ▌▐▌▐ ▌▐▌▐▌▐ ▌ klaviatur ▌▐▌▐ ▌▐▌▐▌▐ ▌    │
//   └──────────────────────────────────────────┘
//
// Varje stapel står exakt ovanför sin tangent (samma x och bredd), så ögat bara
// behöver följa stapeln rakt ner. I väntläge glider tidslinjen mjukt ner till
// nästa steg först när rätt toner spelats.

import { pitchName, noteName, type NoteNaming } from '../music/theory';
import type { NoteEvent, Song } from '../music/song';
import type { PracticeSession } from '../practice/session';
import { BLACK_HEIGHT_RATIO, KeyboardLayout } from './keyboardLayout';
import { ParticleSystem, withAlpha } from './particles';

export interface ViewSettings {
  naming: NoteNaming;
  /** Visa tonnamn på alla vita tangenter (annars bara C). */
  allKeyLabels: boolean;
  /** Antal taktslag som syns ovanför träfflinjen. */
  beatsVisible: number;
  /** Visa den hand som inte övas som svaga "spöktoner". */
  showOtherHand: boolean;
}

export const COLORS = {
  R: { base: 'hsl(192, 92%, 56%)', dark: 'hsl(200, 85%, 42%)', light: 'hsl(188, 100%, 78%)' },
  L: { base: 'hsl(30, 96%, 58%)', dark: 'hsl(22, 90%, 44%)', light: 'hsl(38, 100%, 78%)' },
  good: 'hsl(140, 80%, 55%)',
  bad: 'hsl(355, 88%, 60%)',
  hit: 'hsl(190, 100%, 75%)',
};

interface KeyState {
  /** 0..1 glöd som klingar av efter släpp. */
  glow: number;
  color: string;
  held: boolean;
  wrong: boolean;
}

export class PianoView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  layout: KeyboardLayout;
  settings: ViewSettings;
  particles = new ParticleSystem();

  private session: PracticeSession | null = null;
  private song: Song | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private kbTop = 0;
  private kbHeight = 0;
  private kbLeft = 0;
  private kbWidth = 0;
  private bgGradient: CanvasGradient | null = null;

  scrollBeat = 0;
  private keyStates = new Map<number, KeyState>();
  private time = 0;
  private stepFlash = 0;
  private shake = 0;
  /** Senast detekterade tonhöjd från mikrofonen (visas som markör). */
  micPitch: number | null = null;

  constructor(canvas: HTMLCanvasElement, layout: KeyboardLayout, settings: ViewSettings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.layout = layout;
    this.settings = settings;
  }

  setSession(session: PracticeSession, song: Song): void {
    this.session = session;
    this.song = song;
    this.scrollBeat = session.targetBeat - 1.5;
    this.keyStates.clear();
  }

  setLayout(layout: KeyboardLayout): void {
    this.layout = layout;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    // Klaviaturen: max ~70 px per vit tangent, centrerad.
    const maxKey = 72;
    const pad = 12;
    this.kbWidth = Math.min(this.width - pad * 2, this.layout.whiteCount * maxKey);
    this.kbLeft = (this.width - this.kbWidth) / 2;
    this.layout.fit(this.kbWidth, this.kbLeft);
    const ww = this.layout.whiteWidth;
    this.kbHeight = Math.max(90, Math.min(this.height * 0.3, ww * 5.2));
    this.kbTop = this.height - this.kbHeight;
    this.bgGradient = this.ctx.createLinearGradient(0, 0, 0, this.kbTop);
    this.bgGradient.addColorStop(0, '#05070f');
    this.bgGradient.addColorStop(0.65, '#0a1022');
    this.bgGradient.addColorStop(1, '#101a36');
  }

  /** Koordinat för tangentens topp (träfflinjen) – för partiklar m.m. */
  keyAnchor(midi: number): { x: number; y: number } | null {
    const k = this.layout.key(midi);
    if (!k) return null;
    return { x: k.x + k.w / 2, y: this.kbTop };
  }

  /** Vilken tangent ligger under en punkt (i CSS-pixlar)? */
  keyAt(x: number, y: number): number | null {
    if (y < this.kbTop) return null;
    return this.layout.hit(x, (y - this.kbTop) / this.kbHeight);
  }

  private handColor(n: NoteEvent) {
    return n.hand === 'L' ? COLORS.L : COLORS.R;
  }

  // ---------- händelser från appen ----------

  pressKey(midi: number, kind: 'correct' | 'wrong' | 'neutral', hand: 'L' | 'R' = 'R'): void {
    const color = kind === 'wrong' ? COLORS.bad : kind === 'correct' ? COLORS[hand].light : 'hsl(220, 30%, 75%)';
    this.keyStates.set(midi, { glow: 1, color, held: true, wrong: kind === 'wrong' });
    const a = this.keyAnchor(midi);
    if (!a) return;
    if (kind === 'correct') this.particles.burst(a.x, a.y, COLORS[hand].base, 1);
    else if (kind === 'wrong') {
      this.particles.fizzle(a.x, a.y, COLORS.bad);
      this.shake = 1;
    }
  }

  releaseKey(midi: number): void {
    const s = this.keyStates.get(midi);
    if (s) s.held = false;
  }

  /** Mikrofonen har inga "släpp" – blinka tangenten kort. */
  flashKey(midi: number, kind: 'correct' | 'wrong', hand: 'L' | 'R' = 'R'): void {
    this.pressKey(midi, kind, hand);
    const s = this.keyStates.get(midi);
    if (s) s.held = false;
  }

  stepCompleted(): void {
    this.stepFlash = 1;
  }

  // ---------- uppdatering & rendering ----------

  update(dt: number): void {
    this.time += dt;
    if (this.session) {
      const target = this.session.targetBeat;
      // Kritiskt dämpad följning: snabbt men mjukt, utan översväng.
      const k = 1 - Math.exp(-dt * 10);
      this.scrollBeat += (target - this.scrollBeat) * k;
      if (Math.abs(target - this.scrollBeat) < 1e-4) this.scrollBeat = target;
    }
    for (const [m, s] of this.keyStates) {
      if (!s.held) {
        s.glow -= dt * 2.2;
        if (s.glow <= 0) this.keyStates.delete(m);
      } else if (!s.wrong) {
        // Glöd stiger från nedtryckta rätta tangenter.
        const a = this.keyAnchor(m);
        if (a && Math.random() < dt * 14) this.particles.ember(a.x, a.y, s.color, this.layout.key(m)!.w * 0.6);
      }
    }
    this.stepFlash = Math.max(0, this.stepFlash - dt * 3);
    this.shake = Math.max(0, this.shake - dt * 5);
    this.particles.update(dt);
  }

  render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const shakeX = this.shake > 0 ? Math.sin(this.time * 90) * this.shake * 3 : 0;
    ctx.save();
    ctx.translate(shakeX, 0);
    this.drawBackground();
    this.drawLanes();
    this.drawGrid();
    this.drawNotes();
    this.drawHitLine();
    this.drawKeyboard();
    ctx.restore();
    this.particles.draw(ctx);
  }

  private get pxPerBeat(): number {
    return (this.kbTop - 24) / this.settings.beatsVisible;
  }

  private beatToY(beat: number): number {
    return this.kbTop - (beat - this.scrollBeat) * this.pxPerBeat;
  }

  private drawBackground(): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.bgGradient ?? '#070a14';
    ctx.fillRect(-10, 0, this.width + 20, this.kbTop);
  }

  private drawLanes(): void {
    const ctx = this.ctx;
    const top = 0;
    const h = this.kbTop;
    // Mörkare fält ovanför svarta tangenter = ögat hittar rätt "fil".
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    for (const k of this.layout.keys()) if (k.black) ctx.fillRect(k.x, top, k.w, h);
    // Skiljelinjer: tydlig vid varje C, svag vid F (oktavens två grupper).
    for (const k of this.layout.keys()) {
      if (k.black) continue;
      const pc = k.midi % 12;
      if (pc === 0 || pc === 5) {
        ctx.fillStyle = pc === 0 ? 'rgba(140, 170, 255, 0.16)' : 'rgba(140, 170, 255, 0.07)';
        ctx.fillRect(Math.round(k.x), top, 1, h);
      }
    }
    // Ytterkanter
    ctx.fillStyle = 'rgba(140, 170, 255, 0.12)';
    ctx.fillRect(this.kbLeft - 1, top, 1, h);
    ctx.fillRect(this.kbLeft + this.kbWidth, top, 1, h);
  }

  private drawGrid(): void {
    if (!this.song) return;
    const ctx = this.ctx;
    const bpb = this.song.beatsPerBar;
    const first = Math.floor(this.scrollBeat - 1);
    const last = Math.ceil(this.scrollBeat + this.settings.beatsVisible + 1);
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let b = first; b <= last; b++) {
      if (b < 0) continue;
      const y = Math.round(this.beatToY(b)) + 0.5;
      if (y > this.kbTop || y < 0) continue;
      const isBar = b % bpb === 0;
      ctx.fillStyle = isBar ? 'rgba(160, 185, 255, 0.16)' : 'rgba(160, 185, 255, 0.05)';
      ctx.fillRect(this.kbLeft, y, this.kbWidth, 1);
      if (isBar && this.kbLeft > 28) {
        ctx.fillStyle = 'rgba(160, 185, 255, 0.4)';
        ctx.textAlign = 'right';
        ctx.fillText(String(b / bpb + 1), this.kbLeft - 8, y);
      }
    }
  }

  private drawNotes(): void {
    const s = this.session;
    if (!s || !this.song) return;
    const ctx = this.ctx;
    const minBeat = this.scrollBeat - 16;
    const maxBeat = this.scrollBeat + this.settings.beatsVisible + 0.5;
    const current = s.current;
    const currentTime = current?.time ?? Infinity;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);

    ctx.save();
    ctx.beginPath();
    ctx.rect(-10, 0, this.width + 20, this.kbTop);
    ctx.clip();

    // Spöktoner för den hand som inte övas.
    if (this.settings.showOtherHand && s.hands !== 'both') {
      for (const n of this.song.notes) {
        if ((n.hand ?? 'R') === s.hands) continue;
        if (n.start + n.dur < minBeat || n.start > maxBeat) continue;
        const k = this.layout.key(n.midi);
        if (!k) continue;
        const y0 = this.beatToY(n.start);
        const y1 = this.beatToY(n.start + n.dur);
        ctx.fillStyle = 'rgba(180, 190, 220, 0.10)';
        roundRect(ctx, k.x + 3, y1 + 1, k.w - 6, y0 - y1 - 3, 5);
        ctx.fill();
      }
    }

    for (const n of s.notes) {
      if (n.start + n.dur < minBeat || n.start > maxBeat) continue;
      const k = this.layout.key(n.midi);
      if (!k) continue;
      const isCurrent = current !== null && n.start === currentTime && current.notes.includes(n);
      const isPast = n.start < currentTime && !isCurrent;
      const done = isCurrent && s.satisfied.has(n.midi);
      const c = this.handColor(n);

      const inset = k.black ? 1 : Math.max(2, k.w * 0.08);
      const x = k.x + inset;
      const w = k.w - inset * 2;
      const yBottom = this.beatToY(n.start) - 1.5; // liten lucka: upprepade toner syns som separata staplar
      const yTop = this.beatToY(n.start + n.dur) + 1.5;
      const h = Math.max(6, yBottom - yTop);
      const r = Math.min(7, w / 3, h / 2);

      // Toner långt fram tonas ut mot toppen.
      const distFrac = (n.start - this.scrollBeat) / this.settings.beatsVisible;
      let alpha = distFrac > 0.75 ? Math.max(0.25, 1 - (distFrac - 0.75) * 3) : 1;
      if (isPast) alpha *= 0.4;

      ctx.globalAlpha = alpha;
      if (isCurrent) {
        ctx.shadowColor = done ? COLORS.good : c.base;
        ctx.shadowBlur = 18 + pulse * 14;
      }
      const grad = ctx.createLinearGradient(0, yTop, 0, yTop + h);
      if (done) {
        grad.addColorStop(0, 'hsl(140, 85%, 75%)');
        grad.addColorStop(1, COLORS.good);
      } else if (isPast) {
        grad.addColorStop(0, withAlpha(c.base, 0.6));
        grad.addColorStop(1, withAlpha(c.dark, 0.6));
      } else {
        grad.addColorStop(0, k.black ? c.base : c.light);
        grad.addColorStop(0.35, c.base);
        grad.addColorStop(1, k.black ? c.dark : c.base);
      }
      ctx.fillStyle = grad;
      roundRect(ctx, x, yTop, w, h, r);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Kant + inre högdager ger "glas"-känsla.
      ctx.strokeStyle = isCurrent ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.28)';
      ctx.lineWidth = isCurrent ? 2 : 1;
      roundRect(ctx, x + 0.5, yTop + 0.5, w - 1, h - 1, r);
      ctx.stroke();
      if (h > 10) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        roundRect(ctx, x + 2, yTop + 2, Math.max(1, w * 0.28), h - 4, Math.min(r, 3));
        ctx.fill();
      }

      // Tonnamn längst ner i stapeln.
      if (w >= 14 && h >= 16) {
        const fs = Math.max(9, Math.min(15, w * 0.42));
        ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = done || !isPast ? 'rgba(5, 12, 30, 0.85)' : 'rgba(255,255,255,0.5)';
        ctx.fillText(pitchName(n.midi, this.settings.naming), x + w / 2, yBottom - 3);
      }
      // Sångtext bredvid.
      if (n.lyric && !isPast) {
        ctx.font = `${isCurrent ? 700 : 500} 13px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = isCurrent ? 'rgba(255,255,255,0.95)' : 'rgba(220,228,255,0.55)';
        ctx.fillText(n.lyric, x + w + 6, yBottom - 2);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawHitLine(): void {
    const ctx = this.ctx;
    const y = this.kbTop;
    const s = this.session;
    // Ljuskäglor ("beams") från tangenterna i aktuellt steg upp mot staplarna.
    if (s?.current) {
      const pulse = 0.6 + 0.4 * Math.sin(this.time * 5);
      for (const n of s.current.notes) {
        const k = this.layout.key(n.midi);
        if (!k) continue;
        const done = s.satisfied.has(n.midi);
        const col = done ? COLORS.good : this.handColor(n).base;
        const g = ctx.createLinearGradient(0, y - 160, 0, y);
        g.addColorStop(0, withAlpha(col, 0));
        g.addColorStop(1, withAlpha(col, 0.28 * pulse));
        ctx.fillStyle = g;
        ctx.fillRect(k.x, y - 160, k.w, 160);
      }
    }
    // Nedtryckta tangenter: kort ljuspelare.
    for (const [m, st] of this.keyStates) {
      const k = this.layout.key(m);
      if (!k) continue;
      const g = ctx.createLinearGradient(0, y - 220, 0, y);
      g.addColorStop(0, withAlpha(st.color, 0));
      g.addColorStop(1, withAlpha(st.color, 0.45 * st.glow));
      ctx.fillStyle = g;
      ctx.fillRect(k.x, y - 220, k.w, 220);
    }
    // Själva träfflinjen.
    const glow = ctx.createLinearGradient(0, y - 18, 0, y);
    const flash = this.stepFlash;
    glow.addColorStop(0, 'rgba(120, 220, 255, 0)');
    glow.addColorStop(1, `rgba(120, 220, 255, ${0.25 + flash * 0.45})`);
    ctx.fillStyle = glow;
    ctx.fillRect(this.kbLeft, y - 18, this.kbWidth, 18);
    ctx.fillStyle = `rgba(190, 240, 255, ${0.75 + flash * 0.25})`;
    ctx.fillRect(this.kbLeft, y - 2, this.kbWidth, 2);
  }

  private drawKeyboard(): void {
    const ctx = this.ctx;
    const top = this.kbTop;
    const H = this.kbHeight;
    const s = this.session;
    const expected = new Map<number, NoteEvent>();
    if (s?.current) for (const n of s.current.notes) expected.set(n.midi, n);
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 6);

    ctx.fillStyle = '#05060a';
    ctx.fillRect(-10, top, this.width + 20, H);

    // --- Vita tangenter ---
    for (const k of this.layout.keys()) {
      if (k.black) continue;
      const st = this.keyStates.get(k.midi);
      const exp = expected.get(k.midi);
      const down = st?.held ? 2 : 0;
      const x = k.x + 0.5;
      const w = k.w - 1;
      const g = ctx.createLinearGradient(0, top, 0, top + H);
      g.addColorStop(0, '#d9dbe3');
      g.addColorStop(0.08, '#f7f8fb');
      g.addColorStop(1, down ? '#dfe2ea' : '#eceef3');
      ctx.fillStyle = g;
      roundRectBottom(ctx, x, top + down, w, H - 2 - down, Math.min(6, w * 0.15));
      ctx.fill();

      if (exp && !s!.satisfied.has(k.midi)) {
        const c = this.handColor(exp);
        const eg = ctx.createLinearGradient(0, top, 0, top + H);
        eg.addColorStop(0, withAlpha(c.base, 0.15));
        eg.addColorStop(1, withAlpha(c.base, 0.35 + 0.35 * pulse));
        ctx.fillStyle = eg;
        roundRectBottom(ctx, x, top + down, w, H - 2 - down, Math.min(6, w * 0.15));
        ctx.fill();
      }
      if (st) {
        ctx.fillStyle = withAlpha(st.color, 0.75 * st.glow);
        roundRectBottom(ctx, x, top + down, w, H - 2 - down, Math.min(6, w * 0.15));
        ctx.fill();
      }
      // Skugga mellan tangenter
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(k.x + k.w - 1, top, 1, H - 4);

      // Etiketter
      const pc = k.midi % 12;
      const showLabel = this.settings.allKeyLabels || pc === 0 || !!exp;
      if (showLabel && k.w >= 12) {
        const fs = Math.max(9, Math.min(14, k.w * 0.34));
        ctx.font = `${exp ? 800 : 600} ${fs}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = exp ? this.handColor(exp).dark : pc === 0 ? 'rgba(40,50,80,0.75)' : 'rgba(40,50,80,0.45)';
        const label = pc === 0 && !exp ? noteName(k.midi, this.settings.naming) : pitchName(k.midi, this.settings.naming);
        ctx.fillText(label, k.x + k.w / 2, top + H - 8 + down);
      }
      // Markör (prick) på förväntad tangent
      if (exp && !s!.satisfied.has(k.midi)) {
        const cx = k.x + k.w / 2;
        const cy = top + H * 0.72;
        ctx.fillStyle = this.handColor(exp).base;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(7, k.w * 0.18) * (0.85 + 0.15 * pulse), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- Svarta tangenter ---
    const bh = H * BLACK_HEIGHT_RATIO;
    for (const k of this.layout.keys()) {
      if (!k.black) continue;
      const st = this.keyStates.get(k.midi);
      const exp = expected.get(k.midi);
      const down = st?.held ? 2 : 0;
      // Skugga på de vita tangenterna
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      roundRectBottom(ctx, k.x + 2, top, k.w, bh + 3, 3);
      ctx.fill();
      const g = ctx.createLinearGradient(0, top, 0, top + bh);
      g.addColorStop(0, '#2a2c35');
      g.addColorStop(0.85, '#14151b');
      g.addColorStop(1, '#0b0c10');
      ctx.fillStyle = g;
      roundRectBottom(ctx, k.x, top + down, k.w, bh - down, 3);
      ctx.fill();
      if (exp && !s!.satisfied.has(k.midi)) {
        ctx.fillStyle = withAlpha(this.handColor(exp).base, 0.45 + 0.4 * pulse);
        roundRectBottom(ctx, k.x, top + down, k.w, bh - down, 3);
        ctx.fill();
      }
      if (st) {
        ctx.fillStyle = withAlpha(st.color, 0.8 * st.glow);
        roundRectBottom(ctx, k.x, top + down, k.w, bh - down, 3);
        ctx.fill();
      }
      // Högdager (fasad)
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(k.x + k.w * 0.18, top + down + 2, k.w * 0.64, bh * 0.82 - down);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(k.x + k.w * 0.18, top + bh * 0.82, k.w * 0.64, 2);
      if (exp && k.w >= 12) {
        const fs = Math.max(8, Math.min(12, k.w * 0.4));
        ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#fff';
        ctx.fillText(pitchName(k.midi, this.settings.naming), k.x + k.w / 2, top + bh - 6);
      }
    }

    // Mikrofonens tonhöjd: liten markör ovanför klaviaturen.
    if (this.micPitch !== null) {
      const m = Math.round(this.micPitch);
      const k = this.layout.key(m);
      if (k) {
        const cents = (this.micPitch - m) * 100;
        const x = k.x + k.w / 2 + (cents / 100) * this.layout.whiteWidth * 0.5;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.moveTo(x, top - 4);
        ctx.lineTo(x - 6, top - 14);
        ctx.lineTo(x + 6, top - 14);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Filtlist (som på ett riktigt piano) överst på klaviaturen.
    const felt = ctx.createLinearGradient(0, top, 0, top + 5);
    felt.addColorStop(0, '#5a0f1c');
    felt.addColorStop(1, 'rgba(90, 15, 28, 0)');
    ctx.fillStyle = felt;
    ctx.fillRect(this.kbLeft, top, this.kbWidth, 5);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, r));
}

function roundRectBottom(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, [0, 0, Math.max(0, r), Math.max(0, r)]);
}


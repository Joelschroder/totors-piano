// Lätt partikelsystem för Canvas 2D.
//
// Trick för att det ska se "glödande" ut utan WebGL:
//  - Varje partikel ritas som en förrenderad sprite (radiell gradient) i stället
//    för med shadowBlur (som är dyrt).
//  - Ritas med globalCompositeOperation = 'lighter' (additiv blandning), så
//    överlappande gnistor blir ljusare – samma effekt som i shader-baserade system.
//  - Sprites cachas per färg.

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: 'spark' | 'ring' | 'glow';
  drag: number;
  gravity: number;
}

const spriteCache = new Map<string, HTMLCanvasElement>();

function sprite(color: string): HTMLCanvasElement {
  let c = spriteCache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, color);
  grad.addColorStop(0.45, withAlpha(color, 0.35));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  spriteCache.set(color, c);
  return c;
}

/** Tar "hsl(...)"/"rgb(...)"/"#rrggbb" och returnerar samma färg med alfa. */
export function withAlpha(color: string, a: number): string {
  if (color.startsWith('hsl(')) return color.replace('hsl(', 'hsla(').replace(')', `, ${a})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return color;
}

export class ParticleSystem {
  particles: Particle[] = [];
  max = 1500;

  burst(x: number, y: number, color: string, intensity = 1): void {
    const n = Math.round(26 * intensity);
    for (let i = 0; i < n; i++) {
      // Mest uppåt, i en solfjäder.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 120 + Math.random() * 380 * intensity;
      this.add({
        x: x + (Math.random() - 0.5) * 10,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.6,
        size: 3 + Math.random() * 6,
        color,
        kind: 'spark',
        drag: 2.2,
        gravity: 520,
      });
    }
    this.add({ x, y, vx: 0, vy: 0, life: 0, maxLife: 0.45, size: 10, color, kind: 'ring', drag: 0, gravity: 0 });
    this.add({ x, y, vx: 0, vy: 0, life: 0, maxLife: 0.35, size: 90 * intensity, color, kind: 'glow', drag: 0, gravity: 0 });
  }

  /** Små röda gnistor nedåt för fel ton. */
  fizzle(x: number, y: number, color: string): void {
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
      const speed = 60 + Math.random() * 140;
      this.add({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: 0.3 + Math.random() * 0.3,
        size: 2 + Math.random() * 4,
        color,
        kind: 'spark',
        drag: 4,
        gravity: 300,
      });
    }
  }

  /** Långsamt stigande glöd ovanför en nedtryckt tangent. */
  ember(x: number, y: number, color: string, spread: number): void {
    this.add({
      x: x + (Math.random() - 0.5) * spread,
      y,
      vx: (Math.random() - 0.5) * 20,
      vy: -40 - Math.random() * 90,
      life: 0,
      maxLife: 0.6 + Math.random() * 0.8,
      size: 2 + Math.random() * 3,
      color,
      kind: 'spark',
      drag: 0.5,
      gravity: -20,
    });
  }

  private add(p: Particle): void {
    if (this.particles.length >= this.max) this.particles.shift();
    this.particles.push(p);
  }

  update(dt: number): void {
    const out: Particle[] = [];
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy = p.vy * d + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      out.push(p);
    }
    this.particles = out;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.particles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const t = p.life / p.maxLife;
      if (p.kind === 'spark') {
        const s = p.size * (1 - t * 0.6);
        ctx.globalAlpha = (1 - t) * (1 - t);
        ctx.drawImage(sprite(p.color), p.x - s * 2, p.y - s * 2, s * 4, s * 4);
      } else if (p.kind === 'ring') {
        const r = p.size + t * 70;
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 3 * (1 - t) + 0.5;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.globalAlpha = (1 - t) * 0.55;
        const s = p.size * (0.8 + t * 0.6);
        ctx.drawImage(sprite(p.color), p.x - s, p.y - s, s * 2, s * 2);
      }
    }
    ctx.restore();
  }
}

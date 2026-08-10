const PALETTE = [
  "#ffffff",
  "#3566ff",
  "#ffcf00",
  "#192aff",
  "#d62036",
  "#282142",
  "#ec4978",
  "#ff9900",
  "#14101f",
  "#00dd33",
  "#00ef82",
] as const;

const COLS = 11;
const POWER = 1.65;

const TILES = 15;

const CYCLE = 0.2;

const STAGGER = 0.006;

const STRETCH = 8.5;

const EARLY = 1.0;

const SPRING_K = 1.6;

const BLEED = 0.012;

const COL_PHASE = -0.4;

const SPRING_NORM = 1 - Math.exp(-SPRING_K);

function springStep(p: number): number {
  const half = (t: number) => (1 - Math.exp(-SPRING_K * t)) / SPRING_NORM;
  return p < 0.5 ? 0.5 * half(2 * p) : 1 - 0.5 * half(2 * (1 - p));
}

function pickDifferent(from: number, avoid: number[]): number {
  for (let i = 1; i <= PALETTE.length; i++) {
    const c = (from + i) % PALETTE.length;
    if (!avoid.includes(c)) return c;
  }
  return from;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Datamosh {
  readonly ok: boolean = false;

  private host: HTMLElement;
  private canvas: HTMLCanvasElement;

  private ctx!: CanvasRenderingContext2D;
  private ro: ResizeObserver | null = null;

  private w = 0;
  private h = 0;
  private dpr = 1;

  private raf = 0;
  private running = false;
  private lastT = 0;
  private elapsed = 0;
  private seed: number;

  private edges: number[] = [];

  private strip: number[] = [];

  constructor(host: HTMLElement, seed = 1) {
    this.host = host;
    this.seed = seed;

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);
    this.canvas = canvas;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    this.ctx = ctx;

    ctx.imageSmoothingEnabled = false;
    this.ok = true;

    this.buildColours();
    this.measure();

    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        this.measure();
        if (!this.running) this.draw();
      });
      this.ro.observe(host);
    }
  }

  private buildColours() {
    const rand = mulberry32(this.seed);

    const WHITE = 0;
    const DARKS = [8, 5];
    const HUES = [1, 2, 3, 4, 6, 7, 9, 10];

    const LEN = 61;
    const strip: number[] = [];
    let lastHue = -1;

    for (let n = 0; n < LEN; n++) {
      const r = rand();
      let next: number;
      if (r < 0.26) {

        next = WHITE;
      } else if (r < 0.42) {
        next = DARKS[Math.floor(rand() * DARKS.length)];
      } else {

        let h = HUES[Math.floor(rand() * HUES.length)];
        if (h === lastHue) h = HUES[(HUES.indexOf(h) + 1) % HUES.length];
        lastHue = h;
        next = h;
      }

      if (n > 0 && next === strip[n - 1]) {
        next = pickDifferent(next, [strip[n - 1]]);
      }
      strip.push(next);
    }

    if (strip[LEN - 1] === strip[0]) {
      strip[LEN - 1] = pickDifferent(strip[LEN - 1], [strip[LEN - 2], strip[0]]);
    }

    this.strip = strip;
  }

  private measure() {
    const r = this.host.getBoundingClientRect();

    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(r.width * this.dpr));
    this.h = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx.imageSmoothingEnabled = false;

    this.edges = [];
    for (let i = 0; i <= COLS; i++) {
      this.edges.push(Math.round(this.w * Math.pow(i / COLS, POWER)));
    }
  }

  private tileEdge(k: number): number {
    const u = k / TILES;

    if (u < 0) return u * 0.05;
    if (u > 1) return 1 + (u - 1) * 0.05;
    const v = Math.pow(u, EARLY);
    const a = Math.pow(v, STRETCH);
    return a / (a + Math.pow(1 - v, STRETCH));
  }

  private draw() {
    const { ctx, h, edges } = this;

    for (let i = 0; i < COLS; i++) {
      const x0 = edges[i];
      const cw = edges[i + 1] - x0;
      if (cw <= 0) continue;

      const delay = (COLS - 1 - i) * STAGGER;
      const t = this.elapsed - delay;
      const raw = t <= 0 ? 0 : t / CYCLE;

      const linear = raw + i * COL_PHASE;
      const step = Math.floor(linear);
      const frac = linear - step;
      const flow = step + springStep(frac);

      const bleed = Math.round(BLEED * h);

      const base = -Math.floor(flow);
      for (let n = TILES + 2; n >= -2; n--) {
        const id = base + n;

        const k = id + flow;
        const top = Math.round(this.tileEdge(k) * h);

        const bot = Math.round(this.tileEdge(k + 1) * h) + bleed;
        if (bot <= top || bot <= 0 || top >= h) continue;
        const y = Math.max(0, top);
        const th = Math.min(h, bot) - y;
        if (th <= 0) continue;

        const s = id - i;
        const len = this.strip.length;
        ctx.fillStyle = PALETTE[this.strip[((s % len) + len) % len]];
        ctx.fillRect(x0, y, cw, th);
      }
    }
  }

  private tick = (now: number) => {
    if (!this.running) return;

    const dt = this.lastT ? Math.min(0.05, (now - this.lastT) / 1000) : 0;
    this.lastT = now;
    this.elapsed += dt;
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  start() {
    if (this.running || !this.ok) return;
    this.running = true;
    this.lastT = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  renderStill() {
    if (!this.ok) return;
    this.elapsed = CYCLE * 0.45 + COLS * STAGGER;
    this.draw();
  }

  destroy() {
    this.stop();
    this.ro?.disconnect();
    this.ro = null;
    this.canvas.remove();
  }
}

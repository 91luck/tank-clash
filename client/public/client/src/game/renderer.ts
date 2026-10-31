import {
  GAME_CONFIG,
  TILE_SOLID,
  type MapDef,
  type Snapshot,
  type TankClass,
  type TankSnapshot,
  type TeamId,
} from '@tankclash/shared';
import { TEAM_PALETTE, tankSprite } from './tank-sprites';

export { drawTankIcon } from './tank-sprites';

export interface PlayerMeta {
  id: string;
  name: string;
  team: TeamId;
  cls: TankClass;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  add: boolean;
  drag: number;
  grow: number;
}

const POWERUP_STYLE: Record<string, { color: string; glyph: string }> = {
  speed: { color: '#facc15', glyph: 'S' },
  shield: { color: '#22d3ee', glyph: 'O' },
  rapid: { color: '#f472b6', glyph: 'R' },
  health: { color: '#4ade80', glyph: '+' },
  triple: { color: '#fb923c', glyph: '3' },
  bounce: { color: '#a3e635', glyph: 'B' },
  overcharge: { color: '#ef4444', glyph: '!' },
};

const FONT = "'Chakra Petch', system-ui, sans-serif";
/** Static art is rendered at this density so it stays crisp when the camera zooms in. */
const ART = 2;
/** Visual size of a tank sprite relative to its design size (the hit circle stays as configured). */
const TANK_SCALE = 0.46;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Battlefield renderer: pre-rendered floor and steel (2x density), destructible crates, pixel-art tanks with animated
 * treads, tread-mark and scorch decals, additive-light bullets and explosions, and - when the screen is too small
 * to show the whole arena at a readable size - a camera that follows your tank, with a minimap.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly staticLayer: HTMLCanvasElement;
  private readonly decals: HTMLCanvasElement;
  private readonly decalCtx: CanvasRenderingContext2D;
  private wallHp: Int8Array;
  private particles: Particle[] = [];
  private shakeMag = 0;
  private flashAlpha = 0;
  private flashColor = '#ff0000';
  private scale = 1;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private follow = false;
  private camX = 0;
  private camY = 0;
  private camReady = false;
  private lastDraw = 0;
  private lastFade = 0;
  private reduce = false;
  private tread = new Map<string, { x: number; y: number; d: number }>();
  private hitTick = new Map<string, number>();
  private lastHp = new Map<string, number>();
  private floats: { x: number; y: number; text: string; color: string; life: number }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MapDef,
    /** 'contain' (gameplay: whole arena, or follow-cam on small screens); 'cover' fills the screen (menu). */
    private readonly opts: { fit?: 'contain' | 'cover'; maxDpr?: number } = {},
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
    this.ctx = ctx;
    this.wallHp = new Int8Array(map.walls.length).fill(GAME_CONFIG.walls.destructibleHp);
    this.staticLayer = this.buildStaticLayer();
    this.decals = document.createElement('canvas');
    this.decals.width = map.width;
    this.decals.height = map.height;
    const dg = this.decals.getContext('2d');
    if (!dg) throw new Error('Canvas 2D is not supported in this browser.');
    this.decalCtx = dg;
    this.resize();
  }

  // ------------------------------------------------------------ state from the simulation

  resetWalls(destroyed: readonly number[]): void {
    this.wallHp.fill(GAME_CONFIG.walls.destructibleHp);
    for (const id of destroyed) this.wallHp[id] = 0;
    this.particles = [];
    this.decalCtx.clearRect(0, 0, this.decals.width, this.decals.height);
    this.camReady = false;
  }

  setWallHp(id: number, hp: number): void {
    if (id >= 0 && id < this.wallHp.length) this.wallHp[id] = hp;
  }

  // ------------------------------------------------------------ effects

  private add(p: Partial<Particle> & { x: number; y: number }): void {
    if (this.particles.length > 600) this.particles.shift();
    const life = p.life ?? 0.3;
    this.particles.push({
      vx: 0,
      vy: 0,
      color: '#fff',
      size: 3,
      add: false,
      drag: 0.02,
      grow: 0,
      ...p,
      life,
      max: life,
    });
  }

  muzzle(x: number, y: number, a: number, reduce: boolean): void {
    this.add({
      x: x + Math.cos(a) * 3,
      y: y + Math.sin(a) * 3,
      life: 0.07,
      size: 16,
      color: '#ffe08a',
      add: true,
    });
    const n = reduce ? 2 : 6;
    for (let i = 0; i < n; i++) {
      const sp = 80 + Math.random() * 160;
      const ang = a + (Math.random() - 0.5) * 0.8;
      this.add({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.12,
        color: '#ffd166',
        size: 2.5,
        add: true,
      });
    }
    if (!reduce)
      this.add({
        x,
        y,
        vx: Math.cos(a) * 30,
        vy: Math.sin(a) * 30,
        life: 0.5,
        size: 7,
        color: 'rgba(200,200,200,0.35)',
        grow: 14,
      });
  }

  impact(x: number, y: number, color: string, reduce: boolean): void {
    const n = reduce ? 3 : 9;
    this.add({ x, y, life: 0.08, size: 12, color, add: true });
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 140;
      this.add({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.2 + Math.random() * 0.2,
        color,
        size: 2.5,
        add: true,
      });
    }
  }

  explosion(x: number, y: number, reduce: boolean): void {
    const k = reduce ? 0.35 : 1;
    this.add({ x, y, life: 0.12, size: 70, color: '#fff3d1', add: true, grow: -150 });
    const fire = ['#fff3b0', '#ffd166', '#ff9f1c', '#f3722c', '#d62828'];
    for (let i = 0; i < 34 * k; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 170;
      this.add({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.3 + Math.random() * 0.4,
        color: fire[i % fire.length] as string,
        size: 7 + Math.random() * 9,
        add: true,
        grow: -14,
        drag: 0.05,
      });
    }
    for (let i = 0; i < 12 * k; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 10 + Math.random() * 40;
      this.add({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.9 + Math.random() * 0.8,
        color: 'rgba(45,42,48,0.5)',
        size: 12,
        grow: 16,
      });
    }
    for (let i = 0; i < 14 * k; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 200;
      this.add({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.4 + Math.random() * 0.3,
        color: '#2b2622',
        size: 3,
        drag: 0.1,
      });
    }
    // scorch mark stays on the floor for a while
    const g = this.decalCtx;
    const grad = g.createRadialGradient(x, y, 2, x, y, 26);
    grad.addColorStop(0, 'rgba(10,8,8,0.55)');
    grad.addColorStop(1, 'rgba(10,8,8,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, 26, 0, Math.PI * 2);
    g.fill();
    if (!reduce) this.shakeMag = Math.min(12, this.shakeMag + 7);
  }

  /** Floating combat text (damage numbers). */
  floatText(x: number, y: number, text: string, color: string): void {
    if (this.floats.length > 40) this.floats.shift();
    this.floats.push({ x: x + (Math.random() - 0.5) * 8, y, text, color, life: 0.9 });
  }

  flash(color: string, strength = 0.25): void {
    this.flashColor = color;
    this.flashAlpha = Math.max(this.flashAlpha, strength);
  }

  // ------------------------------------------------------------ layout

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(this.opts.maxDpr ?? 2, window.devicePixelRatio || 1);
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    const w = Math.max(1, Math.round(this.cssW * this.dpr));
    const h = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const m = this.map;
    if (this.opts.fit === 'cover') {
      this.scale = Math.max(this.cssW / m.width, this.cssH / m.height);
      this.follow = false;
    } else {
      // Show the whole arena when that keeps tanks readable; otherwise zoom in and follow your tank.
      const contain = Math.min(this.cssW / m.width, this.cssH / m.height);
      const readable = this.cssH < 520 ? 1.2 : 0.95;
      this.follow = contain < readable;
      this.scale = this.follow ? readable : contain;
    }
    this.ctx.imageSmoothingEnabled = true;
  }

  // ------------------------------------------------------------ drawing

  draw(
    frame: Snapshot,
    players: Map<string, PlayerMeta>,
    meId: string | null,
    nowMs: number,
    reduceMotion: boolean,
  ): void {
    const ctx = this.ctx;
    this.reduce = reduceMotion;
    const dt = Math.min(0.05, this.lastDraw ? (nowMs - this.lastDraw) / 1000 : 0.016);
    this.lastDraw = nowMs;
    const m = this.map;
    const viewW = this.cssW / this.scale;
    const viewH = this.cssH / this.scale;

    // camera
    let tx = (m.width - viewW) / 2;
    let ty = (m.height - viewH) / 2;
    if (this.follow) {
      const me = meId ? frame.tanks.find((t) => t.id === meId && t.al) : undefined;
      if (me) {
        tx = me.x + Math.cos(me.a) * 40 - viewW / 2;
        ty = me.y + Math.sin(me.a) * 40 - viewH / 2;
      }
      // A little room past the arena edge, so a tank at a corner spawn is not hidden under the thumb controls.
      const mx = viewW * 0.22;
      const my = viewH * 0.22;
      tx = Math.max(-mx, Math.min(m.width - viewW + mx, tx));
      ty = Math.max(-my, Math.min(m.height - viewH + my, ty));
    }
    if (!this.camReady || !this.follow) {
      this.camX = tx;
      this.camY = ty;
      this.camReady = true;
    } else {
      this.camX += (tx - this.camX) * Math.min(1, dt * 5);
      this.camY += (ty - this.camY) * Math.min(1, dt * 5);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    let sx = 0;
    let sy = 0;
    if (!reduceMotion && this.shakeMag > 0.1) {
      sx = (Math.random() - 0.5) * this.shakeMag;
      sy = (Math.random() - 0.5) * this.shakeMag;
    }
    this.shakeMag *= Math.pow(0.002, dt);
    const s = this.scale * this.dpr;
    ctx.setTransform(s, 0, 0, s, (-this.camX + sx) * s, (-this.camY + sy) * s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.staticLayer, 0, 0, m.width, m.height);
    this.fadeDecals(nowMs);
    ctx.drawImage(this.decals, 0, 0);

    this.drawDestructibles(ctx);
    for (const p of frame.pu) this.drawPowerup(ctx, p, nowMs);
    for (const t of frame.tanks) if (t.al) this.drawTank(ctx, t, players.get(t.id), t.id === meId, nowMs);
    this.drawBullets(ctx, frame);
    this.drawParticles(ctx, dt);
    for (const t of frame.tanks) if (t.al) this.drawTag(ctx, t, players.get(t.id), t.id === meId);
    this.drawFloats(ctx, dt);

    // screen space
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawVignette();
    if (this.follow) this.drawMinimap(frame, players, meId);
    if (this.flashAlpha > 0.01 && !reduceMotion) {
      ctx.globalAlpha = this.flashAlpha;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }
    this.flashAlpha *= Math.pow(0.0008, dt);
  }

  // ------------------------------------------------------------ arena art

  private buildStaticLayer(): HTMLCanvasElement {
    const m = this.map;
    const c = document.createElement('canvas');
    c.width = m.width * ART;
    c.height = m.height * ART;
    const g = c.getContext('2d');
    if (!g) throw new Error('Canvas 2D is not supported in this browser.');
    g.scale(ART, ART);
    const ts = m.tileSize;
    const r = rng(7);
    // floor: industrial concrete plates with grime
    for (let row = 0; row < m.rows; row++)
      for (let col = 0; col < m.cols; col++) {
        const x = col * ts;
        const y = row * ts;
        const v = r();
        g.fillStyle = v < 0.33 ? '#2b302e' : v < 0.66 ? '#2e3431' : '#292e2b';
        g.fillRect(x, y, ts, ts);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        g.fillRect(x, y, ts, 1);
        g.fillRect(x, y, 1, ts);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x, y + ts - 1, ts, 1);
        g.fillRect(x + ts - 1, y, 1, ts);
        for (let k = 0; k < 6; k++) {
          g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.04)';
          g.fillRect(x + r() * (ts - 2), y + r() * (ts - 2), 1.5, 1.5);
        }
        if (r() < 0.05) {
          // oil stain
          const gr = g.createRadialGradient(x + ts / 2, y + ts / 2, 1, x + ts / 2, y + ts / 2, ts * 0.6);
          gr.addColorStop(0, 'rgba(0,0,0,0.3)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr;
          g.fillRect(x - 6, y - 6, ts + 12, ts + 12);
        }
      }
    // centre line: hazard stripes
    const midX = m.width / 2;
    for (let y = 0; y < m.height; y += 16) {
      g.fillStyle = 'rgba(244,196,48,0.18)';
      g.fillRect(midX - 2, y, 4, 8);
    }
    // spawn pads: team-coloured glow + icon
    for (const sp of m.spawns) {
      const P = TEAM_PALETTE[sp.team];
      const gr = g.createRadialGradient(sp.x, sp.y, 2, sp.x, sp.y, ts * 0.75);
      gr.addColorStop(0, P.base + '55');
      gr.addColorStop(1, P.base + '00');
      g.fillStyle = gr;
      g.fillRect(sp.x - ts, sp.y - ts, ts * 2, ts * 2);
      g.strokeStyle = P.base;
      g.globalAlpha = 0.7;
      g.lineWidth = 1.5;
      g.strokeRect(sp.x - ts / 2 + 3, sp.y - ts / 2 + 3, ts - 6, ts - 6);
      g.fillStyle = P.light;
      g.beginPath();
      if (sp.team === 1) {
        g.moveTo(sp.x + 6, sp.y);
        g.lineTo(sp.x - 5, sp.y - 6);
        g.lineTo(sp.x - 5, sp.y + 6);
        g.closePath();
        g.fill();
      } else g.fillRect(sp.x - 5, sp.y - 5, 10, 10);
      g.globalAlpha = 1;
    }
    // power-up pads
    for (const p of m.powerupPoints) {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.beginPath();
      g.arc(p.x, p.y, 14, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(148,163,184,0.45)';
      g.setLineDash([3, 3]);
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(p.x, p.y, 14, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    // steel walls: cast shadow first, then raised blocks
    const solid = (col: number, row: number): boolean =>
      col >= 0 && row >= 0 && col < m.cols && row < m.rows && m.tiles[row * m.cols + col] === TILE_SOLID;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let row = 0; row < m.rows; row++)
      for (let col = 0; col < m.cols; col++)
        if (solid(col, row)) g.fillRect(col * ts + 5, row * ts + 6, ts, ts);
    for (let row = 0; row < m.rows; row++)
      for (let col = 0; col < m.cols; col++) {
        if (!solid(col, row)) continue;
        const x = col * ts;
        const y = row * ts;
        const grad = g.createLinearGradient(x, y, x + ts, y + ts);
        grad.addColorStop(0, '#7b8794');
        grad.addColorStop(1, '#55606b');
        g.fillStyle = grad;
        g.fillRect(x, y, ts, ts);
        // bevels only on exposed edges, so long walls read as one solid mass
        g.fillStyle = '#a9b5c1';
        if (!solid(col, row - 1)) g.fillRect(x, y, ts, 3);
        if (!solid(col - 1, row)) g.fillRect(x, y, 3, ts);
        g.fillStyle = '#353d45';
        if (!solid(col, row + 1)) g.fillRect(x, y + ts - 4, ts, 4);
        if (!solid(col + 1, row)) g.fillRect(x + ts - 3, y, 3, ts);
        g.fillStyle = '#2b323a';
        for (const [ox, oy] of [
          [6, 6],
          [ts - 9, 6],
          [6, ts - 10],
          [ts - 9, ts - 10],
        ] as const)
          g.fillRect(x + ox, y + oy, 3, 3);
        g.fillStyle = 'rgba(255,255,255,0.25)';
        for (const [ox, oy] of [
          [6, 6],
          [ts - 9, 6],
        ] as const)
          g.fillRect(x + ox, y + oy, 1, 1);
        if ((col * 7 + row * 3) % 9 === 0) {
          for (let k = 0; k < 4; k++) {
            g.fillStyle = k % 2 ? '#1d1d1d' : '#d9a92a';
            g.fillRect(x + 8 + k * 4, y + ts / 2 - 2, 4, 4);
          }
        }
      }
    // outer frame
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, m.width - 2, m.height - 2);
    return c;
  }

  private fadeDecals(nowMs: number): void {
    if (nowMs - this.lastFade < 1500) return;
    this.lastFade = nowMs;
    const g = this.decalCtx;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0,0,0,0.06)';
    g.fillRect(0, 0, this.decals.width, this.decals.height);
    g.restore();
  }

  private drawDestructibles(ctx: CanvasRenderingContext2D): void {
    const ts = this.map.tileSize;
    for (const w of this.map.walls) {
      const hp = this.wallHp[w.id] ?? 0;
      if (hp <= 0) continue;
      const x = w.col * ts;
      const y = w.row * ts;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(x + 4, y + 5, ts, ts);
      // armoured crate: wooden core, steel bands
      ctx.fillStyle = '#9a5b25';
      ctx.fillRect(x + 1, y + 1, ts - 2, ts - 2);
      ctx.fillStyle = '#b8742f';
      ctx.fillRect(x + 1, y + 1, ts - 2, 3);
      ctx.fillRect(x + 1, y + 1, 3, ts - 2);
      ctx.fillStyle = '#6b3b14';
      ctx.fillRect(x + 1, y + ts - 4, ts - 2, 3);
      ctx.fillRect(x + ts - 4, y + 1, 3, ts - 2);
      ctx.strokeStyle = '#6b3b14';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 5);
      ctx.lineTo(x + ts - 5, y + ts - 5);
      ctx.moveTo(x + ts - 5, y + 5);
      ctx.lineTo(x + 5, y + ts - 5);
      ctx.stroke();
      ctx.fillStyle = '#4b5563';
      ctx.fillRect(x + 1, y + ts / 2 - 2, ts - 2, 4);
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(x + 1, y + ts / 2 - 2, ts - 2, 1);
      ctx.strokeStyle = '#1a0e05';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, ts - 1.5, ts - 1.5);
      if (hp < GAME_CONFIG.walls.destructibleHp) {
        ctx.strokeStyle = '#140a03';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 9, y + 2);
        ctx.lineTo(x + 14, y + 13);
        ctx.lineTo(x + 10, y + 22);
        if (hp <= 1) {
          ctx.moveTo(x + 26, y + 4);
          ctx.lineTo(x + 18, y + 16);
          ctx.lineTo(x + 24, y + 29);
          ctx.moveTo(x + 2, y + 19);
          ctx.lineTo(x + 13, y + 21);
        }
        ctx.stroke();
        if (hp <= 1) {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x, y, ts, ts);
        }
      }
    }
  }

  private drawPowerup(ctx: CanvasRenderingContext2D, p: Snapshot['pu'][number], nowMs: number): void {
    const style = POWERUP_STYLE[p.k] ?? { color: '#fff', glyph: '?' };
    const bob = Math.sin(nowMs / 260 + p.id) * 1.5;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 220 + p.id);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gr = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 24);
    gr.addColorStop(0, style.color + 'aa');
    gr.addColorStop(1, style.color + '00');
    ctx.globalAlpha = 0.5 + pulse * 0.4;
    ctx.fillStyle = gr;
    ctx.fillRect(p.x - 24, p.y - 24, 48, 48);
    ctx.restore();
    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.rotate(Math.sin(nowMs / 600 + p.id) * 0.15);
    ctx.fillStyle = '#120f17';
    roundRect(ctx, -12, -12, 24, 24, 6);
    ctx.fill();
    const g = ctx.createLinearGradient(0, -11, 0, 11);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.25, style.color);
    g.addColorStop(1, shade(style.color));
    ctx.fillStyle = g;
    roundRect(ctx, -10.5, -10.5, 21, 21, 5);
    ctx.fill();
    ctx.fillStyle = '#0b1020';
    ctx.font = `700 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(style.glyph, 0, 1);
    ctx.restore();
  }

  private drawTank(
    ctx: CanvasRenderingContext2D,
    t: TankSnapshot,
    meta: PlayerMeta | undefined,
    isMe: boolean,
    nowMs: number,
  ): void {
    const team: TeamId = meta?.team ?? 1;
    const cls: TankClass = meta?.cls ?? 'assault';
    // tread animation from distance travelled (+ tread marks on the floor)
    let tr = this.tread.get(t.id);
    if (!tr) {
      tr = { x: t.x, y: t.y, d: 0 };
      this.tread.set(t.id, tr);
    }
    const moved = Math.hypot(t.x - tr.x, t.y - tr.y);
    if (moved > 0.5 && moved < 40) {
      tr.d += moved;
      if (!this.reduce && Math.floor(tr.d / 6) !== Math.floor((tr.d - moved) / 6)) this.treadMark(t, cls);
    }
    tr.x = t.x;
    tr.y = t.y;
    const frame = Math.floor(tr.d / 3) % 3;
    // hit flash when health drops
    const prevHp = this.lastHp.get(t.id);
    if (prevHp !== undefined && t.hp < prevHp) this.hitTick.set(t.id, nowMs);
    this.lastHp.set(t.id, t.hp);
    const flash = nowMs - (this.hitTick.get(t.id) ?? -1e9) < 90;
    const blink = t.pr === 1 && Math.floor(nowMs / 120) % 2 === 0;

    const img = tankSprite(cls, team, frame, flash);
    const w = img.width * TANK_SCALE;
    const h = img.height * TANK_SCALE;
    // shadow
    ctx.save();
    ctx.translate(t.x + 3, t.y + 4);
    ctx.rotate(t.a);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, -w * 0.36, -h * 0.36, w * 0.72, h * 0.72, 6);
    ctx.fill();
    ctx.restore();
    // own-tank marker ring
    if (isMe) {
      ctx.strokeStyle = 'rgba(255, 214, 90, 0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -nowMs / 50;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.a);
    if (blink) ctx.globalAlpha = 0.45;
    ctx.drawImage(img, -w * (22 / 52) - 0.0, -h / 2, w, h);
    ctx.restore();

    // shield bubble / ability auras
    if (t.sh > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const gr = ctx.createRadialGradient(t.x, t.y, 12, t.x, t.y, 24);
      gr.addColorStop(0, 'rgba(34,211,238,0)');
      gr.addColorStop(0.8, 'rgba(34,211,238,0.25)');
      gr.addColorStop(1, 'rgba(165,243,252,0.6)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (t.ab === 1 || (t.fx & 3) !== 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle =
        (t.fx & 1) !== 0 || cls === 'scout' ? 'rgba(250,204,21,0.7)' : 'rgba(244,114,182,0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 27 + Math.sin(nowMs / 90) * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private treadMark(t: TankSnapshot, cls: TankClass): void {
    const g = this.decalCtx;
    const off = cls === 'heavy' ? 9 : cls === 'scout' ? 6 : 8;
    const nx = -Math.sin(t.a);
    const ny = Math.cos(t.a);
    g.fillStyle = 'rgba(8,8,10,0.16)';
    for (const sgn of [-1, 1]) {
      g.save();
      g.translate(t.x - Math.cos(t.a) * 10 + nx * off * sgn, t.y - Math.sin(t.a) * 10 + ny * off * sgn);
      g.rotate(t.a);
      g.fillRect(-2, -2, 4, 4);
      g.restore();
    }
  }

  /** Health bar + name plate, drawn after all tanks so they never hide under another tank. */
  private drawTag(
    ctx: CanvasRenderingContext2D,
    t: TankSnapshot,
    meta: PlayerMeta | undefined,
    isMe: boolean,
  ): void {
    if (!meta?.name) return; // menu-background tanks have no tag
    const team = meta.team;
    const P = TEAM_PALETTE[team];
    const maxHp = GAME_CONFIG.classes[meta.cls].health;
    const frac = Math.max(0, Math.min(1, t.hp / maxHp));
    const below = t.y < 64;
    const barY = below ? t.y + 24 : t.y - 32;
    const bw = 36;
    ctx.fillStyle = 'rgba(10,8,14,0.8)';
    roundRect(ctx, t.x - bw / 2 - 2, barY - 1, bw + 4, 7, 3);
    ctx.fill();
    ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#ff4d5e';
    roundRect(ctx, t.x - bw / 2, barY + 0.5, Math.max(1, bw * frac), 4, 2);
    ctx.fill();
    if (t.sh > 0) {
      ctx.fillStyle = '#67e8f9';
      ctx.fillRect(t.x - bw / 2, barY - 2, Math.min(bw, (t.sh / 60) * bw), 1.5);
    }
    const label = `${team === 1 ? '▲' : '■'} ${meta.name}`;
    ctx.font = `600 10px ${FONT}`;
    const tw = ctx.measureText(label).width + 10;
    const ty = below ? barY + 16 : barY - 9;
    ctx.fillStyle = isMe ? 'rgba(255,201,60,0.92)' : 'rgba(10,8,14,0.72)';
    roundRect(ctx, t.x - tw / 2, ty - 7, tw, 13, 4);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isMe ? '#2b1700' : P.text;
    ctx.fillText(label, t.x, ty);
  }

  private drawBullets(ctx: CanvasRenderingContext2D, frame: Snapshot): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of frame.bullets) {
      const P = TEAM_PALETTE[b.t];
      const ux = Math.cos(b.a);
      const uy = Math.sin(b.a);
      ctx.strokeStyle = P.base;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(b.x - ux * 14, b.y - uy * 14);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(b.x - ux * 7, b.y - uy * 7);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFloats(ctx: CanvasRenderingContext2D, dt: number): void {
    if (this.floats.length === 0) return;
    ctx.font = `700 13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    this.floats = this.floats.filter((f) => {
      f.life -= dt;
      if (f.life <= 0) return false;
      f.y -= 32 * dt;
      ctx.globalAlpha = Math.min(1, f.life / 0.35);
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      return true;
    });
    ctx.globalAlpha = 1;
  }

  private drawParticles(ctx: CanvasRenderingContext2D, dt: number): void {
    const next: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = Math.pow(p.drag, dt);
      p.vx *= k;
      p.vy *= k;
      p.size = Math.max(0.5, p.size + p.grow * dt);
      const a = Math.max(0, p.life / p.max);
      if (p.add) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        if (p.size > 5) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.globalAlpha = 1;
      }
      next.push(p);
    }
    this.particles = next;
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const v = ctx.createRadialGradient(
      W / 2,
      H / 2,
      Math.min(W, H) * 0.4,
      W / 2,
      H / 2,
      Math.max(W, H) * 0.75,
    );
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(5,6,12,0.5)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /** Small whole-arena map (only when the camera follows): walls, crates, every tank, your view. */
  private drawMinimap(frame: Snapshot, players: Map<string, PlayerMeta>, meId: string | null): void {
    const ctx = this.ctx;
    const m = this.map;
    const d = this.dpr;
    const w = 128 * d;
    const h = ((128 * m.height) / m.width) * d;
    const x0 = 10 * d;
    const y0 = 10 * d; // top-left: the bottom-left corner belongs to the joystick on phones
    const k = w / m.width;
    ctx.fillStyle = 'rgba(10,12,22,0.78)';
    roundRect(ctx, x0 - 3 * d, y0 - 3 * d, w + 6 * d, h + 6 * d, 6 * d);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.staticLayer, x0, y0, w, h);
    ctx.globalAlpha = 1;
    const ts = m.tileSize;
    ctx.fillStyle = '#b8742f';
    for (const wl of m.walls)
      if ((this.wallHp[wl.id] ?? 0) > 0)
        ctx.fillRect(x0 + wl.col * ts * k, y0 + wl.row * ts * k, ts * k, ts * k);
    for (const t of frame.tanks) {
      if (!t.al) continue;
      const team = players.get(t.id)?.team ?? 1;
      ctx.fillStyle = TEAM_PALETTE[team].light;
      ctx.strokeStyle = t.id === meId ? '#ffd65c' : '#120f17';
      ctx.lineWidth = (t.id === meId ? 2 : 1) * d;
      ctx.beginPath();
      ctx.arc(x0 + t.x * k, y0 + t.y * k, (t.id === meId ? 3.5 : 2.6) * d, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = d;
    ctx.strokeRect(
      x0 + this.camX * k,
      y0 + this.camY * k,
      (this.cssW / this.scale) * k,
      (this.cssH / this.scale) * k,
    );
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number): number => Math.round(c * 0.6);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

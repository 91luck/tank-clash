import {
  GAME_CONFIG,
  TILE_SOLID,
  type MapDef,
  type Snapshot,
  type TankClass,
  type TankSnapshot,
  type TeamId,
} from '@tankclash/shared';

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
}

const TEAM_COLOR: Record<TeamId, { body: string; dark: string; text: string }> = {
  1: { body: '#4cc9f0', dark: '#11698a', text: '#9be3f7' },
  2: { body: '#ff8c42', dark: '#b2490a', text: '#ffc196' },
};

const TANK_DIMS: Record<TankClass, { w: number; h: number; barrel: number; barrelW: number }> = {
  assault: { w: 28, h: 20, barrel: 19, barrelW: 4 },
  heavy: { w: 30, h: 26, barrel: 20, barrelW: 6 },
  scout: { w: 26, h: 16, barrel: 17, barrelW: 3 },
};

const POWERUP_STYLE: Record<string, { color: string; glyph: string }> = {
  speed: { color: '#facc15', glyph: 'S' },
  shield: { color: '#22d3ee', glyph: 'O' },
  rapid: { color: '#f472b6', glyph: 'R' },
  health: { color: '#4ade80', glyph: '+' },
};

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly staticLayer: HTMLCanvasElement;
  private wallHp: Int8Array;
  private particles: Particle[] = [];
  private shakeMag = 0;
  private flashAlpha = 0;
  private flashColor = '#ff0000';
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dpr = 1;
  private lastDraw = 0;

  private floats: { x: number; y: number; text: string; color: string; life: number }[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MapDef,
    /** 'contain' letterboxes the whole map (gameplay); 'cover' fills the screen (menu background). */
    private readonly opts: { fit?: 'contain' | 'cover'; maxDpr?: number } = {},
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
    this.ctx = ctx;
    this.wallHp = new Int8Array(map.walls.length).fill(GAME_CONFIG.walls.destructibleHp);
    this.staticLayer = this.buildStaticLayer();
    this.resize();
  }

  // ------------------------------------------------------------ state from the simulation

  resetWalls(destroyed: readonly number[]): void {
    this.wallHp.fill(GAME_CONFIG.walls.destructibleHp);
    for (const id of destroyed) this.wallHp[id] = 0;
    this.particles = [];
  }

  setWallHp(id: number, hp: number): void {
    if (id >= 0 && id < this.wallHp.length) this.wallHp[id] = hp;
  }

  // ------------------------------------------------------------ effects

  muzzle(x: number, y: number, a: number, reduce: boolean): void {
    const n = reduce ? 2 : 5;
    for (let i = 0; i < n; i++) {
      const sp = 60 + Math.random() * 120;
      const ang = a + (Math.random() - 0.5) * 0.7;
      this.spawn(x, y, Math.cos(ang) * sp, Math.sin(ang) * sp, 0.12, '#fde68a', 2);
    }
  }

  impact(x: number, y: number, color: string, reduce: boolean): void {
    const n = reduce ? 3 : 8;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 110;
      this.spawn(x, y, Math.cos(ang) * sp, Math.sin(ang) * sp, 0.25 + Math.random() * 0.2, color, 2);
    }
  }

  explosion(x: number, y: number, reduce: boolean): void {
    const n = reduce ? 10 : 34;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 200;
      const color = ['#fde047', '#fb923c', '#ef4444', '#f8fafc'][i % 4] as string;
      this.spawn(
        x,
        y,
        Math.cos(ang) * sp,
        Math.sin(ang) * sp,
        0.35 + Math.random() * 0.45,
        color,
        2 + Math.random() * 3,
      );
    }
    if (!reduce) this.shakeMag = Math.min(8, this.shakeMag + 5);
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

  private spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    color: string,
    size: number,
  ): void {
    if (this.particles.length > 400) this.particles.shift();
    this.particles.push({ x, y, vx, vy, life, max: life, color, size });
  }

  // ------------------------------------------------------------ layout

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(this.opts.maxDpr ?? 2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const fit = this.opts.fit === 'cover' ? Math.max : Math.min;
    this.scale = fit(w / this.map.width, h / this.map.height);
    this.offX = (w - this.map.width * this.scale) / 2;
    this.offY = (h - this.map.height * this.scale) / 2;
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
    const dt = Math.min(0.05, this.lastDraw ? (nowMs - this.lastDraw) / 1000 : 0.016);
    this.lastDraw = nowMs;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0f1311';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    let sx = 0;
    let sy = 0;
    if (!reduceMotion && this.shakeMag > 0.1) {
      sx = (Math.random() - 0.5) * this.shakeMag;
      sy = (Math.random() - 0.5) * this.shakeMag;
    }
    this.shakeMag *= Math.pow(0.002, dt);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offX + sx * this.scale, this.offY + sy * this.scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.staticLayer, 0, 0);

    this.drawDestructibles(ctx);
    for (const p of frame.pu) this.drawPowerup(ctx, p, nowMs);
    for (const t of frame.tanks) {
      if (t.al) this.drawTank(ctx, t, players.get(t.id), t.id === meId, nowMs);
    }
    for (const b of frame.bullets) this.drawBullet(ctx, b);
    this.drawParticles(ctx, dt);
    this.drawFloats(ctx, dt);

    // boundary of the playfield (outside is letterbox)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.flashAlpha > 0.01 && !reduceMotion) {
      ctx.globalAlpha = this.flashAlpha;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }
    this.flashAlpha *= Math.pow(0.0008, dt);
  }

  private buildStaticLayer(): HTMLCanvasElement {
    const m = this.map;
    const c = document.createElement('canvas');
    c.width = m.width;
    c.height = m.height;
    const g = c.getContext('2d');
    if (!g) throw new Error('Canvas 2D is not supported in this browser.');
    const ts = m.tileSize;
    for (let r = 0; r < m.rows; r++) {
      for (let col = 0; col < m.cols; col++) {
        const x = col * ts;
        const y = r * ts;
        g.fillStyle = (r + col) % 2 === 0 ? '#232a26' : '#262e29';
        g.fillRect(x, y, ts, ts);
        const tile = m.tiles[r * m.cols + col];
        if (tile === TILE_SOLID) this.drawSteel(g, x, y, ts);
      }
    }
    // spawn pads, marked with a team icon so team identity is not colour-only
    for (const s of m.spawns) {
      const col = TEAM_COLOR[s.team];
      g.strokeStyle = col.body;
      g.globalAlpha = 0.5;
      g.lineWidth = 2;
      g.strokeRect(s.x - ts / 2 + 3, s.y - ts / 2 + 3, ts - 6, ts - 6);
      g.fillStyle = col.body;
      g.beginPath();
      if (s.team === 1) {
        g.moveTo(s.x, s.y - 6);
        g.lineTo(s.x + 6, s.y + 5);
        g.lineTo(s.x - 6, s.y + 5);
        g.closePath();
        g.fill();
      } else {
        g.fillRect(s.x - 5, s.y - 5, 10, 10);
      }
      g.globalAlpha = 1;
    }
    // power-up pads
    g.strokeStyle = '#94a3b8';
    g.globalAlpha = 0.35;
    g.setLineDash([3, 3]);
    for (const p of m.powerupPoints) {
      g.beginPath();
      g.arc(p.x, p.y, 13, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash([]);
    g.globalAlpha = 1;
    return c;
  }

  private drawSteel(g: CanvasRenderingContext2D, x: number, y: number, ts: number): void {
    g.fillStyle = '#69736c';
    g.fillRect(x, y, ts, ts);
    g.fillStyle = '#9aa59d';
    g.fillRect(x, y, ts, 3);
    g.fillRect(x, y, 3, ts);
    g.fillStyle = '#3c443f';
    g.fillRect(x, y + ts - 3, ts, 3);
    g.fillRect(x + ts - 3, y, 3, ts);
    g.fillStyle = '#2b322e';
    for (const [ox, oy] of [
      [6, 6],
      [ts - 8, 6],
      [6, ts - 8],
      [ts - 8, ts - 8],
    ] as const)
      g.fillRect(x + ox, y + oy, 2, 2);
  }

  private drawDestructibles(ctx: CanvasRenderingContext2D): void {
    const ts = this.map.tileSize;
    for (const w of this.map.walls) {
      const hp = this.wallHp[w.id] ?? 0;
      if (hp <= 0) continue;
      const x = w.col * ts;
      const y = w.row * ts;
      ctx.fillStyle = '#9a3f12';
      ctx.fillRect(x, y, ts, ts);
      ctx.fillStyle = '#c2571b';
      for (let by = 0; by < ts; by += 8) {
        const off = (by / 8) % 2 === 0 ? 0 : 8;
        for (let bx = -off; bx < ts; bx += 16) {
          ctx.fillRect(x + Math.max(0, bx) + 1, y + by + 1, Math.min(14, ts - Math.max(0, bx) - 1), 6);
        }
      }
      ctx.strokeStyle = '#3b1405';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
      if (hp < GAME_CONFIG.walls.destructibleHp) {
        ctx.strokeStyle = '#1c0a02';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 2);
        ctx.lineTo(x + 14, y + 14);
        ctx.lineTo(x + 10, y + 22);
        ctx.stroke();
        if (hp <= 1) {
          ctx.beginPath();
          ctx.moveTo(x + 26, y + 4);
          ctx.lineTo(x + 18, y + 16);
          ctx.lineTo(x + 24, y + 28);
          ctx.moveTo(x + 2, y + 18);
          ctx.lineTo(x + 12, y + 20);
          ctx.stroke();
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x, y, ts, ts);
        }
      }
    }
  }

  private drawPowerup(ctx: CanvasRenderingContext2D, p: Snapshot['pu'][number], nowMs: number): void {
    const style = POWERUP_STYLE[p.k] ?? { color: '#fff', glyph: '?' };
    const pulse = 1 + Math.sin(nowMs / 220) * 0.08;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(0, 1, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(11, 0);
    ctx.lineTo(0, 11);
    ctx.lineTo(-11, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0b1020';
    ctx.font = "600 13px 'Chakra Petch', system-ui, sans-serif";
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
    const col = TEAM_COLOR[team];
    const d = TANK_DIMS[cls];
    const blink = t.pr === 1 && Math.floor(nowMs / 120) % 2 === 0;

    ctx.save();
    ctx.translate(t.x, t.y);
    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(2, 3, d.w / 2 + 1, d.h / 2 + 1, t.a, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(t.a);
    paintTank(ctx, cls, team, blink);
    ctx.restore();

    // shield / ability auras
    if (t.sh > 0) {
      ctx.strokeStyle = 'rgba(34,211,238,0.9)';
      ctx.fillStyle = 'rgba(34,211,238,0.15)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 19, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (t.ab === 1 || (t.fx & 3) !== 0) {
      ctx.strokeStyle =
        (t.fx & 1) !== 0 || cls === 'scout' ? 'rgba(250,204,21,0.8)' : 'rgba(244,114,182,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(t.x, t.y, 22 + Math.sin(nowMs / 90) * 1.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // health bar + name tag (with team icon). Menu-background tanks have no name and no tag.
    if (!meta?.name) return;
    const maxHp = GAME_CONFIG.classes[cls].health;
    const frac = Math.max(0, Math.min(1, t.hp / maxHp));
    const bw = 34;
    // Near the top edge, put the tag under the tank so it never hides behind the HUD or leaves the map.
    const below = t.y < 64;
    const barY = below ? t.y + 20 : t.y - 30;
    const textY = below ? t.y + 38 : t.y - 34;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(t.x - bw / 2 - 1, barY, bw + 2, 7);
    ctx.fillStyle = frac > 0.5 ? '#7bd88f' : frac > 0.25 ? '#f4c430' : '#ff6b5e';
    ctx.fillRect(t.x - bw / 2, barY + 1, bw * frac, 5);
    const label = `${team === 1 ? '▲' : '■'} ${meta.name}`;
    ctx.font = "600 11px 'Chakra Petch', system-ui, sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(label, t.x, textY);
    ctx.fillStyle = isMe ? '#f4c430' : col.text;
    ctx.fillText(label, t.x, textY);
  }

  private drawBullet(ctx: CanvasRenderingContext2D, b: Snapshot['bullets'][number]): void {
    const col = TEAM_COLOR[b.t];
    ctx.strokeStyle = col.body;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x - Math.cos(b.a) * 10, b.y - Math.sin(b.a) * 10);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, GAME_CONFIG.bullet.radius + 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFloats(ctx: CanvasRenderingContext2D, dt: number): void {
    if (this.floats.length === 0) return;
    ctx.font = "600 13px 'Chakra Petch', system-ui, sans-serif";
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
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
      p.vx *= Math.pow(0.02, dt);
      p.vy *= Math.pow(0.02, dt);
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      next.push(p);
    }
    ctx.globalAlpha = 1;
    this.particles = next;
  }
}

/** Draws a tank at the origin facing +x. Shared by the battlefield and the UI icons (lobby, class cards). */
function paintTank(ctx: CanvasRenderingContext2D, cls: TankClass, team: TeamId, blink = false): void {
  const col = TEAM_COLOR[team];
  const d = TANK_DIMS[cls];
  const body = blink ? '#ffffff' : col.body;
  const hw = d.w / 2;
  const hh = d.h / 2;

  // Treads (heavy: wider, scout: thin)
  const tread = cls === 'heavy' ? 6 : cls === 'scout' ? 4 : 5;
  ctx.fillStyle = '#1a1f1c';
  ctx.fillRect(-hw, -hh - 2, d.w, tread);
  ctx.fillRect(-hw, hh + 2 - tread, d.w, tread);
  ctx.fillStyle = '#4d5751';
  for (let i = -hw + 2; i < hw; i += 5) {
    ctx.fillRect(i, -hh - 2, 2, tread);
    ctx.fillRect(i, hh + 2 - tread, 2, tread);
  }

  // Hull: each class has its own silhouette so it reads at a glance, even at icon size.
  ctx.fillStyle = body;
  ctx.strokeStyle = col.dark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (cls === 'scout') {
    // Narrow wedge pointing forward.
    ctx.moveTo(-hw, -hh + 2);
    ctx.lineTo(hw - 2, -4);
    ctx.lineTo(hw + 1, 0);
    ctx.lineTo(hw - 2, 4);
    ctx.lineTo(-hw, hh - 2);
    ctx.lineTo(-hw + 4, 0);
  } else if (cls === 'heavy') {
    // Big box with a sloped front plate.
    ctx.moveTo(-hw + 1, -hh + 2);
    ctx.lineTo(hw - 4, -hh + 2);
    ctx.lineTo(hw, -hh + 6);
    ctx.lineTo(hw, hh - 6);
    ctx.lineTo(hw - 4, hh - 2);
    ctx.lineTo(-hw + 1, hh - 2);
  } else {
    // Assault: rectangle with bevelled front corners.
    ctx.moveTo(-hw + 1, -hh + 2);
    ctx.lineTo(hw - 3, -hh + 2);
    ctx.lineTo(hw, -hh + 5);
    ctx.lineTo(hw, hh - 5);
    ctx.lineTo(hw - 3, hh - 2);
    ctx.lineTo(-hw + 1, hh - 2);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Class details
  ctx.fillStyle = col.dark;
  if (cls === 'heavy') {
    // Side armour skirts and an engine grille.
    ctx.fillRect(-hw + 2, -hh + 3, d.w - 8, 2);
    ctx.fillRect(-hw + 2, hh - 5, d.w - 8, 2);
    for (let y = -4; y <= 4; y += 4) ctx.fillRect(-hw + 3, y - 1, 5, 2);
  } else if (cls === 'scout') {
    // Rear fins.
    ctx.fillRect(-hw - 2, -hh + 1, 4, 3);
    ctx.fillRect(-hw - 2, hh - 4, 4, 3);
  } else {
    ctx.fillRect(-hw + 3, -2, 4, 4); // engine deck
  }

  // Barrel(s)
  ctx.fillStyle = '#e2e8f0';
  if (cls === 'heavy') {
    ctx.fillRect(0, -4.5, d.barrel, 3);
    ctx.fillRect(0, 1.5, d.barrel, 3);
    ctx.fillStyle = '#9aa5ae';
    ctx.fillRect(d.barrel - 3, -5, 3, 4);
    ctx.fillRect(d.barrel - 3, 1, 3, 4);
  } else {
    ctx.fillRect(0, -d.barrelW / 2, d.barrel, d.barrelW);
    if (cls === 'assault') {
      ctx.fillStyle = '#9aa5ae';
      ctx.fillRect(d.barrel - 3, -d.barrelW / 2 - 1, 3, d.barrelW + 2); // muzzle brake
    }
  }

  // Turret
  ctx.fillStyle = col.dark;
  ctx.beginPath();
  if (cls === 'heavy') ctx.rect(-7, -7, 13, 14);
  else ctx.arc(0, 0, cls === 'scout' ? 5.5 : 7, 0, Math.PI * 2);
  ctx.fill();

  // Team icon on the turret (shape, not just colour)
  ctx.fillStyle = '#fff';
  const k = cls === 'scout' ? 0.75 : 1;
  if (team === 1) {
    ctx.beginPath();
    ctx.moveTo(4 * k, 0);
    ctx.lineTo(-3 * k, -3.5 * k);
    ctx.lineTo(-3 * k, 3.5 * k);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillRect(-3 * k, -3 * k, 6 * k, 6 * k);
  }
}

/** Render a small tank picture into a canvas element (used by lobby rows and class cards). */
export function drawTankIcon(
  canvas: HTMLCanvasElement,
  cls: TankClass,
  team: TeamId,
  cssW: number,
  cssH: number,
): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  const scale = Math.min(cssW / 34, cssH / 30) * dpr;
  g.setTransform(scale, 0, 0, scale, canvas.width / 2 - 2 * scale, canvas.height / 2);
  paintTank(g, cls, team);
}

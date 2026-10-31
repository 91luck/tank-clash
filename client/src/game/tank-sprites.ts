import type { TankClass, TeamId } from '@tankclash/shared';

/**
 * Top-down pixel-art tanks, drawn by code (no image files). Each design pixel is laid out on a small grid, outlined
 * automatically, then scaled up 2x without smoothing, so that rotating the sprite at draw time (with smoothing) keeps
 * crisp, readable edges at any angle. Three tread frames animate the tracks while driving.
 *
 * Sprites face +x (to the right). The sprite centre is the tank centre.
 */

export const TANK_SPRITE_W = 52;
export const TANK_SPRITE_H = 44;
const D = 2; // output density

export const TEAM_PALETTE: Record<
  TeamId,
  { base: string; light: string; dark: string; deep: string; text: string }
> = {
  1: { base: '#2ea8e6', light: '#8ddcff', dark: '#156a99', deep: '#0b3f5e', text: '#a6e4ff' },
  2: { base: '#ff8a3d', light: '#ffc699', dark: '#b84d0d', deep: '#6e2b04', text: '#ffc9a3' },
};

const OUTLINE: [number, number, number] = [16, 14, 22];

type Paint = (x: number, y: number, w: number, h: number, c: string) => void;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable');
  return [c, g];
}

/** Draw with `paint`, outline, then upscale 2x (nearest neighbour). */
function build(draw: (p: Paint) => void, white = false): HTMLCanvasElement {
  const W = TANK_SPRITE_W;
  const H = TANK_SPRITE_H;
  const [c, g] = makeCanvas(W, H);
  draw((x, y, w, h, col) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  });
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && (d[(y * W + x) * 4 + 3] as number) > 100;
  const edge: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)))
        edge.push((y * W + x) * 4);
  for (const i of edge) {
    d[i] = OUTLINE[0];
    d[i + 1] = OUTLINE[1];
    d[i + 2] = OUTLINE[2];
    d[i + 3] = 255;
  }
  if (white)
    for (let i = 0; i < d.length; i += 4)
      if ((d[i + 3] as number) > 0) {
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
      }
  g.putImageData(img, 0, 0);
  const [out, og] = makeCanvas(W * D, H * D);
  og.imageSmoothingEnabled = false;
  og.drawImage(c, 0, 0, W * D, H * D);
  return out;
}

interface Layout {
  treadLen: number;
  treadW: number;
  treadGap: number; // distance from centre line to the inner edge of a tread
  hullL: number;
  hullW: number;
  turretR: number;
  barrel: number;
  barrelW: number;
}

const LAYOUT: Record<TankClass, Layout> = {
  assault: { treadLen: 32, treadW: 7, treadGap: 8, hullL: 28, hullW: 18, turretR: 7, barrel: 19, barrelW: 4 },
  heavy: { treadLen: 36, treadW: 8, treadGap: 10, hullL: 32, hullW: 22, turretR: 8, barrel: 18, barrelW: 3 },
  scout: { treadLen: 28, treadW: 5, treadGap: 7, hullL: 26, hullW: 14, turretR: 5, barrel: 21, barrelW: 2 },
};

function drawTank(p: Paint, cls: TankClass, team: TeamId, frame: number): void {
  const P = TEAM_PALETTE[team];
  const L = LAYOUT[cls];
  const cx = 22;
  const cy = TANK_SPRITE_H / 2;

  // ---- treads (links scroll with `frame`)
  for (const side of [-1, 1]) {
    const y = side < 0 ? cy - L.treadGap - L.treadW : cy + L.treadGap;
    const x0 = cx - L.treadLen / 2;
    p(x0, y, L.treadLen, L.treadW, '#23262c');
    p(x0 + 1, y + (side < 0 ? 0 : L.treadW - 1), L.treadLen - 2, 1, '#3a3f48');
    for (let x = x0 + ((frame * 2) % 4); x < x0 + L.treadLen - 1; x += 4)
      p(x, y + 1, 2, L.treadW - 2, '#4c535e');
    // wheels peeking out
    for (let k = 0; k < 4; k++)
      p(x0 + 3 + k * Math.floor((L.treadLen - 6) / 3), y + Math.floor(L.treadW / 2) - 1, 2, 2, '#15171b');
  }

  // ---- hull
  const hx = cx - L.hullL / 2;
  const hy = cy - L.hullW / 2;
  if (cls === 'scout') {
    // narrow wedge: rows get shorter toward the edges
    for (let r = 0; r < L.hullW; r++) {
      const off = Math.abs(r - (L.hullW - 1) / 2);
      const len = L.hullL - Math.round(off * 1.4);
      p(hx, hy + r, len, 1, r < L.hullW / 2 ? P.base : P.dark);
    }
    p(hx + 2, hy + 3, L.hullL - 10, 2, P.light);
    p(hx - 2, hy + 1, 3, 3, P.deep); // rear fins
    p(hx - 2, hy + L.hullW - 4, 3, 3, P.deep);
  } else {
    p(hx, hy, L.hullL, L.hullW, P.base);
    // bevelled front corners
    p(hx + L.hullL - 2, hy, 2, 3, P.dark);
    p(hx + L.hullL - 2, hy + L.hullW - 3, 2, 3, P.dark);
    // light from the top-left, shade bottom-right
    p(hx, hy, L.hullL - 2, 2, P.light);
    p(hx, hy, 2, L.hullW, P.light);
    p(hx, hy + L.hullW - 2, L.hullL, 2, P.dark);
    p(hx + L.hullL - 2, hy, 2, L.hullW, P.dark);
    if (cls === 'heavy') {
      // side skirts + engine grille + armour panel lines
      p(hx + 3, hy + 3, L.hullL - 8, 1, P.dark);
      p(hx + 3, hy + L.hullW - 4, L.hullL - 8, 1, P.dark);
      for (let k = 0; k < 4; k++) p(hx + 3, hy + 6 + k * 3, 5, 1, P.deep);
      p(hx + L.hullL - 6, hy + 4, 2, L.hullW - 8, P.light);
    } else {
      // engine deck + hatch
      p(hx + 3, hy + L.hullW / 2 - 3, 5, 6, P.dark);
      p(hx + 4, hy + L.hullW / 2 - 2, 3, 1, P.light);
      p(hx + L.hullL - 7, hy + 3, 3, 2, P.dark);
    }
  }
  // exhaust
  p(hx - 1, cy - 1, 2, 2, '#2a2d33');

  // ---- barrel(s)
  const bx = cx + 2;
  if (cls === 'heavy') {
    for (const oy of [-4, 2]) {
      p(bx, cy + oy, L.barrel, L.barrelW, '#cfd6df');
      p(bx, cy + oy + L.barrelW - 1, L.barrel, 1, '#8b96a3');
      p(bx + L.barrel - 3, cy + oy - 1, 3, L.barrelW + 2, '#6b7480');
    }
  } else {
    const by = cy - Math.floor(L.barrelW / 2);
    p(bx, by, L.barrel, L.barrelW, '#d6dde6');
    p(bx, by + L.barrelW - 1, L.barrel, 1, '#8b96a3');
    if (cls === 'assault')
      p(bx + L.barrel - 4, by - 1, 4, L.barrelW + 2, '#6b7480'); // muzzle brake
    else p(bx + L.barrel - 2, by, 2, L.barrelW, '#6b7480');
  }

  // ---- turret
  const r = L.turretR;
  if (cls === 'heavy') {
    p(cx - r, cy - r, r * 2, r * 2, P.dark);
    p(cx - r, cy - r, r * 2, 2, P.base);
    p(cx - r, cy - r, 2, r * 2, P.base);
    p(cx + r - 2, cy - r + 2, 2, r * 2 - 2, P.deep);
  } else {
    for (let y = -r; y <= r; y++) {
      const half = Math.round(Math.sqrt(r * r - y * y));
      p(cx - half, cy + y, half * 2, 1, y < -r / 3 ? P.base : P.dark);
    }
    p(cx - Math.round(r * 0.5), cy - r + 1, Math.round(r * 0.8), 1, P.light);
  }
  // team icon on the turret: ▲ Alpha (points forward), ■ Bravo
  if (team === 1) {
    const s = cls === 'scout' ? 2 : 3;
    for (let i = 0; i <= s; i++) p(cx - s + i, cy - (s - i), 1, (s - i) * 2 + 1, '#ffffff');
  } else {
    const s = cls === 'scout' ? 2 : 3;
    p(cx - s, cy - s, s * 2, s * 2, '#ffffff');
  }
}

const cache = new Map<string, HTMLCanvasElement>();

/** Tank sprite (2x density, facing right). `frame` 0..2 animates the treads; `white` gives the hit-flash version. */
export function tankSprite(cls: TankClass, team: TeamId, frame: number, white = false): HTMLCanvasElement {
  const key = `${cls}|${team}|${frame % 3}|${white ? 1 : 0}`;
  let c = cache.get(key);
  if (!c) {
    c = build((p) => drawTank(p, cls, team, frame % 3), white);
    cache.set(key, c);
  }
  return c;
}

/** Render a tank picture into a canvas element (lobby rows, class cards). */
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
  g.imageSmoothingEnabled = false;
  const img = tankSprite(cls, team, 0);
  const s = Math.min(canvas.width / img.width, canvas.height / img.height);
  const w = img.width * s;
  const h = img.height * s;
  g.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

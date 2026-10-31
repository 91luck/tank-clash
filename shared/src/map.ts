import { GAME_CONFIG, type TeamId } from './config';

/**
 * Maps are authored as the top-left quadrant only and mirrored horizontally and vertically.
 * That makes every map fair by construction (both teams get identical geometry) and keeps
 * new maps cheap to add: add another MapSource to MAP_SOURCES.
 *
 * Legend: '#' solid wall, 'b' destructible wall, '.' floor, '1' team-1 spawn (mirrored to
 * team 2 on the right half), 'p' power-up spawn point.
 */
export interface MapSource {
  id: string;
  name: string;
  quadrant: readonly string[];
}

export const MAP_SOURCES: readonly MapSource[] = [
  {
    id: 'foundry',
    name: 'The Foundry',
    quadrant: [
      '################',
      '#1..............',
      '#..bb....#......',
      '#..b.....#..p...',
      '#1.......b......',
      '#....##..b..bb..',
      '#....#..........',
      '#..p...bb..##...',
      '#......b........',
      '#......b....b...',
    ],
  },
];

export const TILE_EMPTY = 0;
export const TILE_SOLID = 1;
export const TILE_DESTRUCTIBLE = 2;

export interface SpawnPoint {
  team: TeamId;
  x: number;
  y: number;
  angle: number;
}

export interface DestructibleWall {
  id: number;
  col: number;
  row: number;
}

export interface MapDef {
  id: string;
  name: string;
  cols: number;
  rows: number;
  tileSize: number;
  width: number;
  height: number;
  /** Static tile layout (row-major). Destructible tiles are TILE_DESTRUCTIBLE; their live state lives in the sim. */
  tiles: Uint8Array;
  walls: DestructibleWall[];
  /** wallIdAt[row*cols+col] = wall id or -1. */
  wallIdAt: Int16Array;
  spawns: SpawnPoint[];
  powerupPoints: { x: number; y: number }[];
}

function mirrorRow(row: string, swapSpawns: boolean): string {
  const right = [...row].reverse().map((c) => (swapSpawns && c === '1' ? '2' : c));
  return row + right.join('');
}

export function buildMap(source: MapSource): MapDef {
  const q = source.quadrant;
  const rowsTopToBottom: string[] = [];
  for (const r of q) rowsTopToBottom.push(mirrorRow(r, true));
  const bottom = [...rowsTopToBottom].reverse();
  const all = [...rowsTopToBottom, ...bottom];

  const rows = all.length;
  const cols = (all[0] ?? '').length;
  const tile = GAME_CONFIG.tileSize;
  const tiles = new Uint8Array(cols * rows);
  const wallIdAt = new Int16Array(cols * rows).fill(-1);
  const walls: DestructibleWall[] = [];
  const spawns: SpawnPoint[] = [];
  const powerupPoints: { x: number; y: number }[] = [];

  for (let r = 0; r < rows; r++) {
    const line = all[r] ?? '';
    if (line.length !== cols)
      throw new Error(`Map ${source.id}: row ${r} has ${line.length} cols, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const ch = line[c];
      const cx = c * tile + tile / 2;
      const cy = r * tile + tile / 2;
      const idx = r * cols + c;
      if (ch === '#') tiles[idx] = TILE_SOLID;
      else if (ch === 'b') {
        tiles[idx] = TILE_DESTRUCTIBLE;
        const id = walls.length;
        walls.push({ id, col: c, row: r });
        wallIdAt[idx] = id;
      } else if (ch === '1' || ch === '2') {
        const team: TeamId = ch === '1' ? 1 : 2;
        spawns.push({ team, x: cx, y: cy, angle: team === 1 ? 0 : Math.PI });
      } else if (ch === 'p') {
        powerupPoints.push({ x: cx, y: cy });
      }
    }
  }

  return {
    id: source.id,
    name: source.name,
    cols,
    rows,
    tileSize: tile,
    width: cols * tile,
    height: rows * tile,
    tiles,
    walls,
    wallIdAt,
    spawns,
    powerupPoints,
  };
}

const MAP_CACHE = new Map<string, MapDef>();

export function getMap(id = 'foundry'): MapDef {
  let m = MAP_CACHE.get(id);
  if (!m) {
    const src = MAP_SOURCES.find((s) => s.id === id);
    if (!src) throw new Error(`Unknown map: ${id}`);
    m = buildMap(src);
    const errors = validateMap(m);
    if (errors.length > 0) throw new Error(`Map ${id} is invalid: ${errors.join('; ')}`);
    MAP_CACHE.set(id, m);
  }
  return m;
}

export const tileAt = (map: MapDef, col: number, row: number): number =>
  col < 0 || row < 0 || col >= map.cols || row >= map.rows
    ? TILE_SOLID
    : (map.tiles[row * map.cols + col] ?? TILE_SOLID);

/**
 * Structural validation run at startup and in tests. Returns a list of problems (empty = valid).
 */
export function validateMap(map: MapDef): string[] {
  const errors: string[] = [];
  const r = GAME_CONFIG.tank.radius;

  // Boundary must be fully solid.
  for (let c = 0; c < map.cols; c++) {
    if (tileAt(map, c, 0) !== TILE_SOLID || tileAt(map, c, map.rows - 1) !== TILE_SOLID)
      errors.push(`open boundary at col ${c}`);
  }
  for (let rr = 0; rr < map.rows; rr++) {
    if (tileAt(map, 0, rr) !== TILE_SOLID || tileAt(map, map.cols - 1, rr) !== TILE_SOLID)
      errors.push(`open boundary at row ${rr}`);
  }

  const teamCounts: Record<number, number> = { 1: 0, 2: 0 };
  for (const s of map.spawns) {
    teamCounts[s.team] = (teamCounts[s.team] ?? 0) + 1;
    if (s.x < r || s.y < r || s.x > map.width - r || s.y > map.height - r)
      errors.push(`spawn outside map at ${s.x},${s.y}`);
    const col = Math.floor(s.x / map.tileSize);
    const row = Math.floor(s.y / map.tileSize);
    if (tileAt(map, col, row) !== TILE_EMPTY) errors.push(`spawn overlaps a wall at ${col},${row}`);
  }
  if (teamCounts[1] !== teamCounts[2]) errors.push('teams have unequal spawn counts');
  if ((teamCounts[1] ?? 0) < GAME_CONFIG.match.maxPlayers / 2)
    errors.push('not enough spawns per team for max players');

  for (const p of map.powerupPoints) {
    const col = Math.floor(p.x / map.tileSize);
    const row = Math.floor(p.y / map.tileSize);
    if (tileAt(map, col, row) !== TILE_EMPTY) errors.push(`power-up point inside a wall at ${col},${row}`);
  }

  // Connectivity: with ALL destructible walls intact (worst case), every spawn and power-up point must be
  // reachable from the first team-1 spawn, so neither team can be walled off.
  const start = map.spawns.find((s) => s.team === 1);
  if (start) {
    const seen = new Uint8Array(map.cols * map.rows);
    const stack = [Math.floor(start.y / map.tileSize) * map.cols + Math.floor(start.x / map.tileSize)];
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      if (seen[idx]) continue;
      seen[idx] = 1;
      const c = idx % map.cols;
      const rr = Math.floor(idx / map.cols);
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (tileAt(map, c + dc, rr + dr) === TILE_EMPTY) stack.push((rr + dr) * map.cols + (c + dc));
      }
    }
    const reachable = (x: number, y: number): boolean =>
      seen[Math.floor(y / map.tileSize) * map.cols + Math.floor(x / map.tileSize)] === 1;
    for (const s of map.spawns) if (!reachable(s.x, s.y)) errors.push(`spawn ${s.x},${s.y} unreachable`);
    for (const p of map.powerupPoints)
      if (!reachable(p.x, p.y)) errors.push(`power-up ${p.x},${p.y} unreachable`);
  } else errors.push('no team-1 spawn');

  // Mirror symmetry (horizontal and vertical) of tiles.
  for (let rr = 0; rr < map.rows; rr++) {
    for (let c = 0; c < map.cols; c++) {
      const a = tileAt(map, c, rr);
      if (a !== tileAt(map, map.cols - 1 - c, rr) || a !== tileAt(map, c, map.rows - 1 - rr)) {
        errors.push(`asymmetric tile at ${c},${rr}`);
        return errors;
      }
    }
  }
  return errors;
}

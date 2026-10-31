import type { Snapshot, TankSnapshot } from '@tankclash/shared';
import { GAME_CONFIG } from '@tankclash/shared';

interface Entry {
  t: number;
  s: Snapshot;
}

const TWO_PI = Math.PI * 2;

export function lerpAngle(a: number, b: number, f: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * f;
}

/**
 * Buffers snapshots on a server-time axis (seconds) and produces an interpolated frame for any render time.
 * Remote tanks are rendered slightly in the past so there are always two snapshots to blend between.
 */
export class Timeline {
  private entries: Entry[] = [];

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  latest(): Snapshot | null {
    return this.entries.at(-1)?.s ?? null;
  }

  latestTime(): number {
    return this.entries.at(-1)?.t ?? 0;
  }

  /** Out-of-order or duplicate snapshots (older than the newest we have) are ignored. */
  push(t: number, s: Snapshot): boolean {
    const last = this.entries.at(-1);
    if (last && t <= last.t) return false;
    this.entries.push({ t, s });
    if (this.entries.length > 40) this.entries.splice(0, this.entries.length - 40);
    return true;
  }

  /** Interpolated frame at server time `t`. Holds the first/last snapshot outside the buffered range. */
  sample(t: number): Snapshot | null {
    const n = this.entries.length;
    if (n === 0) return null;
    const first = this.entries[0] as Entry;
    const last = this.entries[n - 1] as Entry;
    if (n === 1 || t >= last.t)
      return this.extrapolateBullets(last.s, Math.min(0.1, Math.max(0, t - last.t)));
    if (t <= first.t) return first.s;

    let i = n - 2;
    while (i > 0 && (this.entries[i] as Entry).t > t) i--;
    const a = this.entries[i] as Entry;
    const b = this.entries[i + 1] as Entry;
    const f = (t - a.t) / (b.t - a.t);

    const prevById = new Map<string, TankSnapshot>();
    for (const tank of a.s.tanks) prevById.set(tank.id, tank);
    const tanks = b.s.tanks.map((tb): TankSnapshot => {
      const ta = prevById.get(tb.id);
      if (!ta || !ta.al || !tb.al) return tb;
      // Teleports (respawn) must not slide across the map.
      if (Math.hypot(tb.x - ta.x, tb.y - ta.y) > 80) return tb;
      return { ...tb, x: ta.x + (tb.x - ta.x) * f, y: ta.y + (tb.y - ta.y) * f, a: lerpAngle(ta.a, tb.a, f) };
    });
    return { ...b.s, tanks, bullets: this.interpBullets(a.s, b.s, f) };
  }

  private interpBullets(a: Snapshot, b: Snapshot, f: number): Snapshot['bullets'] {
    const prev = new Map(a.bullets.map((x) => [x.id, x]));
    return b.bullets.map((bb) => {
      const aa = prev.get(bb.id);
      return aa ? { ...bb, x: aa.x + (bb.x - aa.x) * f, y: aa.y + (bb.y - aa.y) * f } : bb;
    });
  }

  /** Bullets fly straight, so when we run slightly past the newest snapshot we can extend them cosmetically. */
  private extrapolateBullets(s: Snapshot, dt: number): Snapshot {
    if (dt <= 0 || s.bullets.length === 0) return s;
    const v = GAME_CONFIG.bullet.speed * dt;
    return {
      ...s,
      bullets: s.bullets.map((b) => ({ ...b, x: b.x + Math.cos(b.a) * v, y: b.y + Math.sin(b.a) * v })),
    };
  }
}

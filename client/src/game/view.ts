import {
  GAME_CONFIG,
  getMap,
  type MapDef,
  type SimEvent,
  type Snapshot,
  type TankSnapshot,
} from '@tankclash/shared';
import type { Sfx } from '../audio/sfx';
import type { Settings } from '../settings';
import { $, el, formatClock } from '../ui/dom';
import { Renderer, type PlayerMeta } from './renderer';

const TEAM_ICON = { 1: '▲', 2: '■' } as const;
const TEAM_NAME = { 1: 'Alpha', 2: 'Bravo' } as const;

/**
 * Everything the player sees during a match, shared by online and practice modes:
 * canvas drawing, HUD, kill feed, countdown / eliminated overlays and sound/particle reactions to sim events.
 */
export class MatchView {
  readonly map: MapDef;
  private readonly renderer: Renderer;
  private players = new Map<string, PlayerMeta>();
  private meId = '';
  private lastPhase = '';
  private lastCountdown = -1;
  private killedBy = '';
  private fps = 0;
  private frames = 0;
  private fpsSince = 0;
  private bannerTimer = 0;
  private streak = 0;
  private coachUntil = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly sfx: Sfx,
    private readonly settings: () => Settings,
  ) {
    this.map = getMap();
    this.renderer = new Renderer(canvas, this.map);
    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('orientationchange', () => window.setTimeout(() => this.renderer.resize(), 150));
  }

  /** Shots fired by the local player this match (server-confirmed); used by tests and the debug hook. */
  myShots = 0;

  begin(meId: string, players: PlayerMeta[], first: Snapshot): void {
    this.meId = meId;
    this.myShots = 0;
    this.setPlayers(players);
    this.renderer.resetWalls(first.wd ?? []);
    this.lastPhase = '';
    this.lastCountdown = -1;
    this.killedBy = '';
    this.streak = 0;
    $('killfeed').replaceChildren();
    $('banner').classList.remove('show');
    const cls = this.players.get(meId)?.cls ?? 'assault';
    $('ability-label').textContent = GAME_CONFIG.classes[cls].ability.name;
    this.renderer.resize();
  }

  setPlayers(players: PlayerMeta[]): void {
    this.players = new Map(players.map((p) => [p.id, p]));
  }

  resize(): void {
    this.renderer.resize();
  }

  // ------------------------------------------------------------ events

  onEvents(events: readonly SimEvent[]): void {
    const reduce = this.settings().reduceMotion;
    for (const ev of events) {
      switch (ev.e) {
        case 'shot': {
          const mine = ev.tank === this.meId;
          this.renderer.muzzle(ev.x, ev.y, ev.a, reduce);
          if (mine) {
            this.sfx.play('fire');
            this.myShots++;
          }
          break;
        }
        case 'wallHit':
          this.renderer.setWallHp(ev.wall, ev.hp);
          this.renderer.impact(ev.x, ev.y, '#c2571b', reduce);
          this.sfx.play('wall');
          break;
        case 'solidHit':
          this.renderer.impact(ev.x, ev.y, '#cbd5e1', reduce);
          break;
        case 'wallDown': {
          this.renderer.setWallHp(ev.wall, 0);
          const w = this.map.walls[ev.wall];
          if (w)
            this.renderer.explosion(
              (w.col + 0.5) * this.map.tileSize,
              (w.row + 0.5) * this.map.tileSize,
              true,
            );
          break;
        }
        case 'hit':
          this.renderer.impact(ev.x, ev.y, ev.shield ? '#22d3ee' : '#fca5a5', reduce);
          // Damage numbers only for fights you are part of, so the screen stays readable in 4v4.
          if (ev.target === this.meId || ev.by === this.meId)
            this.renderer.floatText(
              ev.x,
              ev.y - 10,
              `-${Math.round(ev.dmg)}`,
              ev.shield ? '#4cc9f0' : ev.target === this.meId ? '#ff6b5e' : '#ecebdf',
            );
          this.sfx.play(ev.target === this.meId || ev.by === this.meId ? 'hit' : 'wall');
          if (ev.target === this.meId) this.renderer.flash('#ef4444', 0.28);
          break;
        case 'kill':
          this.renderer.explosion(ev.x, ev.y, reduce);
          this.sfx.play('explode');
          this.addKillFeed(ev.killer, ev.victim);
          if (ev.victim === this.meId) {
            this.killedBy = this.players.get(ev.killer)?.name ?? 'an enemy tank';
            this.streak = 0;
          }
          if (ev.killer === this.meId) {
            this.streak++;
            const victim = this.players.get(ev.victim)?.name ?? 'an enemy';
            this.showBanner(
              this.streak >= 3
                ? `${this.streak} in a row!`
                : this.streak === 2
                  ? 'Double kill'
                  : `You destroyed ${victim}`,
            );
          }
          break;
        case 'ability':
          if (ev.tank === this.meId) {
            this.sfx.play('ability');
            this.renderer.flash('#facc15', 0.15);
          }
          break;
        case 'powerTake':
          if (ev.tank === this.meId) this.sfx.play('powerup');
          break;
        case 'phase':
          if (ev.phase === 'playing') this.sfx.play('go');
          break;
        default:
          break;
      }
    }
  }

  showBanner(text: string, bad = false): void {
    const b = $('banner');
    b.textContent = text;
    b.classList.toggle('bad', bad);
    b.classList.add('show');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), 1600);
  }

  /** First-match control hints, shown during the countdown and the first seconds of play. */
  showCoach(text: string, ms: number): void {
    const c = $('coach');
    c.textContent = text;
    c.hidden = false;
    this.coachUntil = performance.now() + ms;
  }

  hideCoach(): void {
    $('coach').hidden = true;
    this.coachUntil = 0;
  }

  private addKillFeed(killerId: string, victimId: string): void {
    const k = this.players.get(killerId);
    const v = this.players.get(victimId);
    const row = el('div', {
      text: `${k ? TEAM_ICON[k.team] : '?'} ${k?.name ?? '?'}  ✕  ${v ? TEAM_ICON[v.team] : '?'} ${v?.name ?? '?'}`,
    });
    const feed = $('killfeed');
    feed.append(row);
    while (feed.childElementCount > 5) feed.firstElementChild?.remove();
    window.setTimeout(() => row.remove(), 5000);
  }

  // ------------------------------------------------------------ per-frame

  /** `frame` is the interpolated world; `mine` optionally overrides the local tank (client-side prediction). */
  draw(
    frame: Snapshot,
    latest: Snapshot,
    nowMs: number,
    mine: { x: number; y: number; a: number } | null,
    net: { rtt: number } | null,
  ): void {
    let drawn = frame;
    if (mine) {
      drawn = {
        ...frame,
        tanks: frame.tanks.map((t) =>
          t.id === this.meId && t.al ? { ...t, x: mine.x, y: mine.y, a: mine.a } : t,
        ),
      };
    }
    this.renderer.draw(drawn, this.players, this.meId, nowMs, this.settings().reduceMotion);
    this.updateHud(latest, net, nowMs);
  }

  private updateHud(s: Snapshot, net: { rtt: number } | null, nowMs: number): void {
    const me = s.tanks.find((t) => t.id === this.meId);
    if (this.coachUntil && nowMs > this.coachUntil && s.phase !== 'countdown') this.hideCoach();
    $('hud-score-1').querySelector('b')!.textContent = String(s.sc[0]);
    $('hud-score-2').querySelector('b')!.textContent = String(s.sc[1]);
    const timer = $('hud-timer');
    timer.textContent =
      s.phase === 'overtime'
        ? 'OVERTIME'
        : formatClock(s.phase === 'countdown' ? GAME_CONFIG.match.durationSec : s.left);
    timer.classList.toggle('overtime', s.phase === 'overtime');

    if (me) this.updateSelfHud(me);
    this.updateOverlays(s, me);

    this.frames++;
    if (nowMs - this.fpsSince >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (nowMs - this.fpsSince));
      this.frames = 0;
      this.fpsSince = nowMs;
      const hudNet = $('hud-net');
      hudNet.textContent = this.settings().showStats ? `${this.fps} fps${net ? ` · ${net.rtt} ms` : ''}` : '';
    }
  }

  private updateSelfHud(me: TankSnapshot): void {
    const cls = this.players.get(this.meId)?.cls ?? 'assault';
    const max = GAME_CONFIG.classes[cls].health;
    const frac = Math.max(0, Math.min(1, me.hp / max));
    const bar = $('hp-bar');
    bar.style.width = `${Math.round(frac * 100)}%`;
    bar.classList.toggle('low', frac < 0.3);
    bar.parentElement?.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    $('hp-text').textContent = `${Math.max(0, Math.ceil(me.hp))}${me.sh > 0 ? ` +${Math.ceil(me.sh)}` : ''}`;

    const chips = $('status-chips');
    const abilityName = GAME_CONFIG.classes[cls].ability.name;
    const ability =
      me.ab === 1
        ? `${abilityName}: active`
        : me.cd > 0
          ? `${abilityName}: ${me.cd.toFixed(0)}s`
          : `${abilityName}: ready`;
    const items: { text: string; ready?: boolean }[] = [{ text: ability, ready: me.ab === 1 || me.cd <= 0 }];
    if (me.pr === 1) items.push({ text: 'Protected' });
    if ((me.fx & 1) !== 0) items.push({ text: 'Speed ⚡' });
    if ((me.fx & 2) !== 0) items.push({ text: 'Rapid »' });
    const sig = items.map((i) => i.text + (i.ready ? '*' : '')).join('|');
    if (chips.dataset.sig !== sig) {
      chips.dataset.sig = sig;
      chips.replaceChildren(
        ...items.map((i) => el('span', { class: `chip${i.ready ? ' ready' : ''}`, text: i.text })),
      );
    }
    // Touch ability button shows cooldown state.
    const btn = $('btn-touch-ability');
    btn.classList.toggle('cooling', me.cd > 0 && me.ab !== 1);
  }

  private updateOverlays(s: Snapshot, me: TankSnapshot | undefined): void {
    const cd = $('overlay-countdown');
    if (s.phase === 'countdown') {
      cd.hidden = false;
      const n = Math.max(1, Math.ceil(s.left));
      $('countdown-num').textContent = String(n);
      $('countdown-sub').textContent = 'Get ready';
      if (n !== this.lastCountdown) {
        this.lastCountdown = n;
        this.sfx.play('beep');
      }
    } else {
      cd.hidden = true;
    }
    if (s.phase !== this.lastPhase) {
      if (s.phase === 'overtime') {
        const t = $('countdown-num');
        t.textContent = 'OVERTIME';
        $('countdown-sub').textContent = 'Next kill wins';
        cd.hidden = false;
        window.setTimeout(() => {
          if (this.lastPhase === 'overtime') cd.hidden = true;
        }, 1800);
      }
      this.lastPhase = s.phase;
    }
    const elim = $('overlay-eliminated');
    const dead = !!me && me.al === 0 && s.phase !== 'ended' && s.phase !== 'countdown';
    elim.hidden = !dead;
    if (dead && me) {
      $('elim-by').textContent = this.killedBy ? `Destroyed by ${this.killedBy}` : '';
      $('elim-count').textContent = String(Math.max(0, Math.ceil(me.rs)));
    }
  }

  teamLabel(team: 1 | 2): string {
    return `${TEAM_ICON[team]} ${TEAM_NAME[team]}`;
  }
}

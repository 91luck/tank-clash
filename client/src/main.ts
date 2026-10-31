import '@fontsource/saira-stencil-one/latin-400.css';
import '@fontsource/chakra-petch/latin-400.css';
import '@fontsource/chakra-petch/latin-600.css';
import './style.css';
import {
  DIFFICULTIES,
  GAME_CONFIG,
  NAME_REGEX,
  ROOM_CODE_REGEX,
  TANK_CLASSES,
  parseJoinPath,
  type BoardEntry,
  type Difficulty,
  type RoomInfo,
  type ServerMessage,
  type TankClass,
  type TeamId,
} from '@tankclash/shared';
import { Sfx } from './audio/sfx';
import { inviteLink, httpBase } from './env';
import { AttractMode } from './game/attract';
import { OnlineMatch } from './game/online';
import { PracticeMatch, type PracticeOptions } from './game/practice';
import { drawTankIcon, type PlayerMeta } from './game/renderer';
import { MatchView } from './game/view';
import { InputController } from './input/input';
import { Connection, type ConnState } from './net/connection';
import { registerPwa } from './pwa';
import { SettingsStore, keyLabel } from './settings';
import { canFullscreen, enterLandscapeFullscreen, isIOS, isStandalone, phoneMatchGesture } from './ui/phone';
import {
  $,
  closeOverlay,
  confirmDialog,
  currentScreen,
  el,
  installModalKeys,
  isOverlayOpen,
  openOverlay,
  showScreen,
  toast,
  type ScreenName,
} from './ui/dom';

// ---------------------------------------------------------------- state

const settings = new SettingsStore();
const sfx = new Sfx();
const view = new MatchView($('game') as HTMLCanvasElement, sfx, () => settings.value);

let me: { id: string; name: string } | null = null;
let room: RoomInfo | null = null;
let online: OnlineMatch | null = null;
let practice: PracticeMatch | null = null;
let practiceOpts: PracticeOptions | null = null;
let lastEnd: Extract<ServerMessage, { t: 'matchEnd' }> | null = null;
let pendingAction: (() => void) | null = null;
let lastRoomCode: string | null = null;
let userLeft = false;
let chosenClass: TankClass = 'assault';
type ServerStatus = 'checking' | 'waking' | 'ready' | 'down';
let serverStatus: ServerStatus = 'checking';
const SERVER_LABEL: Record<ServerStatus, string> = {
  checking: 'Checking server…',
  waking: 'Server waking up…',
  ready: 'Server ready',
  down: 'Server offline · Practice works',
};
/** Set when "Play now with bots" is pressed: the next lobby we host gets filled with bots and started. */
let autoBotStart: Difficulty | null = null;
let queueSince = 0;
let wakeTimer = 0;
let wakeStarted = 0;

const touchCapable = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

const input = new InputController({
  settings: () => settings.value,
  getAngle: () => online?.angle ?? practice?.angle ?? 0,
  isActive: () => currentScreen() === 'game' && !isPaused() && !isOverlayOpen('overlay-conn'),
  onPause: () => {
    if (currentScreen() === 'game') (isPaused() ? resume : pause)();
    else if (!$('overlay-conn').hidden) return;
  },
});
input.attach();

function isPaused(): boolean {
  return isOverlayOpen('overlay-pause');
}

// ---------------------------------------------------------------- connection

const conn = new Connection({
  onState: (state, attempt) => renderConnState(state, attempt),
  onWelcome: (w) => {
    me = { id: w.id, name: w.name };
    if (!w.resumed && room) {
      // The server forgot us (grace period expired or restarted): whatever we were in is gone.
      room = null;
      stopOnline();
      if (currentScreen() === 'game' || currentScreen() === 'lobby' || currentScreen() === 'results') {
        showScreen('menu');
        toast('You were disconnected for too long, so the room was closed.', 'error');
      }
    }
    closeOverlay('overlay-conn');
    hideWake();
    const act = pendingAction;
    pendingAction = null;
    act?.();
  },
  onMessage: (m) => onServerMessage(m),
});

function renderConnState(state: ConnState, attempt: number): void {
  const pill = $('conn-pill');
  pill.dataset.state = state;
  const label: Record<ConnState, string> = {
    idle: SERVER_LABEL[serverStatus],
    connecting: 'Connecting…',
    open: 'Online',
    reconnecting: 'Reconnecting…',
    lost: 'Disconnected',
  };
  pill.textContent = label[state];
  if (state === 'idle') pill.dataset.state = serverStatus;
  if (state === 'open' || state === 'idle' || state === 'connecting') closeOverlay('overlay-conn');
  else if (state === 'lost' || room !== null || online !== null) {
    $('conn-text').textContent =
      state === 'lost'
        ? 'Could not reach the server. It may be starting up (free hosts sleep when idle) or your network is down.'
        : `Trying to reconnect… (attempt ${attempt + 1})`;
    $('conn-spinner').hidden = state === 'lost';
    openOverlay('overlay-conn');
  }
  if (state === 'open') online?.sendNeutral();
  if (state === 'lost' && isOverlayOpen('overlay-wake')) {
    hideWake();
    closeOverlay('overlay-conn');
    showError(
      'The game server did not answer. It may still be starting, or it may be down. Try again in a minute, or play Practice offline.',
    );
  }
}

// ---------------------------------------------------------------- "server waking up" screen
// Free hosting sleeps when idle; the first visitor waits for a cold start. Say so plainly, show progress,
// and offer something to do meanwhile.

function showWakeSoon(): void {
  window.clearTimeout(wakeTimer);
  wakeStarted = performance.now();
  wakeTimer = window.setTimeout(function tick() {
    if (conn.isOpen || !pendingAction) return hideWake();
    if (!isOverlayOpen('overlay-wake')) openOverlay('overlay-wake');
    const sec = Math.round((performance.now() - wakeStarted) / 1000);
    $('wake-elapsed').textContent = `${sec} s`;
    $('wake-bar').style.width = `${Math.min(96, (sec / 60) * 100)}%`;
    wakeTimer = window.setTimeout(tick, 500);
  }, 1500);
}

function hideWake(): void {
  window.clearTimeout(wakeTimer);
  closeOverlay('overlay-wake');
}

$('btn-wake-cancel').addEventListener('click', () => {
  pendingAction = null;
  hideWake();
  conn.close(true);
  showScreen('menu');
});
$('btn-wake-practice').addEventListener('click', () => {
  pendingAction = null;
  hideWake();
  conn.close(true);
  showScreen('practice');
});

function showError(text: string): void {
  $('error-text').textContent = text;
  openOverlay('overlay-error');
}

function ensureConnected(action: () => void): void {
  sfx.unlock();
  userLeft = false;
  const name = currentName();
  if (conn.isOpen) {
    action();
    return;
  }
  pendingAction = action;
  if (conn.state === 'idle' || conn.state === 'lost') {
    conn.connect(name);
    showWakeSoon();
  } else toast('Connecting to the server…');
}

function currentName(fromId = 'name-input'): string {
  const raw = ($(fromId) as HTMLInputElement).value.trim();
  const name =
    raw && NAME_REGEX.test(raw)
      ? raw.slice(0, GAME_CONFIG.limits.maxNameLength)
      : settings.value.name || `Player${100 + Math.floor(Math.random() * 900)}`;
  if (name !== settings.value.name) settings.update({ name });
  ($('name-input') as HTMLInputElement).value = name;
  ($('join-name') as HTMLInputElement).value = name;
  return name;
}

// ---------------------------------------------------------------- server messages

function onServerMessage(m: ServerMessage): void {
  switch (m.t) {
    case 'room':
      onRoom(m.room);
      break;
    case 'left':
      room = null;
      leaveToMenu(false);
      break;
    case 'matchStart':
      startOnlineMatch(m);
      break;
    case 'snap':
      online?.onSnap(m);
      break;
    case 'matchEnd':
      showResults(m, true);
      break;
    case 'queue':
      if (m.status === 'queued') {
        if (currentScreen() !== 'queue') enterQueue();
        $('queue-info').textContent =
          m.size < 2
            ? 'Nobody else is searching right now. Wait a moment, or start straight away against bots.'
            : `${m.size} players found. Starting shortly…`;
        $('btn-queue-bots').hidden = m.size >= 2 || performance.now() - queueSince < 5000;
      } else if (currentScreen() === 'queue') showScreen('menu');
      break;
    case 'error':
      onServerError(m);
      break;
    default:
      break;
  }
}

function onServerError(m: Extract<ServerMessage, { t: 'error' }>): void {
  switch (m.code) {
    case 'room_not_found':
    case 'room_expired':
    case 'room_full':
    case 'match_in_progress':
    case 'already_in_room': {
      if (currentScreen() === 'join') {
        const p = $('join-error');
        p.textContent = m.message;
        p.hidden = false;
      } else toast(m.message, 'error');
      break;
    }
    case 'session_expired':
      toast('Your previous session expired. Starting fresh.', 'error');
      break;
    case 'rate_limited':
      toast('Slow down a little: too many requests.', 'error');
      break;
    case 'bad_version':
      showError('This page is out of date. Please reload to get the latest version of the game.');
      break;
    case 'too_many_connections':
    case 'server_busy':
      showError(m.message);
      break;
    default:
      toast(m.message, 'error');
  }
}

function onRoom(r: RoomInfo): void {
  const prevPhase = room?.phase;
  room = r;
  lastRoomCode = r.code;
  if (r.phase === 'match') {
    // Names/connection flags can change mid-match.
    view.setPlayers(playersFromRoom(r));
    return;
  }
  if (r.phase === 'lobby') {
    if (online) stopOnline();
    if (autoBotStart && me && r.hostId === me.id) {
      const skill = autoBotStart;
      autoBotStart = null;
      conn.send({ t: 'fillBots', difficulty: skill });
      conn.send({ t: 'startMatch' });
    }
    renderLobby();
    if (currentScreen() !== 'lobby') {
      showScreen('lobby');
      if (userLeft) return;
      history.replaceState(null, '', `/join/${r.code}`);
    }
  } else if (r.phase === 'results') {
    renderResultsButtons();
    if (prevPhase === 'match' || currentScreen() === 'results') renderResultsButtons();
  }
}

function playersFromRoom(r: RoomInfo): PlayerMeta[] {
  return r.players.map((p) => ({ id: p.id, name: p.name, team: p.team, cls: p.cls }));
}

// ---------------------------------------------------------------- online match

function startOnlineMatch(m: Extract<ServerMessage, { t: 'matchStart' }>): void {
  stopOnline();
  stopPractice();
  if (!room) return;
  closeOverlay('overlay-pause');
  lastEnd = null;
  showScreen('game', false);
  $('pause-note').textContent = 'Online matches keep running while this menu is open.';
  setupTouch();
  online = new OnlineMatch(m, playersFromRoom(room), view, conn, input);
  online.run();
  maybeCoach();
}

/** Control hints the first time someone plays (adapted to touch or keyboard). */
function maybeCoach(): void {
  if (settings.value.coachSeen) return;
  settings.update({ coachSeen: true });
  view.showCoach(
    touchCapable
      ? 'Drag your left thumb to drive the way you point. Tap Fire with your right thumb.'
      : `Drive with W A S D or the arrow keys. Fire with ${keyLabel(settings.value.keyFire)}, ability with ${keyLabel(settings.value.keyAbility)}.`,
    9000,
  );
}

function stopOnline(): void {
  online?.stop();
  online = null;
}

function setupTouch(): void {
  $('touch').hidden = !touchCapable;
  // The "Drag to drive" label teaches the control once; after the first touch it would only hide the map.
  if (settings.value.coachSeen) $('joy-zone').classList.add('used');
  const portrait = touchCapable && window.innerHeight > window.innerWidth;
  $('overlay-portrait').hidden = !portrait || sessionStorage.getItem('portraitDismissed') === '1';
  // Android browsers can rotate + go fullscreen from a tap; iPhones can't, so give them the next best thing.
  $('btn-portrait-rotate').hidden = !canFullscreen() || isStandalone() || isIOS(); // iPhone Safari: no element fullscreen
  $('portrait-tip').textContent =
    isIOS() && !isStandalone()
      ? 'Tip: in Safari tap Share → "Add to Home Screen" and open the game from there to hide the browser bars.'
      : '';
}

window.addEventListener('resize', () => {
  if (currentScreen() !== 'game') return;
  const portrait = touchCapable && window.innerHeight > window.innerWidth;
  if (!portrait) $('overlay-portrait').hidden = true;
});
$('joy-zone').addEventListener('pointerdown', () => $('joy-zone').classList.add('used'));
$('btn-portrait-rotate').addEventListener('click', async () => {
  if (await enterLandscapeFullscreen()) $('overlay-portrait').hidden = true;
  else toast('Rotate your phone sideways (auto-rotate may be off).');
});
$('btn-portrait-dismiss').addEventListener('click', () => {
  $('overlay-portrait').hidden = true;
  try {
    sessionStorage.setItem('portraitDismissed', '1');
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------- practice

function startPractice(opts: PracticeOptions): void {
  sfx.unlock();
  stopPractice();
  stopOnline();
  practiceOpts = opts;
  closeOverlay('overlay-pause');
  showScreen('game', false);
  $('pause-note').textContent = 'The practice match is paused.';
  setupTouch();
  practice = new PracticeMatch(opts, view, input, (r) => showResults(r, false));
  practice.run();
  maybeCoach();
}

function stopPractice(): void {
  practice?.stop();
  practice = null;
}

// ---------------------------------------------------------------- pause

function pause(): void {
  if (currentScreen() !== 'game') return;
  practice?.setPaused(true);
  online?.sendNeutral();
  openOverlay('overlay-pause');
}

function resume(): void {
  closeOverlay('overlay-pause');
  practice?.setPaused(false);
}

$('btn-pause').addEventListener('click', pause);
$('btn-resume').addEventListener('click', resume);
$('btn-pause-leave').addEventListener('click', async () => {
  const ok = await confirmDialog(
    online ? 'Leave this match? Your team plays on without you.' : 'Quit the practice match?',
    'Leave',
  );
  if (!ok) return;
  closeOverlay('overlay-pause');
  if (online) leaveRoom();
  else leaveToMenu(true);
});
$('btn-pause-sound').addEventListener('click', () => {
  settings.update({ muted: !settings.value.muted });
});
$('btn-fullscreen').addEventListener('click', async () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  if (!canFullscreen()) {
    toast(
      isIOS()
        ? 'iPhone browsers have no fullscreen. Use Share → "Add to Home Screen".'
        : 'Fullscreen is not available here.',
    );
    return;
  }
  await enterLandscapeFullscreen();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && currentScreen() === 'game') {
    online?.sendNeutral();
    if (practice) pause();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (currentScreen() === 'game' && online) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------- results

function showResults(
  r: Pick<Extract<ServerMessage, { t: 'matchEnd' }>, 'winner' | 'scores' | 'board' | 'overtime'>,
  isOnline: boolean,
): void {
  stopOnline();
  stopPractice();
  closeOverlay('overlay-pause');
  lastEnd = { t: 'matchEnd', ...r };
  const myTeam = r.board.find((b) => b.id === (isOnline ? me?.id : 'me'))?.team;
  const title = $('h-results');
  if (r.winner === 0) title.textContent = 'Draw';
  else if (myTeam === r.winner) title.textContent = 'Victory!';
  else if (myTeam) title.textContent = 'Defeat';
  else title.textContent = `${r.winner === 1 ? '▲ Alpha' : '■ Bravo'} wins`;
  title.dataset.result = r.winner === 0 ? 'draw' : myTeam === r.winner ? 'win' : 'loss';
  $('result-sub').textContent =
    `${r.winner === 0 ? 'Nobody wins this one.' : `Team ${r.winner === 1 ? 'Alpha' : 'Bravo'} wins.`} ` +
    `Final score ▲ ${r.scores[0]} – ${r.scores[1]} ■` +
    (!r.overtime
      ? ''
      : r.winner === 0
        ? ' (no kill in sudden-death overtime)'
        : ' (won in sudden-death overtime)');
  if (r.winner !== 0 && myTeam) sfx.play(myTeam === r.winner ? 'victory' : 'defeat');
  const top = [...r.board].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
  $('result-mvp').textContent =
    top && top.kills > 0 ? `Top tank: ${top.name} with ${top.kills} kill${top.kills === 1 ? '' : 's'}` : '';
  renderBoard(r.board, isOnline ? me?.id : 'me');
  showScreen('results');
  renderResultsButtons();
}

function renderBoard(board: BoardEntry[], meId: string | undefined): void {
  const rows = [...board].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  $('board-body').replaceChildren(
    ...rows.map((b) => {
      const tr = el('tr', { class: b.id === meId ? 'me' : '' });
      tr.append(
        el('td', { text: b.name + (b.id === meId ? ' (you)' : '') }),
        el('td', { class: `t${b.team}`, text: b.team === 1 ? '▲ Alpha' : '■ Bravo' }),
        el('td', { text: GAME_CONFIG.classes[b.cls].label }),
        el('td', { text: String(b.kills) }),
        el('td', { text: String(b.deaths) }),
      );
      return tr;
    }),
  );
}

function renderResultsButtons(): void {
  if (currentScreen() !== 'results') return;
  const hint = $('results-hint');
  const rematch = $('btn-rematch') as HTMLButtonElement;
  const toLobby = $('btn-to-lobby') as HTMLButtonElement;
  if (practice === null && room === null) {
    rematch.disabled = false;
    toLobby.hidden = true;
    hint.textContent = '';
    return;
  }
  const host = room?.hostId === me?.id;
  rematch.disabled = !host;
  toLobby.hidden = false;
  toLobby.disabled = !host;
  hint.textContent = host
    ? 'Start a rematch, or go back to the lobby to change squads, tanks or bots.'
    : 'Waiting for the host to start a rematch…';
}

$('btn-rematch').addEventListener('click', () => {
  phoneMatchGesture();
  if (room) conn.send({ t: 'rematch' });
  else if (practiceOpts) startPractice(practiceOpts);
});
$('btn-to-lobby').addEventListener('click', () => conn.send({ t: 'toLobby' }));
$('btn-results-leave').addEventListener('click', () => (room ? leaveRoom() : leaveToMenu(true)));

// ---------------------------------------------------------------- navigation

function leaveRoom(): void {
  userLeft = true;
  conn.send({ t: 'leaveRoom' });
  room = null;
  leaveToMenu(false);
}

function leaveToMenu(closeConn: boolean): void {
  stopOnline();
  stopPractice();
  practiceOpts = null;
  closeOverlay('overlay-pause');
  closeOverlay('overlay-conn');
  if (closeConn) {
    room = null;
    if (conn.state !== 'idle') conn.close(true);
  }
  history.replaceState(null, '', '/');
  showScreen('menu');
}

for (const b of document.querySelectorAll<HTMLElement>('[data-nav]')) {
  b.addEventListener('click', () => {
    pendingAction = null;
    showScreen(b.dataset.nav as ScreenName);
  });
}

// ---------------------------------------------------------------- menu actions

$('btn-play').addEventListener('click', () => {
  phoneMatchGesture();
  ensureConnected(() => {
    conn.send({ t: 'quickMatch' });
    enterQueue();
  });
});

function enterQueue(): void {
  showScreen('queue');
  queueSince = performance.now();
  $('btn-queue-bots').hidden = true;
  scheduleBotOffer();
}
$('btn-queue-cancel').addEventListener('click', () => {
  conn.send({ t: 'cancelQuick' });
  pendingAction = null;
  showScreen('menu');
});
function scheduleBotOffer(): void {
  window.setTimeout(() => {
    if (currentScreen() === 'queue' && !/players found/.test($('queue-info').textContent ?? ''))
      $('btn-queue-bots').hidden = false;
  }, 5000);
}
$('btn-queue-bots').addEventListener('click', () => {
  phoneMatchGesture();
  conn.send({ t: 'cancelQuick' });
  autoBotStart = 'normal';
  conn.send({ t: 'createRoom' });
});
$('btn-create').addEventListener('click', () => showScreen('create'));
$('btn-create-go').addEventListener('click', () => {
  const durationSec = Number(($('create-duration') as HTMLSelectElement).value);
  ensureConnected(() => conn.send({ t: 'createRoom', settings: { durationSec } }));
});
$('btn-join').addEventListener('click', () => {
  $('join-error').hidden = true;
  showScreen('join');
});
function submitJoin(): void {
  const code = ($('join-code') as HTMLInputElement).value.trim().toUpperCase();
  const err = $('join-error');
  if (!ROOM_CODE_REGEX.test(code)) {
    err.textContent = 'Room codes are 6 characters (letters A–Z except I, L, O, and digits 2–9).';
    err.hidden = false;
    return;
  }
  err.hidden = true;
  phoneMatchGesture();
  currentName('join-name');
  ensureConnected(() => conn.send({ t: 'joinRoom', code }));
}
$('btn-join-go').addEventListener('click', submitJoin);
$('join-code').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') submitJoin();
});

$('btn-howto').addEventListener('click', () => openOverlay('modal-howto'));
$('btn-settings').addEventListener('click', () => openOverlay('modal-settings'));
$('link-privacy').addEventListener('click', (e) => {
  e.preventDefault();
  openOverlay('modal-privacy');
});
for (const b of document.querySelectorAll<HTMLElement>('[data-close]')) {
  b.addEventListener('click', () => closeOverlay(b.closest<HTMLElement>('.overlay')?.id ?? ''));
}

$('btn-conn-retry').addEventListener('click', () => conn.retryNow());
$('btn-conn-menu').addEventListener('click', () => leaveToMenu(true));
$('btn-error-retry').addEventListener('click', () => {
  closeOverlay('overlay-error');
  conn.retryNow();
});
$('btn-error-menu').addEventListener('click', () => {
  closeOverlay('overlay-error');
  leaveToMenu(true);
});

// ---------------------------------------------------------------- class cards (lobby + practice)

const ROLE: Record<TankClass, string> = {
  assault: 'All-rounder',
  heavy: 'Tough and slow',
  scout: 'Fast and fragile',
};

function buildClassCards(container: HTMLElement, group: string, onPick: (c: TankClass) => void): void {
  const legend = container.querySelector('legend');
  container.replaceChildren(...(legend ? [legend] : []));
  const max = (f: (c: (typeof GAME_CONFIG.classes)[TankClass]) => number): number =>
    Math.max(...TANK_CLASSES.map((c) => f(GAME_CONFIG.classes[c])));
  const maxHp = max((c) => c.health);
  const maxSpeed = max((c) => c.speed);
  const maxDps = max((c) => c.damage / c.fireCooldown);
  const bar = (label: string, value: number, of: number): HTMLElement => {
    const i = el('i');
    i.style.setProperty('--v', `${Math.round((value / of) * 100)}%`);
    return el(
      'div',
      { class: 'stat', attrs: { 'aria-label': `${label} ${Math.round((value / of) * 10)} of 10` } },
      el('span', { text: label }),
      i,
    );
  };
  for (const cls of TANK_CLASSES) {
    const cfg = GAME_CONFIG.classes[cls];
    const label = el('label', { class: 'class-card' });
    const radio = el('input', {
      attrs: { type: 'radio', name: group, value: cls, 'data-testid': `${group}-${cls}` },
    });
    if (cls === chosenClass) radio.checked = true;
    radio.addEventListener('change', () => onPick(cls));
    const icon = el('canvas', { attrs: { 'aria-hidden': 'true' } });
    drawTankIcon(icon, cls, 1, 72, 52);
    label.append(
      radio,
      icon,
      el('b', { text: cfg.label }),
      el('span', { class: 'role', text: ROLE[cls] }),
      bar('Armor', cfg.health, maxHp),
      bar('Speed', cfg.speed, maxSpeed),
      bar('Firepower', cfg.damage / cfg.fireCooldown, maxDps),
      el('span', { class: 'ability', text: `Ability: ${cfg.ability.name}` }),
    );
    container.append(label);
  }
}

buildClassCards($('lobby-classes'), 'lobby-class', (c) => {
  chosenClass = c;
  conn.send({ t: 'setClass', cls: c });
});
buildClassCards($('practice-classes'), 'practice-class', (c) => {
  chosenClass = c;
});

// ---------------------------------------------------------------- lobby

function renderLobby(): void {
  if (!room || !me) return;
  const r = room;
  const myId = me.id;
  const host = r.hostId === myId;
  $('lobby-code').textContent = r.code;
  const link = inviteLink(r.code);
  ($('btn-whatsapp') as HTMLAnchorElement).href =
    `https://wa.me/?text=${encodeURIComponent(`Join my TANK CLASH battle! Room ${r.code}: ${link}`)}`;
  const mine = r.players.find((p) => p.id === myId);
  const perTeam = r.maxPlayers / 2;
  for (const team of [1, 2] as TeamId[]) {
    const members = r.players.filter((p) => p.team === team);
    $(`count-${team}`).textContent = `${members.length}/${perTeam}`;
    const rows = members.map((p) => {
      const icon = el('canvas', { attrs: { 'aria-hidden': 'true' } });
      drawTankIcon(icon, p.cls, team, 30, 22);
      const tags: HTMLElement[] = [el('span', { class: 'badge', text: GAME_CONFIG.classes[p.cls].label })];
      if (p.bot) tags.push(el('span', { class: 'badge bot', text: `bot · ${p.bot}` }));
      if (p.id === r.hostId) tags.push(el('span', { class: 'badge host', text: 'host' }));
      if (!p.connected) tags.push(el('span', { class: 'badge', text: 'reconnecting…' }));
      if (p.bot && host) {
        const x = el('button', {
          class: 'remove-bot',
          text: '×',
          attrs: { type: 'button', 'aria-label': `Remove ${p.name}`, 'data-testid': `remove-${p.id}` },
        });
        x.addEventListener('click', () => conn.send({ t: 'removeBot', id: p.id }));
        tags.push(x);
      }
      return el(
        'li',
        { class: p.id === myId ? 'me' : '' },
        icon,
        el('span', { class: 'pname', text: p.name + (p.id === myId ? ' (you)' : '') }),
        el('span', { class: 'tags' }, ...tags),
      );
    });
    if (rows.length === 0)
      rows.push(el('li', { class: 'empty', text: 'Empty: invite a friend or add a bot' }));
    $(`list-${team}`).replaceChildren(...rows);
    const btn = $(`btn-team-${team}`) as HTMLButtonElement;
    btn.disabled = mine?.team === team || members.length >= perTeam;
    ($(`btn-bot-${team}`) as HTMLButtonElement).disabled =
      members.length >= perTeam || r.players.length >= r.maxPlayers;
  }
  for (const n of document.querySelectorAll<HTMLElement>('#screen-lobby .host-only')) n.hidden = !host;
  if (mine && mine.cls !== chosenClass) chosenClass = mine.cls;
  for (const radio of $('lobby-classes').querySelectorAll<HTMLInputElement>('input'))
    radio.checked = radio.value === chosenClass;

  const dur = $('lobby-duration') as HTMLSelectElement;
  dur.value = String(r.settings.durationSec);
  dur.disabled = !host;
  const t1 = r.players.filter((p) => p.team === 1).length;
  const t2 = r.players.filter((p) => p.team === 2).length;
  const humans = r.players.filter((p) => !p.bot).length;
  const start = $('btn-start') as HTMLButtonElement;
  const ready = r.players.length >= GAME_CONFIG.match.minPlayers && t1 > 0 && t2 > 0;
  start.disabled = !host || !ready;
  start.hidden = !host;
  $('lobby-hint').textContent = !host
    ? 'Waiting for the host to start the match…'
    : r.players.length < GAME_CONFIG.match.minPlayers
      ? 'Send the invite link to a friend, or add a bot to play right away.'
      : !ready
        ? 'Both squads need at least one tank.'
        : humans === 1
          ? 'Ready. Friends can still join with the link until you start.'
          : 'Everyone is here? Start the match.';
  $('btn-share').hidden = typeof navigator.share !== 'function';
}

$('btn-team-1').addEventListener('click', () => conn.send({ t: 'setTeam', team: 1 }));
$('btn-team-2').addEventListener('click', () => conn.send({ t: 'setTeam', team: 2 }));
$('lobby-duration').addEventListener('change', (e) => {
  conn.send({ t: 'setSettings', settings: { durationSec: Number((e.target as HTMLSelectElement).value) } });
});
$('btn-start').addEventListener('click', () => {
  phoneMatchGesture();
  conn.send({ t: 'startMatch' });
});
const botSkill = (): Difficulty => {
  const v = ($('lobby-bot-skill') as HTMLSelectElement).value as Difficulty;
  return DIFFICULTIES.includes(v) ? v : 'normal';
};
$('btn-bot-1').addEventListener('click', () => conn.send({ t: 'addBot', team: 1, difficulty: botSkill() }));
$('btn-bot-2').addEventListener('click', () => conn.send({ t: 'addBot', team: 2, difficulty: botSkill() }));
$('btn-fill-bots').addEventListener('click', () => conn.send({ t: 'fillBots', difficulty: botSkill() }));
$('btn-leave-room').addEventListener('click', leaveRoom);
$('btn-copy-link').addEventListener('click', async () => {
  if (!room) return;
  const link = inviteLink(room.code);
  try {
    await navigator.clipboard.writeText(link);
    $('lobby-note').textContent = 'Invite link copied. Paste it in any chat.';
  } catch {
    $('lobby-note').textContent = `Copy this link: ${link}`;
  }
});
$('btn-share').addEventListener('click', async () => {
  if (!room) return;
  try {
    await navigator.share({
      title: 'TANK CLASH',
      text: `Join my TANK CLASH battle! Room ${room.code}`,
      url: inviteLink(room.code),
    });
  } catch {
    /* user cancelled the share sheet */
  }
});

// ---------------------------------------------------------------- practice setup

$('btn-practice').addEventListener('click', () => showScreen('practice'));
$('btn-practice-go').addEventListener('click', () => {
  phoneMatchGesture();
  const difficulty = ($('practice-diff') as HTMLSelectElement).value as Difficulty;
  const perTeam = Number(($('practice-format') as HTMLSelectElement).value) === 1 ? 1 : 2;
  if (!DIFFICULTIES.includes(difficulty)) return;
  startPractice({ name: currentName(), cls: chosenClass, difficulty, perTeam });
});

// ---------------------------------------------------------------- settings

function syncSettingsUi(): void {
  const s = settings.value;
  ($('set-volume') as HTMLInputElement).value = String(s.volume);
  ($('set-mute') as HTMLInputElement).checked = s.muted;
  ($('set-reduce') as HTMLInputElement).checked = s.reduceMotion;
  ($('set-fps') as HTMLInputElement).checked = s.showStats;
  ($('set-sens') as HTMLInputElement).value = String(s.touchSensitivity);
  $('rebind-fire').textContent = `Fire: ${keyLabel(s.keyFire)}`;
  $('rebind-ability').textContent = `Ability: ${keyLabel(s.keyAbility)}`;
  $('key-fire-label').textContent = keyLabel(s.keyFire);
  $('key-ability-label').textContent = keyLabel(s.keyAbility);
  $('btn-pause-sound').textContent = `Sound: ${s.muted ? 'off' : 'on'}`;
  $('btn-pause-sound').setAttribute('aria-pressed', String(s.muted));
  document.body.classList.toggle('reduce-motion', s.reduceMotion);
  sfx.setVolume(s.volume, s.muted);
}
settings.onChange(syncSettingsUi);
syncSettingsUi();

$('set-volume').addEventListener('input', (e) =>
  settings.update({ volume: Number((e.target as HTMLInputElement).value) }),
);
$('set-mute').addEventListener('change', (e) =>
  settings.update({ muted: (e.target as HTMLInputElement).checked }),
);
$('set-reduce').addEventListener('change', (e) =>
  settings.update({ reduceMotion: (e.target as HTMLInputElement).checked }),
);
$('set-fps').addEventListener('change', (e) =>
  settings.update({ showStats: (e.target as HTMLInputElement).checked }),
);
$('set-sens').addEventListener('input', (e) =>
  settings.update({ touchSensitivity: Number((e.target as HTMLInputElement).value) }),
);
function rebind(which: 'keyFire' | 'keyAbility', btn: HTMLElement): void {
  btn.textContent = 'Press a key…';
  $('rebind-note').textContent = 'Press the new key (Esc cancels).';
  input.captureKey((code) => {
    if (code !== 'Escape') {
      const other = which === 'keyFire' ? settings.value.keyAbility : settings.value.keyFire;
      if (code === other) toast('That key is already used for the other action.', 'error');
      else settings.update({ [which]: code });
    }
    syncSettingsUi();
    $('rebind-note').textContent = 'Driving always works with WASD and the arrow keys.';
  });
}
$('rebind-fire').addEventListener('click', () => rebind('keyFire', $('rebind-fire')));
$('rebind-ability').addEventListener('click', () => rebind('keyAbility', $('rebind-ability')));

// Browsers only start audio after a gesture.
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
window.addEventListener('keydown', () => sfx.unlock(), { once: true });

// ---------------------------------------------------------------- boot

installModalKeys(['modal-howto', 'modal-settings', 'modal-privacy', 'modal-confirm']);

($('name-input') as HTMLInputElement).value = settings.value.name;
($('join-name') as HTMLInputElement).value = settings.value.name;
$('name-input').addEventListener('change', () => currentName());
$('join-name').addEventListener('change', () => currentName('join-name'));

// Live bot battle behind the main menu; runs only while the menu is on screen and the tab is visible.
const attract = new AttractMode($('attract') as HTMLCanvasElement, () => settings.value.reduceMotion);
const syncAttract = (): void => {
  if (currentScreen() === 'menu' && !document.hidden) attract.start();
  else attract.stop();
};
document.addEventListener('screenchange', syncAttract);
document.addEventListener('visibilitychange', syncAttract);
settings.onChange(() => {
  attract.stop();
  syncAttract();
});

registerPwa($('btn-install'));

/**
 * Wake a sleeping free-tier backend while the player is still reading the menu, and tell them honestly
 * what state it is in (instead of a bare "Offline"). Practice never needs the server.
 */
function warmUpBackend(): void {
  setServerStatus('checking');
  const slow = window.setTimeout(() => {
    if (serverStatus === 'checking') setServerStatus('waking');
  }, 2500);
  const ctrl = new AbortController();
  const giveUp = window.setTimeout(() => ctrl.abort(), 90_000);
  fetch(`${httpBase()}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    .then(() => setServerStatus('ready'))
    .catch(() => setServerStatus('down'))
    .finally(() => {
      window.clearTimeout(slow);
      window.clearTimeout(giveUp);
    });
}

function setServerStatus(s: ServerStatus): void {
  serverStatus = s;
  if (conn.state === 'idle') renderConnState('idle', 0);
}

function boot(): void {
  warmUpBackend();
  const code = parseJoinPath(location.pathname);
  if (code) {
    ($('join-code') as HTMLInputElement).value = code;
    showScreen('join');
    $('h-join').textContent = 'You are invited';
    $(settings.value.name ? 'btn-join-go' : 'join-name').focus();
  } else {
    showScreen('menu');
  }
  renderConnState('idle', 0);
}

boot();

// Exposed for end-to-end tests and debugging only; carries no authority (the server is the authority).
(window as unknown as { __tankclash?: unknown }).__tankclash = {
  get screen() {
    return currentScreen();
  },
  get roomCode() {
    return room?.code ?? lastRoomCode;
  },
  get inMatch() {
    return online !== null || practice !== null;
  },
  get lastEnd() {
    return lastEnd;
  },
  get self() {
    return online?.self() ?? practice?.self() ?? null;
  },
  get myShots() {
    return view.myShots;
  },
};

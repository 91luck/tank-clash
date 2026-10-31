import { expect, test, type Page } from '@playwright/test';

const gotoMenu = async (page: Page, name: string): Promise<void> => {
  await page.goto('/');
  await expect(page.getByTestId('btn-play')).toBeVisible();
  await page.getByTestId('name-input').fill(name);
};

const screenOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tankclash: { screen: string } }).__tankclash.screen);

/** Wait until the battle is really on (countdown finished), without racing the countdown overlay's first frame. */
async function waitForBattle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __tankclash: { phase: string | null } }).__tankclash.phase,
        ),
      {
        timeout: 15_000,
      },
    )
    .toMatch(/^(playing|overtime)$/);
  await expect(page.getByTestId('countdown')).toBeHidden();
}

/** True when the canvas contains more than a flat colour, i.e. something was actually drawn. */
async function canvasHasContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.getElementById('game') as HTMLCanvasElement;
    const g = c.getContext('2d');
    if (!g) return false;
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number));
      if (seen.size > 12) return true;
    }
    return false;
  });
}

test('menu shows every entry point and no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoMenu(page, 'Tester');
  for (const id of ['btn-play', 'btn-create', 'btn-join', 'btn-practice', 'btn-howto', 'btn-settings']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await page.getByTestId('btn-howto').click();
  await expect(page.getByRole('dialog', { name: 'How to play' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'How to play' })).toBeHidden();
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('invalid room code shows an inline error and nothing is sent', async ({ page }) => {
  let sockets = 0;
  page.on('websocket', () => sockets++);
  await gotoMenu(page, 'Tester');
  await page.getByTestId('btn-join').click();
  await page.getByTestId('join-code').fill('ZZZ');
  await page.getByTestId('btn-join-go').click();
  await expect(page.locator('#join-error')).toBeVisible();
  expect(sockets).toBe(0); // validated locally, no connection opened
});

test('menu tells the player whether the game server is reachable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('conn-status')).toHaveText('Server ready');
});

test('unknown but well-formed room code reports room not found', async ({ page }) => {
  await gotoMenu(page, 'Tester');
  await page.getByTestId('btn-join').click();
  await page.getByTestId('join-code').fill('ABCDEF');
  await page.getByTestId('btn-join-go').click();
  await expect(page.locator('#join-error')).toContainText(/not found|no room|exist/i);
});

test('practice match: countdown, play, pause, resume, quit', async ({ page }) => {
  await gotoMenu(page, 'Solo');
  await page.getByTestId('btn-practice').click();
  await page.getByTestId('practice-diff').selectOption('easy');
  await page.getByTestId('btn-practice-go').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('countdown')).toBeVisible();
  await waitForBattle(page);
  expect(await canvasHasContent(page)).toBe(true);

  const hpBefore = await page.locator('#hp-text').textContent();
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Space');
  expect(hpBefore).toBeTruthy();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause')).toBeVisible();
  const t1 = await page.getByTestId('timer').textContent();
  await page.waitForTimeout(1500);
  expect(await page.getByTestId('timer').textContent()).toBe(t1); // practice really pauses
  await page.getByTestId('btn-resume').click();
  await expect(page.getByTestId('pause')).toBeHidden();

  await page.keyboard.press('Escape');
  await page.getByTestId('btn-pause-leave').click();
  await page.getByTestId('btn-confirm-yes').click();
  await expect(page.getByTestId('btn-play')).toBeVisible();
});

test('@fastclock private room: host creates, friend joins by invite link, picks a team, match runs to results', async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await gotoMenu(host, 'HostHen');
  await host.getByTestId('btn-create').click();
  await host.getByTestId('create-duration').selectOption('60');
  await host.getByTestId('btn-create-go').click();
  await expect(host.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await host.getByTestId('lobby-code').textContent()) as string;
  await expect(host.getByTestId('btn-start')).toBeDisabled();

  // Friend opens the invite link and presses Join.
  await guest.addInitScript(() =>
    localStorage.setItem('tankclash.settings.v1', JSON.stringify({ name: 'GuestGus' })),
  );
  await guest.goto(`/join/${code}`);
  await expect(guest.getByTestId('join-code')).toHaveValue(code);
  await guest.getByTestId('btn-join-go').click();
  await expect(guest.getByTestId('lobby-code')).toHaveText(code);
  await expect(host.locator('#list-1, #list-2')).toHaveCount(2);

  // Teams are auto-balanced (guest lands on Bravo). Switch to Alpha and back to prove team selection works.
  await expect(guest.getByTestId('btn-team-2')).toBeDisabled();
  await guest.getByTestId('btn-team-1').click();
  await expect(host.getByTestId('btn-start')).toBeDisabled(); // Bravo is now empty
  await guest.getByTestId('btn-team-2').click();
  await guest.getByTestId('lobby-class-scout').check({ force: true });
  await expect(host.getByTestId('btn-start')).toBeEnabled();
  await expect(guest.getByTestId('btn-start')).toBeHidden(); // only the host can start

  await host.getByTestId('btn-start').click();
  await expect(host.getByTestId('canvas')).toBeVisible();
  await expect(guest.getByTestId('canvas')).toBeVisible();
  await waitForBattle(host);
  expect(await canvasHasContent(host)).toBe(true);

  // Host drives and shoots; the guest's view must keep updating from server snapshots.
  await host.keyboard.down('KeyW');
  await host.keyboard.down('Space');
  await host.waitForTimeout(800);
  await host.keyboard.up('KeyW');
  await host.keyboard.up('Space');

  await expect(host.getByTestId('result-title')).toBeVisible({ timeout: 75_000 });
  await expect(guest.getByTestId('result-title')).toBeVisible();
  await expect(host.getByTestId('scoreboard')).toContainText('HostHen');
  await expect(host.getByTestId('scoreboard')).toContainText('GuestGus');
  await expect(guest.getByTestId('btn-rematch')).toBeDisabled(); // host-only
  await host.getByTestId('btn-to-lobby').click();
  await expect(host.getByTestId('lobby-code')).toBeVisible();
  await expect(guest.getByTestId('lobby-code')).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});

test('a dropped connection reconnects and resumes the same seat', async ({ page }) => {
  // Intercept the game socket so the test can kill it from the "network" side.
  const sockets: { close: (o?: { code?: number }) => Promise<void> }[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  await gotoMenu(page, 'Flaky');
  await page.getByTestId('btn-create').click();
  await page.getByTestId('btn-create-go').click();
  await expect(page.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await page.getByTestId('lobby-code').textContent()) as string;
  expect(sockets).toHaveLength(1);

  await sockets[0]?.close({ code: 1006 });

  await expect.poll(() => sockets.length, { timeout: 15_000 }).toBe(2); // the client really opened a new socket
  await expect(page.getByTestId('conn-status')).toHaveText('Online', { timeout: 15_000 });
  await expect(page.getByTestId('lobby-code')).toHaveText(code); // same room, same seat
  expect(await screenOf(page)).toBe('lobby');
});

test('@mobile touch controls are shown in a match', async ({ page }) => {
  await gotoMenu(page, 'Thumbs');
  await page.getByTestId('btn-practice').click();
  await page.getByTestId('btn-practice-go').click();
  await expect(page.getByTestId('touch-fire')).toBeVisible();
  await expect(page.getByTestId('touch-ability')).toBeVisible();
});

test('a solo player can add a bot from the lobby and start immediately', async ({ page }) => {
  await gotoMenu(page, 'Lonely');
  await page.getByTestId('btn-create').click();
  await page.getByTestId('btn-create-go').click();
  await expect(page.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await page.getByTestId('lobby-code').textContent()) as string;
  await expect(page.getByTestId('btn-whatsapp')).toHaveAttribute('href', new RegExp(`wa\\.me/.*${code}`));
  await expect(page.getByTestId('btn-start')).toBeDisabled();
  await page.getByTestId('btn-bot-2').click();
  await expect(page.locator('#list-2')).toContainText('(bot)');
  await expect(page.getByTestId('btn-start')).toBeEnabled();
  await page.getByTestId('btn-start').click();
  await expect(page.getByTestId('canvas')).toBeVisible();
  await expect(page.getByTestId('coach')).toBeVisible(); // first match shows control hints
  await waitForBattle(page);
  expect(await canvasHasContent(page)).toBe(true);
});

test('Play now offers bots when nobody else is searching', async ({ page }) => {
  await gotoMenu(page, 'Early');
  await page.getByTestId('btn-play').click();
  await expect(page.getByTestId('queue-info')).toContainText(/nobody else/i);
  await expect(page.getByTestId('btn-queue-bots')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('btn-queue-bots').click();
  await expect(page.getByTestId('canvas')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#hud-score-2')).toBeVisible();
});

test('a slow-to-wake server shows the wake-up screen with a way out', async ({ page }) => {
  // Accept the socket but never answer, like a free host that is still cold-starting.
  await page.routeWebSocket(/\/ws$/, () => undefined);
  await gotoMenu(page, 'Patient');
  await page.getByTestId('btn-create').click();
  await page.getByTestId('btn-create-go').click();
  await expect(page.getByTestId('overlay-wake')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('overlay-wake')).toContainText(/sleep/i);
  await page.getByRole('button', { name: 'Practice while waiting' }).click();
  await expect(page.getByTestId('btn-practice-go')).toBeVisible();
});

test('the app is installable: manifest, icons and service worker are served', async ({ request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const json = (await manifest.json()) as { icons: { src: string }[] };
  for (const icon of json.icons) expect((await request.get(icon.src)).ok()).toBe(true);
  expect((await request.get('/sw.js')).ok()).toBe(true);
});

// ------------------------------------------------------------------ real touch gameplay (phone emulation)

type Self = { x: number; y: number; a: number; alive: boolean } | null;
/** Total distance the tank travels while `action` runs (sampled every 50 ms), so back-and-forth counts. */
async function travelDuring(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __trail: { x: number; y: number }[];
      __trailTimer: number;
      __tankclash: { self: Self };
    };
    w.__trail = [];
    w.__trailTimer = window.setInterval(() => {
      const s = w.__tankclash.self;
      if (s?.alive) w.__trail.push({ x: s.x, y: s.y });
    }, 50);
  });
  await action();
  const trail = await page.evaluate(() => {
    const w = window as unknown as { __trail: { x: number; y: number }[]; __trailTimer: number };
    window.clearInterval(w.__trailTimer);
    return w.__trail;
  });
  let d = 0;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (step < 60) d += step; // ignore respawn teleports
  }
  return d;
}
const shotsOf = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __tankclash: { myShots: number } }).__tankclash.myShots);

/** Drives the on-screen joystick and FIRE button with real multi-touch events (two fingers at once). */
async function thumbs(page: Page, ms: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const zone = (await page.locator('#joy-zone').boundingBox())!;
  const fire = (await page.getByTestId('touch-fire').boundingBox())!;
  const sx = zone.x + zone.width * 0.4;
  const sy = zone.y + zone.height * 0.6;
  const stick = (dx: number, dy: number) => ({ x: sx + dx, y: sy + dy, id: 1 });
  const fireTouch = { x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [stick(0, 0)] });
  // Push the stick in a few directions: some route always leads out of the spawn corner.
  const dirs: [number, number][] = [
    [50, 0],
    [0, -50],
    [0, 50],
    [-50, 0],
  ];
  let firstMove = true;
  for (const [dx, dy] of dirs) {
    for (let i = 1; i <= 5; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: firstMove
          ? [stick((dx * i) / 5, (dy * i) / 5)]
          : [stick((dx * i) / 5, (dy * i) / 5), fireTouch],
      });
      await page.waitForTimeout(16);
    }
    if (firstMove) {
      // Second finger on FIRE while the first keeps steering.
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [stick(dx, dy), fireTouch],
      });
      firstMove = false;
    }
    await page.waitForTimeout(ms / dirs.length);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('@mobile practice on a phone in landscape: joystick drives, FIRE shoots, both at once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await gotoMenu(page, 'Thumbs');
  await page.getByTestId('btn-practice').click();
  await page.getByTestId('practice-diff').selectOption('easy');
  await page.getByTestId('btn-practice-go').click();
  await expect(page.getByTestId('touch-fire')).toBeVisible();
  await waitForBattle(page);
  const moved = await travelDuring(page, () => thumbs(page, 2400));
  // Assault drives 150 px/s; even with turning and wall bumps, 2.4 s of stick should cover well over 100 px.
  expect(moved, `tank travelled ${moved.toFixed(0)} px`).toBeGreaterThan(100);
  expect(await shotsOf(page)).toBeGreaterThan(2);
});

test('@mobile online match from a phone: touch input reaches the server', async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await gotoMenu(page, 'PhoneHost');
  await page.getByTestId('btn-create').click();
  await page.getByTestId('btn-create-go').click();
  await expect(page.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  await page.getByTestId('btn-bot-2').click();
  await expect(page.getByTestId('btn-start')).toBeEnabled();
  await page.getByTestId('btn-start').click();
  await expect(page.getByTestId('touch-fire')).toBeVisible();
  await waitForBattle(page);
  // self() is the server's snapshot, so this proves the server applied the touch input.
  const moved = await travelDuring(page, async () => {
    await thumbs(page, 2400);
    await page.waitForTimeout(300); // let the last snapshots arrive
  });
  expect(moved, `server moved tank ${moved.toFixed(0)} px`).toBeGreaterThan(100);
  expect(await shotsOf(page)).toBeGreaterThan(2);
});

test('@mobile portrait phone gets a rotate prompt that can be dismissed', async ({ page }) => {
  await gotoMenu(page, 'Upright');
  await page.getByTestId('btn-practice').click();
  await page.getByTestId('btn-practice-go').click();
  const prompt = page.locator('#overlay-portrait');
  await expect(prompt).toBeVisible();
  await page.locator('#btn-portrait-dismiss').click();
  await expect(prompt).toBeHidden();
  await expect(page.getByTestId('touch-fire')).toBeVisible();
});

test('online inputs carry the server tick on screen, a plausible distance behind the server (lag compensation)', async ({
  page,
}) => {
  const lags: number[] = [];
  let lastSnapTick = 0;
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const m = /^\{"t":"snap","ack":\d+,"s":\{"tick":(\d+)/.exec(String(f.payload));
      if (m) lastSnapTick = Number(m[1]);
    });
    ws.on('framesent', (f) => {
      const text = String(f.payload);
      if (!text.startsWith('{"t":"input"')) return;
      const msg = JSON.parse(text) as { vt?: number };
      if (typeof msg.vt === 'number' && lastSnapTick > 0) lags.push(lastSnapTick - msg.vt);
    });
  });
  await gotoMenu(page, 'Aimer');
  await page.getByTestId('btn-create').click();
  await page.getByTestId('btn-create-go').click();
  await expect(page.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  await page.getByTestId('btn-bot-2').click();
  await page.getByTestId('btn-start').click();
  await waitForBattle(page);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Space');
  expect(lags.length).toBeGreaterThan(10);
  lags.sort((x, y) => x - y);
  const median = lags[Math.floor(lags.length / 2)]!;
  // On localhost the screen shows the world ~2 snapshot intervals (4 ticks at 30 Hz) behind the newest snapshot.
  expect(median, `median view lag ${median} ticks`).toBeGreaterThanOrEqual(1);
  expect(median, `median view lag ${median} ticks`).toBeLessThanOrEqual(12);
});

test('drop-in: a friend opening the invite link mid-match lands in the battle on the smaller squad', async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const lateCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const late = await lateCtx.newPage();
  await gotoMenu(host, 'HostHen');
  await host.getByTestId('btn-create').click();
  await host.getByTestId('btn-create-go').click();
  await expect(host.getByTestId('lobby-code')).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await host.getByTestId('lobby-code').textContent()) as string;
  await host.getByTestId('btn-bot-2').click();
  await host.getByTestId('btn-start').click();
  await expect(host.getByTestId('canvas')).toBeVisible(); // match screen up...
  await waitForBattle(host);
  await expect(host.locator('#killfeed')).toContainText("You're on ▲ Alpha");

  await late.addInitScript(() =>
    localStorage.setItem('tankclash.settings.v1', JSON.stringify({ name: 'LateLiam' })),
  );
  await late.goto(`/join/${code}`);
  await late.getByTestId('btn-join-go').click();
  await expect(late.getByTestId('canvas')).toBeVisible();
  await expect(late.locator('#killfeed')).toContainText(/You joined (▲ Alpha|■ Bravo) — the match is on!/);
  // Host: 1 human on Alpha vs 1 bot on Bravo, so the newcomer is balanced onto Bravo and the host is told.
  await expect(late.locator('#killfeed')).toContainText('■ Bravo');
  await expect(host.locator('#killfeed')).toContainText('LateLiam joined ■ Bravo');
  expect(await canvasHasContent(late)).toBe(true);

  await hostCtx.close();
  await lateCtx.close();
});

test('the page asks browsers not to offer translation (no popups over the touch controls)', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('meta[name="google"]')).toHaveAttribute('content', 'notranslate');
  await expect(page.locator('html')).toHaveAttribute('translate', 'no');
});

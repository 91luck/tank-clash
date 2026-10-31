/**
 * Run the browser test suite (desktop + phone emulation) against a game that is already running:
 *
 *   npm run test:url -- https://tank-clash.you.workers.dev      (your deployment)
 *   npm run test:url -- http://192.168.1.5:8080                 (`npm run phone` on your Wi-Fi)
 *
 * Needs Chromium once: `npx playwright install chromium`. Creates a few short-lived rooms on that server.
 */
import { spawnSync } from 'node:child_process';

const url = process.argv[2];
if (!url || !/^https?:\/\/[^\s/]+/.test(url)) {
  console.error('Usage: npm run test:url -- https://your-game.example');
  process.exit(1);
}
const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test', ...process.argv.slice(3)],
  {
    stdio: 'inherit',
    env: { ...process.env, E2E_BASE_URL: url },
    shell: process.platform === 'win32',
  },
);
process.exit(r.status ?? 1);

import { defineConfig, devices } from '@playwright/test';

/**
 * E2E_TARGET=node (default)  -> the Node server serving the built client (Render / Docker / VPS deployments)
 * E2E_TARGET=cloudflare      -> `wrangler dev`: the Cloudflare Worker + Durable Object running in local workerd
 * E2E_BASE_URL=https://…     -> an already-running game (your deployment, or `npm run phone` on the LAN).
 *                               Nothing is started; tests needing a sped-up clock (@fastclock) are skipped.
 * All targets run the identical test suite, so each deployment path is exercised in a real browser.
 */
const remote = process.env.E2E_BASE_URL?.replace(/\/+$/, '');
const target = remote ? 'remote' : process.env.E2E_TARGET === 'cloudflare' ? 'cloudflare' : 'node';
const PORT = target === 'cloudflare' ? 8787 : 4173;

// TIME_SCALE speeds the match clock up so a full match finishes in seconds; servers refuse it in production.
const webServer = remote
  ? undefined
  : target === 'cloudflare'
    ? {
        command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --var NODE_ENV:development --var TIME_SCALE:4 --var QUICK_MATCH_WAIT_MS:1500 --var LOG_LEVEL:warn`,
        url: `http://127.0.0.1:${PORT}/health`,
        reuseExistingServer: false,
        timeout: 180_000,
      }
    : {
        command: 'npm run build && NODE_ENV=development node server/dist/index.js',
        url: `http://127.0.0.1:${PORT}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          PORT: String(PORT),
          HOST: '127.0.0.1',
          CLIENT_DIR: 'client/dist',
          TIME_SCALE: '4',
          QUICK_MATCH_WAIT_MS: '1500',
          LOG_LEVEL: 'warn',
        },
      };

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: `test-results/${target}`,
  use: {
    baseURL: remote ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: remote ? /@mobile|@fastclock/ : /@mobile/,
    },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' }, grep: /@mobile/ },
  ],
  webServer,
});

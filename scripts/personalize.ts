/**
 * Fills your GitHub repo into the README's "Deploy to Cloudflare / Render" buttons.
 * Usage (after `git remote add origin https://github.com/<you>/<repo>.git`):  npm run personalize
 * Safe to run again: it rewrites whatever repo the buttons currently point at.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function originUrl(): string {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const url = process.argv[2] ?? originUrl();
const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
if (!m) {
  console.error(
    'Could not find a GitHub repo. Add one first:\n  git remote add origin https://github.com/<you>/tank-clash.git\nor pass it: npm run personalize -- https://github.com/<you>/<repo>',
  );
  process.exit(1);
}
const repo = `https://github.com/${m[1]}/${m[2]}`;
const before = readFileSync('README.md', 'utf8');
const after = before.replace(
  /(deploy\.workers\.cloudflare\.com\/\?url=|render\.com\/deploy\?repo=)https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+/g,
  `$1${repo}`,
);
if (after === before) {
  console.log(`README buttons already point at ${repo}.`);
} else {
  writeFileSync('README.md', after);
  console.log(`README deploy buttons now point at ${repo}. Commit and push to see them on GitHub.`);
}

/**
 * Put this project on YOUR GitHub and get one-click deploy links, with one command:
 *
 *   npm run publish:github                 (creates public repo "tank-clash")
 *   npm run publish:github -- my-tanks     (different repo name)
 *
 * Uses the official GitHub CLI (`gh`). If you are not logged in it opens the browser login once.
 * Safe to run again: an existing "origin" remote is reused and only new commits are pushed.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// git and gh are real executables on every OS, so no shell is needed (and none is used: a shell would split
// arguments that contain spaces, such as commit messages, on Windows).
const run = (cmd: string, args: string[], inherit = false): SpawnSyncReturns<string> =>
  spawnSync(cmd, args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
const ok = (r: SpawnSyncReturns<string>): boolean => r.status === 0;
const fail = (msg: string): never => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const name = process.argv[2] ?? 'tank-clash';
if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) fail(`"${name}" is not a valid GitHub repository name.`);

// 1. Tools
if (!ok(run('git', ['--version']))) fail('git is not installed. Get it from https://git-scm.com/downloads');
if (!ok(run('gh', ['--version']))) {
  fail(
    [
      'GitHub CLI (gh) is not installed. Install it, then run this command again:',
      '  Windows:  winget install --id GitHub.cli',
      '  macOS:    brew install gh',
      '  Linux:    https://github.com/cli/cli#installation',
      '(Or push by hand: see docs/PUBLISH_AND_DEPLOY_HINGLISH.md, "Bina gh ke".)',
    ].join('\n'),
  );
}
if (!ok(run('git', ['rev-parse', '--is-inside-work-tree']))) fail('Run this inside the tank-clash folder.');

// 2. Login (opens the browser once)
if (!ok(run('gh', ['auth', 'status']))) {
  console.log('Logging in to GitHub (a browser window/code will appear)…');
  if (!ok(run('gh', ['auth', 'login', '--web', '--git-protocol', 'https'], true)))
    fail('GitHub login did not finish.');
}
run('gh', ['auth', 'setup-git']); // lets plain `git push` use the gh login
const login = run('gh', ['api', 'user', '--jq', '.login']).stdout.trim();
if (!login) fail('Could not read your GitHub username after login.');

// Commits are public on GitHub. Publish them with the account's private noreply address, never a real email.
const id = run('gh', ['api', 'user', '--jq', '.id']).stdout.trim();
const noreply = `${id}+${login}@users.noreply.github.com`;
const displayName = run('gh', ['api', 'user', '--jq', '.name // .login']).stdout.trim() || login;
const firstPublish = !run('git', ['config', '--get', 'remote.origin.url']).stdout.trim();
if (firstPublish) {
  run('git', ['config', 'user.name', displayName]); // this repo only; your global git settings are untouched
  run('git', ['config', 'user.email', noreply]);
}

// 3. Commit anything uncommitted (e.g. local edits), so the push contains the current state
if (run('git', ['status', '--porcelain']).stdout.trim()) {
  run('git', ['add', '-A']);
  run('git', ['commit', '-m', 'Update game'], true);
}

if (firstPublish) {
  const emails = [...new Set(run('git', ['log', '--format=%ae%n%ce']).stdout.split('\n').filter(Boolean))];
  const exposed = emails.filter((e) => !e.endsWith('@users.noreply.github.com'));
  if (exposed.length > 0) {
    console.log(`Rewriting local commits to use ${noreply} instead of: ${exposed.join(', ')}`);
    const r = spawnSync(
      'git',
      ['rebase', '--root', '--exec', 'git commit --amend --no-edit --reset-author --allow-empty'],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: displayName,
          GIT_AUTHOR_EMAIL: noreply,
          GIT_COMMITTER_NAME: displayName,
          GIT_COMMITTER_EMAIL: noreply,
        },
      },
    );
    if (r.status !== 0) {
      run('git', ['rebase', '--abort']);
      fail(`Could not rewrite commit emails:\n${r.stderr}`);
    }
  }
}

// 4. Create the repo (or reuse origin) and push
const origin = run('git', ['config', '--get', 'remote.origin.url']).stdout.trim();
if (!origin) {
  console.log(`Creating public repo github.com/${login}/${name} and pushing…`);
  const r = run('gh', ['repo', 'create', name, '--public', '--source=.', '--remote=origin', '--push'], true);
  if (!ok(r))
    fail(
      `Could not create github.com/${login}/${name}. If it already exists, add it as origin:\n  git remote add origin https://github.com/${login}/${name}.git\nthen run this again.`,
    );
} else {
  console.log(`Using existing remote: ${origin}`);
}
const remote = run('git', ['config', '--get', 'remote.origin.url']).stdout.trim();
const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
if (!m) fail(`origin (${remote}) is not a GitHub repository.`);
const repoUrl = `https://github.com/${m![1]}/${m![2]}`;

// 5. Point the README deploy buttons at this repo, then push
run(process.execPath, ['--import', 'tsx', 'scripts/personalize.ts', repoUrl], true);
if (run('git', ['status', '--porcelain', 'README.md']).stdout.trim()) {
  run('git', ['commit', '-m', 'Point deploy buttons at this repo', 'README.md'], true);
}
const branch = run('git', ['branch', '--show-current']).stdout.trim() || 'main';
if (!ok(run('git', ['push', '-u', 'origin', branch], true))) fail('git push failed (see the message above).');

console.log(`
✔ Code is on GitHub: ${repoUrl}

Next: make it live for free (pick one, log in with GitHub when asked):

  Cloudflare (recommended, never sleeps):
    https://deploy.workers.cloudflare.com/?url=${repoUrl}

  Render (simplest, sleeps after 15 min idle):
    https://render.com/deploy?repo=${repoUrl}

When it's live, send the URL to your friends on WhatsApp. Check it any time with:
    npm run test:url -- https://your-live-url
`);

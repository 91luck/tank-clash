/**
 * Play on your phone over home Wi-Fi, with one command:
 *
 *   npm run phone            (builds the game, starts it on port 8080, prints a link + QR code)
 *   npm run phone -- --port 9000 --no-build
 *
 * Phone and computer must be on the same Wi-Fi. Scan the QR code with the phone camera (or type the link).
 * Friends on the same Wi-Fi can join too. To play with friends anywhere, deploy instead (docs/DEPLOYMENT.md).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import qrcode from 'qrcode-terminal';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : def;
};

const port = Number(option('port', process.env.PORT ?? '8080'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port "${option('port', '')}".`);
  process.exit(1);
}

/** LAN IPv4 addresses, private ranges first (that's what a phone on the same Wi-Fi can reach). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push(a.address);
    }
  }
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return [...out.filter(isPrivate), ...out.filter((ip) => !isPrivate(ip))];
}

if (!flag('no-build') || !existsSync('server/dist/index.js') || !existsSync('client/dist/index.html')) {
  console.log('Building the game (takes a few seconds)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['run', 'build'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error('Build failed. Run `npm install` first, then try again.');
    process.exit(r.status ?? 1);
  }
}

// Production mode: the server only accepts WebSockets from the page it serves itself (same origin).
const server = spawn(process.execPath, ['server/dist/index.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: String(port),
    CLIENT_DIR: 'client/dist',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitForHealth(): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

void waitForHealth().then((ok) => {
  if (!ok) {
    console.error(
      `The game server did not start on port ${port}. Is something else using it? Try --port 9000.`,
    );
    server.kill();
    process.exit(1);
  }
  const ips = lanAddresses();
  console.log('\n  TANK CLASH is running.\n');
  console.log(`  On this computer:  http://localhost:${port}`);
  if (ips.length === 0) {
    console.log('\n  No Wi-Fi/LAN address found. Connect this computer to the same Wi-Fi as your phone.\n');
    return;
  }
  const main = `http://${ips[0]}:${port}`;
  console.log(`  On your phone:     ${main}`);
  for (const ip of ips.slice(1)) console.log(`                     http://${ip}:${port}`);
  console.log('\n  Scan with the phone camera (phone must be on the same Wi-Fi):\n');
  qrcode.generate(main, { small: true }, (q: string) => {
    console.log(q.replace(/^/gm, '  '));
    console.log(
      '  Not opening on the phone? Allow Node.js through the firewall (Windows asks the first time),',
    );
    console.log('  and make sure the Wi-Fi is not a "guest"/isolated network.  Stop with Ctrl+C.\n');
  });
});

const stop = (): void => {
  server.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));

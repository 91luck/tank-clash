import { ConfigError, loadConfig } from './config';
import { GameServer } from './game-server';
import { createLogger } from './logger';

function main(): void {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\nSee .env.example and docs/DEPLOYMENT.md.\n`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(cfg.logLevel);
  const server = new GameServer(cfg, log);

  server.start().catch((err: unknown) => {
    log.error('failed to start', { err: String(err) });
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    server
      .stop()
      .catch((err: unknown) => log.error('shutdown error', { err: String(err) }))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));
}

main();

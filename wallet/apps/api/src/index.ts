import { loadApiConfigOrExit } from '@wallet/config';
import { createLogger } from '@wallet/logger';
import { buildServer } from './server.js';

/**
 * Configuration is validated before anything else happens — before a port is
 * bound, before a connection is opened (prompt_phase1.md rules 58-61). A
 * missing variable stops the process here with the variable named, rather than
 * surfacing as a confusing failure inside the first request that needs it.
 */
const config = loadApiConfigOrExit();
const logger = createLogger({ level: config.shared.logLevel });

async function main(): Promise<void> {
  const app = await buildServer({ config, logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { reason: signal });
    try {
      await app.close();
      await app.shutdown();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await app.listen({ port: config.http.port, host: config.http.host });
  logger.info('api listening', { status: `${config.http.host}:${config.http.port}` });
}

main().catch((error: unknown) => {
  logger.fatal('failed to start', {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  // The message itself may carry a connection string, so it goes to stderr for
  // a human at the console rather than into the structured log stream.
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

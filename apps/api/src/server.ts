import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createLogger } from './lib/log.js';
import { loadTacDirectory } from './lib/tac.js';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });

const tacDirectory = loadTacDirectory(config.TAC_SOURCE_FILE);
logger.info(
  { entries: tacDirectory.size, version: tacDirectory.version },
  'TAC directory loaded',
);

const app = await buildApp({ logger, tacDirectory });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.PORT, host: config.HOST });

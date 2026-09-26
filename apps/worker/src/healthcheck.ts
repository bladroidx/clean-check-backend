// Container healthcheck for the worker: exit 0 while poll ticks keep succeeding (see heartbeat.ts).
import { isAlive } from './heartbeat.js';

process.exit(isAlive() ? 0 : 1);

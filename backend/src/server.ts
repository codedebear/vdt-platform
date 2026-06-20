/**
 * Express application entry point for the VDT Platform backend.
 */
import { app } from './app';
import { env } from './config/env';
import { startBatchPoller, stopBatchPoller } from './services/batchPoller.service';

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`VDT Platform backend listening on port ${env.port} (${env.nodeEnv})`);
  // Start the Batch-API poller only on the real server (not under supertest,
  // which imports ./app directly) so tests never spawn a timer.
  startBatchPoller();
});

// Stop the poller cleanly on shutdown so the interval does not outlive the app.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopBatchPoller();
    process.exit(0);
  });
}

/**
 * Express application entry point for the VDT Platform backend.
 */
import { app } from './app';
import { env } from './config/env';

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`VDT Platform backend listening on port ${env.port} (${env.nodeEnv})`);
});

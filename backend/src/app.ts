/**
 * Builds the Express application (middleware + routes) without starting an
 * HTTP listener. Kept separate from server.ts so it can be imported directly
 * in tests (via supertest) without binding to a real port.
 */
import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter } from './routes/auth.routes';
import { healthRouter } from './routes/health.routes';
import { projectRouter } from './routes/project.routes';
import { phaseRouter } from './routes/phase.routes';
import { userRouter } from './routes/user.routes';
import { errorHandler } from './middleware/errorHandler';

/**
 * Creates and configures a new Express application instance.
 */
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/phases', phaseRouter);
  app.use('/api/users', userRouter);

  app.use(errorHandler);

  return app;
}

export const app = createApp();

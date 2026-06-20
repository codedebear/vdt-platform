/**
 * Public runtime configuration the frontend reads (e.g. attachment limits and
 * accepted file types) so those values are not duplicated client-side.
 */
import { Router } from 'express';
import { getConfig } from '../controllers/config.controller';

export const configRouter = Router();

configRouter.get('/', getConfig);

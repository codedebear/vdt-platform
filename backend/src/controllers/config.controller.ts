/**
 * Exposes the server's effective, client-relevant configuration so the
 * frontend consumes authoritative values instead of duplicating them.
 *
 * Currently just attachment limits + accepted file extensions, sourced from the
 * env config and the attachments domain — the single source of truth the upload
 * pipeline itself enforces.
 */
import { Request, Response } from 'express';
import { env } from '../config/env';
import { ACCEPTED_EXTENSIONS } from '../domain/attachments';

/** GET /api/config — public, non-sensitive runtime config for clients. */
export function getConfig(_req: Request, res: Response): void {
  res.status(200).json({
    attachments: {
      maxFileMb: env.attachmentMaxFileMb,
      maxPerRun: env.attachmentMaxPerRun,
      maxTotalMb: env.attachmentMaxTotalMb,
      acceptedExtensions: ACCEPTED_EXTENSIONS,
    },
  });
}

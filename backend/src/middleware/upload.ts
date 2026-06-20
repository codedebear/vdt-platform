/**
 * Multipart upload middleware for phase-run attachments.
 *
 * Buffers files in memory (they are persisted to Postgres as bytea by the
 * service, not to disk) and enforces the per-file size limit and accepted types
 * up front. The authoritative per-run count/total-size checks live in the
 * service layer via the pure attachments domain.
 */
import multer from 'multer';
import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError } from './errorHandler';
import { isAcceptedAttachment } from '../domain/attachments';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.attachmentMaxFileMb * 1024 * 1024,
    files: env.attachmentMaxPerRun,
  },
  fileFilter: (_req, file, cb) => {
    if (isAcceptedAttachment(file.originalname, file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(`Unsupported file type: ${file.originalname}`, 415));
    }
  },
});

const multipartFields = upload.array('files', env.attachmentMaxPerRun);

/**
 * Runs the multipart parser and translates multer's own errors into AppErrors
 * with sensible status codes so they flow through the central error handler.
 */
export function attachmentUpload(req: Request, res: Response, next: NextFunction): void {
  multipartFields(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(`Each file must be at most ${env.attachmentMaxFileMb} MB`, 413));
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        next(new AppError(`A run may have at most ${env.attachmentMaxPerRun} attachments`, 409));
        return;
      }
      next(new AppError(err.message, 400));
      return;
    }
    // fileFilter rejections arrive here already as AppErrors.
    next(err);
  });
}

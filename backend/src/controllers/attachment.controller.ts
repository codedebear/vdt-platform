/**
 * HTTP handlers for phase-run attachments, mounted under
 * /api/phases/:executionId/attachments. All routes require authentication; the
 * upload route is additionally parsed by the multipart middleware.
 */
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import * as attachmentService from '../services/attachment.service';

/** POST /api/phases/:executionId/attachments — upload one or more files. */
export async function uploadAttachments(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      throw new AppError('No files were provided (field name must be "files")', 400);
    }
    const created = await attachmentService.addAttachments(
      req.params.executionId,
      files.map((f) => ({
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        buffer: f.buffer,
      })),
      { id: req.user.id, role: req.user.role },
    );
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
}

/** GET /api/phases/:executionId/attachments — list attachment metadata. */
export async function listAttachments(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const items = await attachmentService.listAttachments(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json(items);
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/phases/:executionId/attachments/:attachmentId — remove one. */
export async function deleteAttachment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    await attachmentService.deleteAttachment(
      req.params.executionId,
      req.params.attachmentId,
      { id: req.user.id, role: req.user.role },
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

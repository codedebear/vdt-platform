/**
 * Business logic for phase-run attachments: uploading, listing, and deleting
 * the documents the AI reads as extra context when generating a phase.
 *
 * Authorization (who may attach) reuses the PHASE_SUBMIT rule — the same worker
 * role that produces a phase's output — and the workflow rule that context may
 * only change while the run is still open (IN_PROGRESS or CHANGES_REQUESTED).
 * Size/type/count limits are delegated to the pure ../domain/attachments engine.
 * File bytes are never returned by these read paths — only metadata.
 */
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { can, Role } from '../domain/permissions';
import { PhaseType } from '../domain/workflow';
import {
  checkAttachmentLimits,
  classifyAttachment,
  type AttachmentLimits,
} from '../domain/attachments';

/** The authenticated user performing an action. */
export interface Actor {
  id: string;
  role: Role;
}

/** A buffered uploaded file (as produced by multer's memory storage). */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Public metadata for an attachment — never includes the file bytes. */
export interface AttachmentMeta {
  id: string;
  executionId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

const META_SELECT = {
  id: true,
  executionId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} as const;

const limits: AttachmentLimits = {
  maxFileBytes: env.attachmentMaxFileMb * 1024 * 1024,
  maxPerRun: env.attachmentMaxPerRun,
  maxTotalBytes: env.attachmentMaxTotalMb * 1024 * 1024,
};

/** Statuses during which a run's attachments may be changed. */
function assertRunIsOpen(status: string): void {
  if (status !== 'IN_PROGRESS' && status !== 'CHANGES_REQUESTED') {
    throw new AppError(
      `Attachments can only be changed while a run is IN_PROGRESS or CHANGES_REQUESTED (current: ${status})`,
      409,
    );
  }
}

/**
 * Adds one or more files to a phase run. Validates authorization, run status,
 * accepted types, and the per-file / per-run size and count limits, then stores
 * the bytes inline. Returns metadata for every attachment on the run (newest
 * upload included), never the bytes.
 * @throws {AppError} 404 missing run, 403 wrong role, 409 closed run / count,
 *   413 size, 415 unsupported type, 400 no files.
 */
export async function addAttachments(
  executionId: string,
  files: UploadedFile[],
  actor: Actor,
): Promise<AttachmentMeta[]> {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    select: { id: true, phaseType: true, status: true },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }

  if (!can(actor.role, 'PHASE_SUBMIT', { phaseType: execution.phaseType as PhaseType })) {
    throw new AppError(
      `Your role is not allowed to add attachments to a ${execution.phaseType} phase`,
      403,
    );
  }

  assertRunIsOpen(execution.status);

  // Re-check accepted types authoritatively (the upload filter is the first gate).
  for (const file of files) {
    if (!classifyAttachment(file.originalname, file.mimetype)) {
      throw new AppError(`Unsupported file type: ${file.originalname}`, 415);
    }
  }

  const agg = await prisma.attachment.aggregate({
    where: { executionId },
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
  const existing = {
    count: agg._count._all,
    totalBytes: agg._sum.sizeBytes ?? 0,
  };

  const decision = checkAttachmentLimits(
    existing,
    files.map((f) => ({ sizeBytes: f.size })),
    limits,
  );
  if (!decision.allowed) {
    throw new AppError(decision.reason ?? 'Attachment limits exceeded', decision.status ?? 409);
  }

  await prisma.attachment.createMany({
    data: files.map((f) => ({
      executionId,
      filename: f.originalname,
      mimeType: f.mimetype,
      sizeBytes: f.size,
      data: f.buffer,
    })),
  });

  return listAttachments(executionId, actor);
}

/**
 * Lists a run's attachments (metadata only, oldest first).
 * @throws {AppError} 404 if the run does not exist.
 */
export async function listAttachments(
  executionId: string,
  _actor: Actor,
): Promise<AttachmentMeta[]> {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    select: { id: true },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }

  return prisma.attachment.findMany({
    where: { executionId },
    select: META_SELECT,
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Removes one attachment from a run. Only the phase's worker role may delete,
 * and only while the run is still open.
 * @throws {AppError} 404 missing run/attachment, 403 wrong role, 409 closed run.
 */
export async function deleteAttachment(
  executionId: string,
  attachmentId: string,
  actor: Actor,
): Promise<void> {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    select: { phaseType: true, status: true },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }

  if (!can(actor.role, 'PHASE_SUBMIT', { phaseType: execution.phaseType as PhaseType })) {
    throw new AppError(
      `Your role is not allowed to modify attachments on a ${execution.phaseType} phase`,
      403,
    );
  }

  assertRunIsOpen(execution.status);

  const result = await prisma.attachment.deleteMany({
    where: { id: attachmentId, executionId },
  });
  if (result.count === 0) {
    throw new AppError('Attachment not found', 404);
  }
}

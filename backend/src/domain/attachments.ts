/**
 * Pure logic for phase-run attachments: which file types are accepted and
 * whether a set of incoming files fits within the per-file / per-run limits.
 *
 * Like the other domain modules this has no database or HTTP dependency, so it
 * is the single, unit-testable source of truth for attachment validation and is
 * reused by both the upload middleware (early reject) and the service layer
 * (authoritative re-check).
 */

/** Coarse category of an accepted attachment, used later to decide how the AI
 * consumes it (PDFs go to Claude as document blocks; the rest are extracted to
 * text). */
export type AttachmentKind = 'pdf' | 'spreadsheet' | 'document' | 'text';

interface TypeRule {
  kind: AttachmentKind;
  extensions: string[];
  mimeTypes: string[];
}

/**
 * The accepted file types. Extension is matched first because browser-reported
 * MIME types are unreliable (e.g. `.md` often arrives as `application/octet-stream`,
 * `.csv` as `application/vnd.ms-excel`); MIME is used only as a fallback.
 */
const TYPE_RULES: TypeRule[] = [
  { kind: 'pdf', extensions: ['.pdf'], mimeTypes: ['application/pdf'] },
  {
    kind: 'spreadsheet',
    extensions: ['.xlsx', '.xls'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ],
  },
  {
    kind: 'document',
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  {
    kind: 'text',
    extensions: ['.txt', '.csv', '.md', '.markdown'],
    mimeTypes: ['text/plain', 'text/csv', 'text/markdown'],
  },
];

/**
 * Every accepted file extension, flattened from {@link TYPE_RULES}. This is the
 * single source of truth the API exposes to clients (via the config endpoint)
 * so the frontend never has to hard-code the list.
 */
export const ACCEPTED_EXTENSIONS: string[] = TYPE_RULES.flatMap((r) => r.extensions);

/** Lower-cased file extension including the dot, or '' when there is none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot).toLowerCase();
}

/**
 * Classifies a file by name + MIME into an {@link AttachmentKind}, or `null`
 * when the type is not accepted. Extension takes precedence over MIME.
 */
export function classifyAttachment(filename: string, mimeType: string): AttachmentKind | null {
  const ext = fileExtension(filename);
  if (ext) {
    const byExt = TYPE_RULES.find((r) => r.extensions.includes(ext));
    if (byExt) return byExt.kind;
  }
  const byMime = TYPE_RULES.find((r) => r.mimeTypes.includes(mimeType));
  return byMime ? byMime.kind : null;
}

/** Whether the file is an accepted attachment type. */
export function isAcceptedAttachment(filename: string, mimeType: string): boolean {
  return classifyAttachment(filename, mimeType) !== null;
}

/** Limits, in bytes/count, against which an upload is validated. */
export interface AttachmentLimits {
  maxFileBytes: number;
  maxPerRun: number;
  maxTotalBytes: number;
}

/** What the run already holds, used to enforce per-run caps. */
export interface ExistingAttachments {
  count: number;
  totalBytes: number;
}

/** A candidate file being uploaded (only the size matters for limit checks). */
export interface IncomingFile {
  sizeBytes: number;
}

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
  /** Suggested HTTP status for the failure (413 for size, 409 for count). */
  status?: number;
}

/**
 * Decides whether `incoming` files may be added to a run that already has
 * `existing` attachments, given `limits`. Enforces per-file size, total run
 * size, and file count.
 */
export function checkAttachmentLimits(
  existing: ExistingAttachments,
  incoming: IncomingFile[],
  limits: AttachmentLimits,
): LimitDecision {
  if (incoming.length === 0) {
    return { allowed: false, reason: 'No files were provided', status: 400 };
  }

  const oversized = incoming.find((f) => f.sizeBytes > limits.maxFileBytes);
  if (oversized) {
    return {
      allowed: false,
      status: 413,
      reason: `Each file must be at most ${bytesToMb(limits.maxFileBytes)} MB`,
    };
  }

  if (existing.count + incoming.length > limits.maxPerRun) {
    return {
      allowed: false,
      status: 409,
      reason: `A run may have at most ${limits.maxPerRun} attachments`,
    };
  }

  const incomingTotal = incoming.reduce((sum, f) => sum + f.sizeBytes, 0);
  if (existing.totalBytes + incomingTotal > limits.maxTotalBytes) {
    return {
      allowed: false,
      status: 413,
      reason: `Total attachments for a run may not exceed ${bytesToMb(limits.maxTotalBytes)} MB`,
    };
  }

  return { allowed: true };
}

/** Rounds a byte count to whole MB for human-readable messages. */
function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

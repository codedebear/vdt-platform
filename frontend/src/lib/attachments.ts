/**
 * Client-side attachment helpers: accepted types, human-readable sizes, and a
 * pre-upload validation that mirrors the backend's limits.
 *
 * NOTE: the backend (`domain/attachments.ts` + the `ATTACHMENT_*` env caps) is
 * the authoritative gate — these constants mirror its DEFAULT values purely for
 * a fast, friendly UX (block obviously-bad files before a round-trip). If the
 * server is configured with different caps, its error message is surfaced
 * verbatim. This mirror is the known FE/BE drift trade-off already tracked for
 * permissions.ts / workflow.ts; revisit if caps become configurable per env.
 */

/** Default per-file cap (mirrors ATTACHMENT_MAX_FILE_MB). */
export const ATTACHMENT_MAX_FILE_MB = 10;
/** Default per-run file count cap (mirrors ATTACHMENT_MAX_PER_RUN). */
export const ATTACHMENT_MAX_PER_RUN = 5;
/** Default per-run total size cap (mirrors ATTACHMENT_MAX_TOTAL_MB). */
export const ATTACHMENT_MAX_TOTAL_MB = 25;

/** Accepted file extensions (mirrors the backend TYPE_RULES). */
export const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.docx',
  '.txt',
  '.csv',
  '.md',
  '.markdown',
] as const;

/** Value for an <input type="file"> `accept` attribute. */
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',');

const MB = 1024 * 1024;

/** Lower-cased extension including the dot, or '' when there is none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot).toLowerCase();
}

/** Whether a file name has an accepted extension. */
export function isAcceptedFilename(filename: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(fileExtension(filename));
}

/** Format a byte count as a compact human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/**
 * Validates a set of incoming files against what a run already holds. Returns
 * the first human-readable error, or `null` when the batch is acceptable.
 * Mirrors the backend's per-file size, file count, and total size checks.
 */
export function validateNewFiles(
  incoming: File[],
  existing: { count: number; totalBytes: number },
): string | null {
  if (incoming.length === 0) return null;

  const bad = incoming.find((f) => !isAcceptedFilename(f.name));
  if (bad) {
    return `Unsupported file type: ${bad.name}. Allowed: ${ACCEPTED_EXTENSIONS.join(', ')}`;
  }

  const oversized = incoming.find((f) => f.size > ATTACHMENT_MAX_FILE_MB * MB);
  if (oversized) {
    return `"${oversized.name}" is too large — each file must be at most ${ATTACHMENT_MAX_FILE_MB} MB.`;
  }

  if (existing.count + incoming.length > ATTACHMENT_MAX_PER_RUN) {
    return `A run may have at most ${ATTACHMENT_MAX_PER_RUN} attachments.`;
  }

  const incomingTotal = incoming.reduce((sum, f) => sum + f.size, 0);
  if (existing.totalBytes + incomingTotal > ATTACHMENT_MAX_TOTAL_MB * MB) {
    return `Total attachments for a run may not exceed ${ATTACHMENT_MAX_TOTAL_MB} MB.`;
  }

  return null;
}

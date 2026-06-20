/**
 * Client-side attachment helpers: human-readable sizes, the file-picker accept
 * attribute, and a pre-upload validation — all driven by the server's
 * AttachmentConfig (see lib/config.ts) so the limits and accepted types are
 * never hard-coded here. The backend remains the authoritative gate; this is a
 * fast, friendly pre-check, and any server error is still surfaced verbatim.
 */
import type { AttachmentConfig } from './types';

const MB = 1024 * 1024;

/** Lower-cased extension including the dot, or '' when there is none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot).toLowerCase();
}

/** Whether a file name has one of the server's accepted extensions. */
export function isAcceptedFilename(filename: string, accepted: string[]): boolean {
  return accepted.includes(fileExtension(filename));
}

/** Value for an <input type="file"> `accept` attribute, from the config. */
export function acceptAttr(config: AttachmentConfig): string {
  return config.acceptedExtensions.join(',');
}

/** Format a byte count as a compact human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/**
 * Validates a set of incoming files against what a run already holds, using the
 * server-provided limits. Returns the first human-readable error, or `null`
 * when the batch is acceptable. Mirrors the backend's per-file size, count, and
 * total-size checks.
 */
export function validateNewFiles(
  incoming: File[],
  existing: { count: number; totalBytes: number },
  config: AttachmentConfig,
): string | null {
  if (incoming.length === 0) return null;

  const bad = incoming.find((f) => !isAcceptedFilename(f.name, config.acceptedExtensions));
  if (bad) {
    return `Unsupported file type: ${bad.name}. Allowed: ${config.acceptedExtensions.join(', ')}`;
  }

  const oversized = incoming.find((f) => f.size > config.maxFileMb * MB);
  if (oversized) {
    return `"${oversized.name}" is too large — each file must be at most ${config.maxFileMb} MB.`;
  }

  if (existing.count + incoming.length > config.maxPerRun) {
    return `A run may have at most ${config.maxPerRun} attachments.`;
  }

  const incomingTotal = incoming.reduce((sum, f) => sum + f.size, 0);
  if (existing.totalBytes + incomingTotal > config.maxTotalMb * MB) {
    return `Total attachments for a run may not exceed ${config.maxTotalMb} MB.`;
  }

  return null;
}

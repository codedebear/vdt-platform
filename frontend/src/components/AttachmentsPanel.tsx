/**
 * Attachments section for an existing phase run.
 *
 * The initial list is passed in from the project-detail response (no per-card
 * fetch on mount). When `editable` (the phase's worker role on a still-open
 * run), it also offers add-more and per-file delete, keeping its own local copy
 * in sync from the upload/delete responses — adding or removing an attachment
 * never changes the phase lifecycle, so it doesn't force a project refetch.
 */
import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AttachmentMeta } from '../lib/types';
import { acceptAttr, formatBytes, validateNewFiles } from '../lib/attachments';
import { useAttachmentConfig } from '../lib/config';
import { Alert, Spinner } from './ui';

interface AttachmentsPanelProps {
  executionId: string;
  /** Attachment metadata already loaded with the project (may be empty). */
  initial: AttachmentMeta[];
  /** Whether the viewer may add/remove attachments on this run. */
  editable: boolean;
}

export default function AttachmentsPanel({
  executionId,
  initial,
  editable,
}: AttachmentsPanelProps) {
  const config = useAttachmentConfig();
  const [items, setItems] = useState<AttachmentMeta[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPick(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    setError(null);

    const existing = {
      count: items.length,
      totalBytes: items.reduce((sum, a) => sum + a.sizeBytes, 0),
    };
    const problem = validateNewFiles(picked, existing, config);
    if (problem) {
      setError(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setBusy(true);
    try {
      const updated = await api.uploadAttachments(executionId, picked);
      setItems(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    setDeletingId(id);
    try {
      await api.deleteAttachment(executionId, id);
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove attachment');
      // Re-sync in case the server state diverged (e.g. run no longer open).
      try {
        setItems(await api.listAttachments(executionId));
      } catch {
        /* keep the optimistic list; the error message already explains */
      }
    } finally {
      setDeletingId(null);
    }
  }

  // Nothing to show: no attachments and not editable → render nothing.
  if (items.length === 0 && !editable && !error) return null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Attachments{items.length > 0 && ` (${items.length})`}
        </span>
        {editable && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={acceptAttr(config)}
              className="hidden"
              onChange={(e) => void onPick(e.target.files)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
            >
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <span aria-hidden>＋</span>}
              {busy ? 'Uploading…' : 'Add files'}
            </button>
          </>
        )}
      </div>

      {items.length === 0 ? (
        editable && (
          <p className="mt-2 text-xs text-slate-400">
            The AI will read any files you attach as extra context for this phase.
          </p>
        )
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {items.map((a) => (
            <li
              key={a.id}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700"
              title={`${a.filename} — ${formatBytes(a.sizeBytes)}`}
            >
              <span className="truncate" style={{ maxWidth: '14rem' }}>
                {a.filename}
              </span>
              <span className="shrink-0 text-slate-400">{formatBytes(a.sizeBytes)}</span>
              {editable && (
                <button
                  type="button"
                  disabled={deletingId === a.id || busy}
                  onClick={() => void remove(a.id)}
                  aria-label={`Remove ${a.filename}`}
                  className="shrink-0 text-slate-400 hover:text-red-600 disabled:opacity-50"
                >
                  {deletingId === a.id ? '…' : '✕'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}
    </div>
  );
}

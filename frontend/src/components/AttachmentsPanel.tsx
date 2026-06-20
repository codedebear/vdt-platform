/**
 * Attachments section for an existing phase run.
 *
 * Always lists the run's current attachments (metadata only — the AI reads the
 * bytes server-side). When `editable` (the phase's worker role on a still-open
 * run), it also offers add-more and per-file delete. Self-contained: it fetches
 * its own list on mount and keeps it in local state, so adding/removing an
 * attachment never forces a full project refetch (attachments don't change the
 * phase lifecycle).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AttachmentMeta } from '../lib/types';
import { ACCEPT_ATTR, formatBytes, validateNewFiles } from '../lib/attachments';
import { Alert, Spinner } from './ui';

interface AttachmentsPanelProps {
  executionId: string;
  /** Whether the viewer may add/remove attachments on this run. */
  editable: boolean;
}

export default function AttachmentsPanel({ executionId, editable }: AttachmentsPanelProps) {
  const [items, setItems] = useState<AttachmentMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listAttachments(executionId);
      setItems(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load attachments');
      setItems([]);
    }
  }, [executionId]);

  useEffect(() => {
    let active = true;
    api
      .listAttachments(executionId)
      .then((list) => active && setItems(list))
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError ? err.message : 'Could not load attachments');
        setItems([]);
      });
    return () => {
      active = false;
    };
  }, [executionId]);

  const current = items ?? [];

  async function onPick(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    setError(null);

    const existing = {
      count: current.length,
      totalBytes: current.reduce((sum, a) => sum + a.sizeBytes, 0),
    };
    const problem = validateNewFiles(picked, existing);
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
      setItems((prev) => (prev ? prev.filter((a) => a.id !== id) : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove attachment');
      // Re-sync in case the server state diverged (e.g. run no longer open).
      await load();
    } finally {
      setDeletingId(null);
    }
  }

  // Nothing to show: no attachments and not editable → render nothing.
  if (items !== null && current.length === 0 && !editable && !error) return null;

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Attachments{current.length > 0 && ` (${current.length})`}
        </span>
        {editable && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
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

      {items === null ? (
        <p className="mt-2 text-xs text-slate-400">Loading attachments…</p>
      ) : current.length === 0 ? (
        editable && (
          <p className="mt-2 text-xs text-slate-400">
            The AI will read any files you attach as extra context for this phase.
          </p>
        )
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {current.map((a) => (
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

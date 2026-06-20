/**
 * Panel for starting the next phase run on a project.
 *
 * The startable phases are computed locally with the same rules as the backend
 * engine (next unapproved phase + any approved-repeatable phase). Only phases the
 * viewer's role may start are offered as actions; if a phase is ready but belongs
 * to another role, a quiet hint is shown instead of a button.
 */
import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { PhaseType, ProjectDetail, Role } from '../lib/types';
import { can, PHASE_WORKER_ROLE } from '../lib/permissions';
import { getStartablePhases } from '../lib/workflow';
import { ACCEPT_ATTR, formatBytes, validateNewFiles } from '../lib/attachments';
import { Alert, Button, Card, Field, PHASE_LABELS, ROLE_LABELS, Select, Textarea } from './ui';

interface StartPhaseCardProps {
  project: ProjectDetail;
  role: Role;
  onChanged: () => void | Promise<void>;
}

export default function StartPhaseCard({ project, role, onChanged }: StartPhaseCardProps) {
  const startable = useMemo(
    () => getStartablePhases(project.track, project.executions),
    [project.track, project.executions],
  );
  const mine = useMemo(
    () => startable.filter((p) => can(role, 'PHASE_START', { phaseType: p })),
    [startable, role],
  );

  const [selected, setSelected] = useState<PhaseType | ''>('');
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Nothing startable at all → let the parent show "all phases complete".
  if (startable.length === 0) return null;

  // A phase is ready, but not for this role: show a quiet hint, no button.
  if (mine.length === 0) {
    return (
      <Card className="mb-6 p-4 text-sm text-slate-500">
        Next:{' '}
        <span className="font-medium text-slate-700">
          {startable.map((p) => PHASE_LABELS[p]).join(', ')}
        </span>{' '}
        — can be started by{' '}
        {[...new Set(startable.map((p) => ROLE_LABELS[PHASE_WORKER_ROLE[p]]))].join(', ')}.
      </Card>
    );
  }

  const phase = (selected || mine[0]) as PhaseType;

  function addFiles(picked: FileList | null): void {
    if (!picked || picked.length === 0) return;
    const next = [...files, ...Array.from(picked)];
    setError(null);
    const problem = validateNewFiles(Array.from(picked), {
      count: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    });
    if (problem) {
      setError(problem);
    } else {
      setFiles(next);
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  function removeFile(index: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const run = await api.startPhase(project.id, {
        phaseType: phase,
        input: input.trim() || undefined,
      });
      // Run exists now; attach staged files to it. If this fails the run still
      // started, so report it softly and let the user retry from the run card.
      if (files.length > 0) {
        try {
          await api.uploadAttachments(run.id, files);
        } catch (err) {
          setError(
            `Phase started, but attaching files failed: ${
              err instanceof ApiError ? err.message : 'upload error'
            }. You can attach them from the run below.`,
          );
          setFiles([]);
          await onChanged();
          return;
        }
      }
      setInput('');
      setSelected('');
      setFiles([]);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the phase');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 space-y-3 p-4">
      <h2 className="text-sm font-semibold text-slate-700">Start a phase</h2>

      {mine.length > 1 && (
        <Field label="Phase">
          <Select
            value={phase}
            onChange={(e) => setSelected(e.target.value as PhaseType)}
          >
            {mine.map((p) => (
              <option key={p} value={p}>
                {PHASE_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        label={mine.length > 1 ? 'Context / input (optional)' : `${PHASE_LABELS[phase]} — context / input (optional)`}
        hint="Requirements, an API spec, or notes for the AI to work from."
      >
        <Textarea
          rows={4}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Optional context for this phase…"
        />
      </Field>

      <div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
        >
          <span aria-hidden>📎</span> Attach files
        </button>
        <span className="ml-2 text-xs text-slate-400">
          PDF, Word, Excel, CSV, text — the AI reads them as context.
        </span>

        {files.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="inline-flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700"
                title={`${f.name} — ${formatBytes(f.size)}`}
              >
                <span className="truncate" style={{ maxWidth: '14rem' }}>
                  {f.name}
                </span>
                <span className="shrink-0 text-slate-400">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${f.name}`}
                  className="shrink-0 text-slate-400 hover:text-red-600 disabled:opacity-50"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <Alert>{error}</Alert>}

      <Button variant="primary" loading={busy} disabled={busy} onClick={start}>
        Start {PHASE_LABELS[phase]} phase
      </Button>
    </Card>
  );
}

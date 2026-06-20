/**
 * Panel for starting the next phase run on a project.
 *
 * The startable phases are computed locally with the same rules as the backend
 * engine (next unapproved phase + any approved-repeatable phase). Only phases the
 * viewer's role may start are offered as actions; if a phase is ready but belongs
 * to another role, a quiet hint is shown instead of a button.
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { PhaseType, ProjectDetail, Role } from '../lib/types';
import { can, PHASE_WORKER_ROLE } from '../lib/permissions';
import { getStartablePhases } from '../lib/workflow';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.startPhase(project.id, {
        phaseType: phase,
        input: input.trim() || undefined,
      });
      setInput('');
      setSelected('');
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

      {error && <Alert>{error}</Alert>}

      <Button variant="primary" loading={busy} disabled={busy} onClick={start}>
        Start {PHASE_LABELS[phase]} phase
      </Button>
    </Card>
  );
}

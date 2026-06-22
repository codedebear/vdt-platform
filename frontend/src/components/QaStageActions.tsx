/**
 * Stage-driven action panel for the QA workspace (QAX-6B — drafting stages).
 *
 * Renders the actions legal at the run's current stage, each honoring the
 * review → feedback → regenerate loop before the forward confirm:
 *  - SCENARIO_DRAFT → generate scenarios · regenerate (optional feedback) · confirm
 *  - STEPS_DRAFT    → generate steps · regenerate (optional feedback) · confirm+compile
 *  - COMPILED       → recompile (optional feedback) · start run
 *
 * Actions that call Claude (generate / regenerate / compile) are gated behind a
 * one-click cost confirmation, since they spend tokens against the project
 * budget. Confirming scenarios and starting the run cost nothing. The execution
 * / results-review / export stages are handled by QAX-6C; here they render a
 * passive note. Every successful mutation returns the updated run via onUpdated.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { TestRun } from '../lib/types';
import { Alert, Button, Card, Textarea } from './ui';

interface QaStageActionsProps {
  executionId: string;
  /** The current run, or null when no QA run has been started yet. */
  testRun: TestRun | null;
  /** Viewer may produce QA output (PHASE_SUBMIT on a QA phase). */
  canWork: boolean;
  /** The phase is in a writable status (IN_PROGRESS / CHANGES_REQUESTED). */
  writable: boolean;
  /** Called with the refreshed run after any successful mutation. */
  onUpdated: (run: TestRun) => void;
}

/** A Claude-spending action awaiting cost confirmation. */
interface PendingAction {
  label: string;
  note: string;
  run: () => Promise<TestRun>;
}

export default function QaStageActions({
  executionId,
  testRun,
  canWork,
  writable,
  onUpdated,
}: QaStageActionsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);

  if (!canWork) return null;

  const stage = testRun?.stage ?? 'SCENARIO_DRAFT';
  const hasScenarios = (testRun?.scenarios.length ?? 0) > 0;
  const hasSteps = Boolean(testRun?.scenarios.some((s) => s.steps.length > 0));

  // Drafting actions only apply while the phase is writable and the run is at a
  // pre-execution stage; later stages are read-only here (QAX-6C owns them).
  const draftingStage =
    stage === 'SCENARIO_DRAFT' || stage === 'STEPS_DRAFT' || stage === 'COMPILED';

  async function execute(action: () => Promise<TestRun>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const run = await action();
      setFeedback('');
      setPending(null);
      onUpdated(run);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed, please try again');
    } finally {
      setBusy(false);
    }
  }

  /** Queue a Claude-spending action for cost confirmation. */
  function confirmCost(label: string, run: () => Promise<TestRun>): void {
    setError(null);
    setPending({
      label,
      note: 'This calls Claude and consumes tokens against the project budget.',
      run,
    });
  }

  const trimmedFeedback = feedback.trim() || undefined;

  if (!writable) {
    return (
      <Card className="mb-6 p-4">
        <p className="text-sm text-slate-500">
          This QA phase is not in an editable state, so its run cannot be changed.
        </p>
      </Card>
    );
  }

  if (!draftingStage) {
    return (
      <Card className="mb-6 p-4">
        <p className="text-sm text-slate-500">
          {stage === 'EXECUTING'
            ? 'Execution is in progress — results will appear once the worker finishes.'
            : 'Results review and export are managed below.'}
        </p>
      </Card>
    );
  }

  // Cost-confirmation takes over the panel until the user confirms or cancels.
  if (pending) {
    return (
      <Card className="mb-6 space-y-3 p-4">
        <p className="text-sm text-slate-600">
          {pending.label} — {pending.note} Continue?
        </p>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} onClick={() => void execute(pending.run)}>
            Confirm
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-6 space-y-3 p-4">
      {error && <Alert>{error}</Alert>}

      {/* SCENARIO_DRAFT ------------------------------------------------------ */}
      {stage === 'SCENARIO_DRAFT' && !hasScenarios && (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            Generate the test scenarios for this run from its spec and attachments.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              confirmCost('Generate scenarios', () => api.generateScenarios(executionId))
            }
          >
            Generate scenarios with AI
          </Button>
        </div>
      )}

      {stage === 'SCENARIO_DRAFT' && hasScenarios && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Review the scenarios below. Confirm to draft steps, or regenerate them —
            optionally with feedback to steer the revision.
          </p>
          <FeedbackBox value={feedback} onChange={setFeedback} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void execute(() => api.confirmScenarios(executionId))}
            >
              Confirm scenarios →
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                confirmCost(
                  trimmedFeedback ? 'Regenerate scenarios with feedback' : 'Regenerate scenarios',
                  () => api.generateScenarios(executionId, trimmedFeedback),
                )
              }
            >
              {trimmedFeedback ? 'Regenerate with feedback' : 'Regenerate'}
            </Button>
          </div>
        </div>
      )}

      {/* STEPS_DRAFT --------------------------------------------------------- */}
      {stage === 'STEPS_DRAFT' && !hasSteps && (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            Draft the ordered steps and expected results for the confirmed scenarios.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => confirmCost('Generate steps', () => api.generateSteps(executionId))}
          >
            Generate steps with AI
          </Button>
        </div>
      )}

      {stage === 'STEPS_DRAFT' && hasSteps && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Review the steps below. Confirm to compile them into runnable artifacts, or
            regenerate — optionally with feedback.
          </p>
          <FeedbackBox value={feedback} onChange={setFeedback} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                confirmCost('Confirm & compile steps', () => api.confirmSteps(executionId))
              }
            >
              Confirm &amp; compile steps →
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                confirmCost(
                  trimmedFeedback ? 'Regenerate steps with feedback' : 'Regenerate steps',
                  () => api.generateSteps(executionId, trimmedFeedback),
                )
              }
            >
              {trimmedFeedback ? 'Regenerate with feedback' : 'Regenerate'}
            </Button>
          </div>
        </div>
      )}

      {/* COMPILED ------------------------------------------------------------ */}
      {stage === 'COMPILED' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            The steps are compiled into runnable artifacts. Start the run to execute them,
            or recompile — optionally with feedback to refine the artifacts.
          </p>
          <FeedbackBox value={feedback} onChange={setFeedback} disabled={busy} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void execute(() => api.startQaRun(executionId))}
            >
              Start run →
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                confirmCost(
                  trimmedFeedback ? 'Recompile with feedback' : 'Recompile artifacts',
                  () => api.recompileArtifacts(executionId, trimmedFeedback),
                )
              }
            >
              {trimmedFeedback ? 'Recompile with feedback' : 'Recompile'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Shared optional-feedback textarea for the regenerate loop. */
function FeedbackBox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <Textarea
      rows={2}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Optional feedback to steer a regeneration…"
    />
  );
}

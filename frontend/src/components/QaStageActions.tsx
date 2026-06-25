/**
 * Stage-driven action panel for the QA workspace (QAX-6B drafting + QAX-6C
 * results review / sign-off / revise).
 *
 * Renders the actions legal at the run's current stage, each honoring the
 * review → feedback → regenerate loop before the forward confirm:
 *  - SCENARIO_DRAFT → generate scenarios · regenerate (optional feedback) · confirm
 *  - STEPS_DRAFT    → generate steps · regenerate (optional feedback) · confirm+compile
 *  - COMPILED       → recompile (optional feedback) · start run
 *  - EXECUTING      → passive note (the page auto-refreshes until results land)
 *  - RESULTS_REVIEW → UATR Amendment sign-off (→ EXPORTED) · revise back to an
 *                     earlier stage (re-draft / re-run)
 *  - EXPORTED       → passive note (download the report from the run header)
 *
 * Actions that call Claude (generate / regenerate / compile) are gated behind a
 * one-click cost confirmation, since they spend tokens against the project
 * budget. Confirming, starting the run, signing off and revising cost nothing.
 * Every successful mutation returns the updated run via onUpdated.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { QaStage, TestRun, UatrSignOffInput } from '../lib/types';
import { Alert, Button, Card, Field, Input, QA_STAGE_LABELS, Select, Textarea } from './ui';

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

/** Earlier stages a RESULTS_REVIEW run can be sent back to (re-draft / re-run). */
const REVISE_TARGETS: { value: QaStage; label: string }[] = [
  { value: 'COMPILED', label: 'Re-run (back to Compiled)' },
  { value: 'STEPS_DRAFT', label: 'Revise steps' },
  { value: 'SCENARIO_DRAFT', label: 'Revise scenarios' },
];

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
  // RESULTS_REVIEW sign-off + revise state.
  const [signOff, setSignOff] = useState<UatrSignOffInput>({});
  const [reviseTarget, setReviseTarget] = useState<QaStage>('COMPILED');
  // Full retest (QAX-8B) confirmation.
  const [retestConfirm, setRetestConfirm] = useState(false);
  const navigate = useNavigate();

  if (!canWork) return null;

  const stage: QaStage = testRun?.stage ?? 'SCENARIO_DRAFT';
  const hasScenarios = (testRun?.scenarios.length ?? 0) > 0;
  const hasSteps = Boolean(testRun?.scenarios.some((s) => s.steps.length > 0));

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

  /**
   * Start a Full Retest: clone the current run into a fresh COMPILED run and
   * navigate to it. Costs no tokens; finalizes the current round as history.
   */
  async function handleRetest(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const run = await api.retestQaRun(executionId);
      setRetestConfirm(false);
      navigate(`/phases/${run.executionId}/qa`);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not start a retest, please try again',
      );
    } finally {
      setBusy(false);
    }
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

  // Full-retest confirmation takes over the panel until confirmed or cancelled.
  if (retestConfirm) {
    return (
      <Card className="mb-6 space-y-3 p-4">
        <p className="text-sm text-slate-600">
          Start a <strong>Full retest</strong>? This clones the same compiled test cases into a
          brand-new run (it starts at Compiled, ready to run) and closes the current run as
          completed history. It does not call Claude.
        </p>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} onClick={() => void handleRetest()}>
            Start retest
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setRetestConfirm(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  /** Build a sign-off payload from the non-empty form fields. */
  function trimmedSignOff(): UatrSignOffInput {
    const out: UatrSignOffInput = {};
    if (signOff.version?.trim()) out.version = signOff.version.trim();
    if (signOff.preparedBy?.trim()) out.preparedBy = signOff.preparedBy.trim();
    if (signOff.reviewedBy?.trim()) out.reviewedBy = signOff.reviewedBy.trim();
    if (signOff.approvedBy?.trim()) out.approvedBy = signOff.approvedBy.trim();
    return out;
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

      {/* EXECUTING ----------------------------------------------------------- */}
      {stage === 'EXECUTING' && (
        <p className="text-sm text-slate-500">
          Execution is in progress — the worker is running the compiled artifacts. This
          page refreshes automatically and the results will appear once it finishes.
        </p>
      )}

      {/* RESULTS_REVIEW ------------------------------------------------------ */}
      {stage === 'RESULTS_REVIEW' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Review the per-step results below. Sign off to finalize the run and produce the
            UATR report, or send it back to re-draft or re-run.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Version">
              <Input
                value={signOff.version ?? ''}
                placeholder="e.g. 1.0"
                onChange={(e) => setSignOff((s) => ({ ...s, version: e.target.value }))}
              />
            </Field>
            <Field label="Prepared by">
              <Input
                value={signOff.preparedBy ?? ''}
                onChange={(e) => setSignOff((s) => ({ ...s, preparedBy: e.target.value }))}
              />
            </Field>
            <Field label="Reviewed by">
              <Input
                value={signOff.reviewedBy ?? ''}
                onChange={(e) => setSignOff((s) => ({ ...s, reviewedBy: e.target.value }))}
              />
            </Field>
            <Field label="Approved by">
              <Input
                value={signOff.approvedBy ?? ''}
                onChange={(e) => setSignOff((s) => ({ ...s, approvedBy: e.target.value }))}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void execute(() => api.confirmResults(executionId, trimmedSignOff()))}
            >
              Sign off &amp; export →
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setRetestConfirm(true)}>
              Full retest
            </Button>
          </div>

          <div className="border-t border-slate-100 pt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
              Send back
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                className="max-w-xs"
                value={reviseTarget}
                onChange={(e) => setReviseTarget(e.target.value as QaStage)}
              >
                {REVISE_TARGETS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void execute(() => api.reviseQaStage(executionId, reviseTarget))}
              >
                Revise
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* EXPORTED ------------------------------------------------------------ */}
      {stage === 'EXPORTED' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            This run is signed off ({QA_STAGE_LABELS.EXPORTED}). Download the UATR report from
            the run header above, or start a full retest after a fix to re-run the same test
            cases against the new build.
          </p>
          <Button variant="secondary" disabled={busy} onClick={() => setRetestConfirm(true)}>
            Full retest
          </Button>
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

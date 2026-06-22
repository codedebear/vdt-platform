/**
 * A single phase-execution row with its lifecycle actions.
 *
 * What it offers depends on the run's status and the viewer's permissions:
 * - IN_PROGRESS / CHANGES_REQUESTED + worker role → Generate (AI) or submit
 *   output manually.
 * - AWAITING_REVIEW + reviewer → Approve / Request changes (with an optional
 *   note).
 * The output (once present) is shown in a collapsible monospace panel.
 *
 * Every successful action calls `onChanged` so the parent can refetch and keep
 * the project's next-phase / startable state in sync. Permission flags are
 * passed in (computed once by the parent); the backend still re-checks each call.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { PhaseExecution } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { Alert, Button, Card, PHASE_LABELS, PhaseStatusBadge, Textarea } from './ui';
import AttachmentsPanel from './AttachmentsPanel';

interface PhaseExecutionCardProps {
  execution: PhaseExecution;
  /** Viewer may generate/submit output for this phase type. */
  canWork: boolean;
  /** Viewer may review (approve / request changes) on this project. */
  canReview: boolean;
  /** Called after any successful mutation so the parent can refetch. */
  onChanged: () => void | Promise<void>;
}

export default function PhaseExecutionCard({
  execution,
  canWork,
  canReview,
  onChanged,
}: PhaseExecutionCardProps) {
  const [busy, setBusy] = useState<
    null | 'generate' | 'batch' | 'submit' | 'approve' | 'changes'
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualOutput, setManualOutput] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  // Which generate mode the worker is confirming (null = no pending confirm).
  const [confirmKind, setConfirmKind] = useState<null | 'sync' | 'batch'>(null);

  const isProducible =
    execution.status === 'IN_PROGRESS' || execution.status === 'CHANGES_REQUESTED';
  const isReviewable = execution.status === 'AWAITING_REVIEW';
  // A batch generation is in flight; the backend poller will resolve it.
  const isQueued = execution.status === 'QUEUED';
  // QA runs use the staged QA workspace (scenarios -> steps -> execute ->
  // export), not the single-shot generate/submit flow, so we route into it.
  const isQa = execution.phaseType === 'QA';

  async function run(
    kind: NonNullable<typeof busy>,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      await action();
      setManualMode(false);
      setManualOutput('');
      setReviewNote('');
      setConfirmKind(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed, please try again');
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-medium text-slate-800">
            {PHASE_LABELS[execution.phaseType]}
          </span>
          <span className="text-xs text-slate-400">Run #{execution.runNumber}</span>
        </div>
        <PhaseStatusBadge status={execution.status} />
      </div>

      {execution.reviewNote && (
        <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <span className="font-medium">Review note:</span> {execution.reviewNote}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>Started {formatDateTime(execution.startedAt)}</span>
        {execution.completedAt && (
          <span>Completed {formatDateTime(execution.completedAt)}</span>
        )}
        {execution.outputTokens != null && (
          <span>{execution.outputTokens.toLocaleString()} output tokens</span>
        )}
        {execution.generationCount > 0 && (
          <span>{execution.generationCount}× generated</span>
        )}
      </div>

      {/* Output viewer */}
      {execution.output && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowOutput((v) => !v)}
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            {showOutput ? '▾ Hide output' : '▸ Show output'}
          </button>
          {showOutput && (
            <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100 whitespace-pre-wrap break-words">
              {execution.output}
            </pre>
          )}
        </div>
      )}

      {/* Attachments the AI reads as context; editable by the worker while open. */}
      <AttachmentsPanel
        executionId={execution.id}
        initial={execution.attachments ?? []}
        editable={isProducible && canWork}
      />

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {/* Batch generation in flight: poller resolves it; no actions meanwhile. */}
      {isQueued && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm text-indigo-700">
          <span
            className="h-2 w-2 animate-pulse rounded-full bg-indigo-500"
            aria-hidden
          />
          <span>
            Queued — generating via the Batch API. This updates automatically when
            ready.
          </span>
          {execution.batchId && (
            <code className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600">
              batch …{execution.batchId.slice(-8)}
            </code>
          )}
        </div>
      )}

      {/* QA staged flow: enter the dedicated workspace instead of generate/submit. */}
      {isQa && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <Link
            to={`/phases/${execution.id}/qa`}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            Open QA workspace →
          </Link>
        </div>
      )}

      {/* Worker actions: generate / manual submit (non-QA phases). */}
      {!isQa && isProducible && canWork && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {!manualMode ? (
            confirmKind ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-600">
                  {confirmKind === 'batch'
                    ? 'Submit a batch generation? This calls Claude via the Anthropic Batch API (~50% cheaper) and may take a while — the run will queue and update automatically when ready.'
                    : 'Generate now? This calls Claude immediately and consumes tokens against the project budget.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    loading={busy === 'generate' || busy === 'batch'}
                    disabled={anyBusy}
                    onClick={() =>
                      run(confirmKind === 'batch' ? 'batch' : 'generate', () =>
                        api.generatePhase(
                          execution.id,
                          confirmKind === 'batch' ? 'batch' : 'sync',
                        ),
                      )
                    }
                  >
                    {confirmKind === 'batch'
                      ? 'Confirm batch generate'
                      : 'Confirm generate'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={anyBusy}
                    onClick={() => setConfirmKind(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={anyBusy}
                    onClick={() => setConfirmKind('sync')}
                  >
                    Generate with AI
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={anyBusy}
                    onClick={() => setConfirmKind('batch')}
                  >
                    Generate (batch · ~50% cheaper)
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={anyBusy}
                    onClick={() => {
                      setManualOutput(execution.output ?? '');
                      setManualMode(true);
                    }}
                  >
                    Submit output manually
                  </Button>
                </div>
                <p className="text-xs text-slate-400">
                  Batch generation is ~50% cheaper but asynchronous: the run shows
                  as Queued and updates automatically when ready.
                </p>
              </div>
            )
          ) : (
            <div className="space-y-2">
              <Textarea
                rows={6}
                value={manualOutput}
                onChange={(e) => setManualOutput(e.target.value)}
                placeholder="Paste or write this phase's output…"
                className="font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  loading={busy === 'submit'}
                  disabled={anyBusy || manualOutput.trim().length === 0}
                  onClick={() =>
                    run('submit', () =>
                      api.submitOutput(execution.id, manualOutput.trim()),
                    )
                  }
                >
                  Submit for review
                </Button>
                <Button
                  variant="ghost"
                  disabled={anyBusy}
                  onClick={() => {
                    setManualMode(false);
                    setManualOutput('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Reviewer actions: approve / request changes */}
      {isReviewable && canReview && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <Textarea
            rows={2}
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="Review note (optional)…"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={busy === 'approve'}
              disabled={anyBusy}
              onClick={() =>
                run('approve', () =>
                  api.reviewPhase(execution.id, {
                    action: 'APPROVE',
                    note: reviewNote.trim() || undefined,
                  }),
                )
              }
            >
              Approve
            </Button>
            <Button
              variant="danger"
              loading={busy === 'changes'}
              disabled={anyBusy}
              onClick={() =>
                run('changes', () =>
                  api.reviewPhase(execution.id, {
                    action: 'REQUEST_CHANGES',
                    note: reviewNote.trim() || undefined,
                  }),
                )
              }
            >
              Request changes
            </Button>
          </div>
        </div>
      )}

      {/* Hints when the user can see a pending action but can't act on it. */}
      {isReviewable && !canReview && (
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
          Awaiting review by the project owner.
        </p>
      )}
      {!isQa && isProducible && !canWork && (
        <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
          Awaiting the {PHASE_LABELS[execution.phaseType]} worker to produce output.
        </p>
      )}
    </Card>
  );
}

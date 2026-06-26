/**
 * QA workspace (QAX-6).
 *
 * Shows a QA phase's staged run: the current stage, run metadata, the
 * scenarios → steps → results tables, and a "Download report (PDF)" button (QA-capable
 * roles, enabled at RESULTS_REVIEW/EXPORTED). The stage-appropriate actions —
 * generate/confirm/compile/start, the review→feedback→regen loops, results
 * sign-off and revise — live in {@link QaStageActions}. While the run is
 * EXECUTING the page polls for results so they appear without a manual refresh.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type {
  HttpArtifactRequest,
  PhaseExecution,
  TestRun,
  TestScenario,
  TestStep,
} from '../lib/types';
import { formatDateTime } from '../lib/format';
import { can } from '../lib/permissions';
import { useAuth } from '../auth/AuthContext';
import {
  Button,
  Card,
  QA_STAGE_LABELS,
  QaStageBadge,
  ScenarioResultBadge,
  TestStatusBadge,
} from '../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../components/PageState';
import QaStageActions from '../components/QaStageActions';

/** Stages at which the UATR report can be downloaded. */
const EXPORTABLE_STAGES: TestRun['stage'][] = ['RESULTS_REVIEW', 'EXPORTED'];

export default function QaRunPage() {
  const { executionId } = useParams<{ executionId: string }>();
  const { user } = useAuth();
  const [phase, setPhase] = useState<PhaseExecution | null>(null);
  const [testRun, setTestRun] = useState<TestRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Per-scenario selection and feedback (SCENARIO_DRAFT only).
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [scenarioFeedbacks, setScenarioFeedbacks] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    if (!executionId) return;
    setLoading(true);
    try {
      const [ph, run] = await Promise.all([
        api.getPhase(executionId),
        api.getTestRun(executionId),
      ]);
      setPhase(ph);
      setTestRun(run);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 404
            ? 'Phase not found.'
            : err.message
          : 'Failed to load the QA run',
      );
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset per-scenario selection whenever the run itself changes (new run, new stage).
  useEffect(() => {
    setExcluded(new Set());
    setScenarioFeedbacks({});
  }, [testRun?.id, testRun?.stage]);

  // While the run is EXECUTING, poll for results so the page reflects the
  // worker's progress without a manual refresh. The interval is torn down as
  // soon as the stage changes (e.g. to RESULTS_REVIEW) or the page unmounts.
  useEffect(() => {
    if (testRun?.stage !== 'EXECUTING' || !executionId) return;
    const id = setInterval(() => {
      api
        .getTestRun(executionId)
        .then((run) => run && setTestRun(run))
        .catch(() => {
          /* transient poll error — keep the last good state */
        });
    }, 5000);
    return () => clearInterval(id);
  }, [testRun?.stage, executionId]);

  const role = user?.role;
  const canWorkQa = Boolean(role && can(role, 'PHASE_SUBMIT', { phaseType: 'QA' }));
  const canReadReport =
    canWorkQa || role === 'SUPER_ADMIN' || role === 'PROJECT_OWNER';
  const canExport =
    canReadReport && testRun != null && EXPORTABLE_STAGES.includes(testRun.stage);
  // The phase must be in a writable status for the QA run to be mutated.
  const writable =
    phase?.status === 'IN_PROGRESS' || phase?.status === 'CHANGES_REQUESTED';

  async function handleDownload(): Promise<void> {
    if (!executionId) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await api.downloadUatrReport(executionId);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  const backTo = phase ? `/projects/${phase.projectId}` : '/projects';

  return (
    <div>
      <Link to={backTo} className="text-sm text-brand-600 hover:text-brand-700">
        ← Back to project
      </Link>

      {error && <ErrorState message={error} />}
      {!error && loading && <LoadingState label="Loading QA run…" />}

      {!error && !loading && (
        <>
          <header className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-slate-800">QA workspace</h1>
              {phase && (
                <p className="mt-1 text-sm text-slate-500">
                  Run #{phase.runNumber} · phase status {phase.status.toLowerCase().replace('_', ' ')}
                </p>
              )}
            </div>
            {testRun && <QaStageBadge stage={testRun.stage} />}
          </header>

          <QaStageActions
            executionId={executionId ?? ''}
            testRun={testRun}
            canWork={canWorkQa}
            writable={writable}
            onUpdated={setTestRun}
            excluded={excluded}
            scenarioFeedbacks={scenarioFeedbacks}
          />

          {!testRun ? (
            <EmptyState
              title="No QA run yet"
              description="No test scenarios have been generated for this QA phase. Generate them above to begin, if you have permission."
            />
          ) : (
            <>
              <Card className="mb-6 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Stage</dt>
                      <dd className="mt-0.5 text-slate-700">{QA_STAGE_LABELS[testRun.stage]}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Version</dt>
                      <dd className="mt-0.5 text-slate-700">{testRun.version}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Overall</dt>
                      <dd className="mt-0.5">
                        <ScenarioResultBadge result={testRun.overallResult} />
                      </dd>
                    </div>
                    {testRun.startedAt && (
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-400">Started</dt>
                        <dd className="mt-0.5 text-slate-700">{formatDateTime(testRun.startedAt)}</dd>
                      </div>
                    )}
                    {testRun.finishedAt && (
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-slate-400">Finished</dt>
                        <dd className="mt-0.5 text-slate-700">{formatDateTime(testRun.finishedAt)}</dd>
                      </div>
                    )}
                  </dl>
                  {canExport && (
                    <Button variant="secondary" loading={downloading} onClick={handleDownload}>
                      Download report (PDF)
                    </Button>
                  )}
                </div>
                {downloadError && (
                  <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    {downloadError}
                  </p>
                )}
              </Card>

              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Scenarios ({testRun.scenarios.length})
              </h2>
              {testRun.scenarios.length === 0 ? (
                <Card className="p-8 text-center text-sm text-slate-400">No scenarios.</Card>
              ) : (
                <div className="space-y-4">
                  {testRun.scenarios.map((scenario) => (
                    <ScenarioCard
                      key={scenario.id}
                      scenario={scenario}
                      executionId={executionId ?? ''}
                      showExclude={testRun.stage === 'SCENARIO_DRAFT' && canWorkQa && writable}
                      isExcluded={excluded.has(scenario.id)}
                      onToggleExclude={(id) =>
                        setExcluded((prev) => {
                          const next = new Set(prev);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                      scenarioFeedback={scenarioFeedbacks[scenario.id] ?? ''}
                      onFeedbackChange={(id, val) =>
                        setScenarioFeedbacks((prev) => ({ ...prev, [id]: val }))
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** One scenario block: header + optional per-scenario exclude/feedback + steps table. */
function ScenarioCard({
  scenario,
  executionId,
  showExclude = false,
  isExcluded = false,
  onToggleExclude,
  scenarioFeedback = '',
  onFeedbackChange,
}: {
  scenario: TestScenario;
  executionId: string;
  showExclude?: boolean;
  isExcluded?: boolean;
  onToggleExclude?: (id: string) => void;
  scenarioFeedback?: string;
  onFeedbackChange?: (id: string, val: string) => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  return (
    <Card className={`p-4 transition-opacity${isExcluded ? ' opacity-40' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {showExclude && (
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-600 accent-indigo-600"
              checked={!isExcluded}
              onChange={() => onToggleExclude?.(scenario.id)}
              title={isExcluded ? 'Click to include' : 'Click to exclude'}
            />
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-400">#{scenario.no}</span>
              <span className={`font-medium${isExcluded ? ' line-through text-slate-400' : ' text-slate-800'}`}>
                {scenario.testName}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              {scenario.topic}
              {scenario.system ? ` · ${scenario.system}` : ''}
            </p>
          </div>
        </div>
        <ScenarioResultBadge result={scenario.result} />
      </div>

      {showExclude && !isExcluded && (
        <div className="mt-2 pl-6">
          {!feedbackOpen ? (
            <button
              type="button"
              className="text-xs text-slate-400 hover:text-indigo-600"
              onClick={() => setFeedbackOpen(true)}
            >
              {scenarioFeedback ? `Feedback: "${scenarioFeedback.slice(0, 40)}${scenarioFeedback.length > 40 ? '…' : ''}"` : '+ Add feedback'}
            </button>
          ) : (
            <div className="flex items-start gap-2">
              <textarea
                autoFocus
                rows={2}
                className="flex-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:border-indigo-400 focus:outline-none"
                placeholder="Feedback for this scenario…"
                value={scenarioFeedback}
                onChange={(e) => onFeedbackChange?.(scenario.id, e.target.value)}
              />
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-600"
                onClick={() => setFeedbackOpen(false)}
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}


      {scenario.steps.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Step</th>
                <th className="py-2 pr-3 font-medium">Expected</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Actual result</th>
                <th className="py-2 pr-3 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {scenario.steps.map((step) => (
                <tr key={step.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 text-slate-400">{step.order}</td>
                  <td className="py-2 pr-3 text-slate-700">{step.stepName}</td>
                  <td className="py-2 pr-3 text-slate-500">{step.expectedResult}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">{step.artifactType ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <TestStatusBadge status={step.result?.status ?? 'NOT_START'} />
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {step.result?.actualResult ? (
                      <span className="break-words">{step.result.actualResult}</span>
                    ) : (
                      '—'
                    )}
                    {step.result?.durationMs != null && (
                      <span className="ml-1 text-slate-400">({step.result.durationMs} ms)</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <StepEvidence executionId={executionId} step={step} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}


/**
 * Evidence cell for one step: a lazily-loaded screenshot thumbnail (BROWSER,
 * click to enlarge) or an expandable Request/Response panel (HTTP). Auth is sent
 * via the API client, so images are fetched as a blob and shown via an object URL
 * (revoked on unmount). Renders "—" when the step has no result/evidence yet.
 */
function StepEvidence({ executionId, step }: { executionId: string; step: TestStep }) {
  const result = step.result;
  const mime = result?.evidenceMime ?? null;
  const isImage = !!mime && mime.startsWith('image/');
  const isHttp = step.artifactType === 'HTTP';

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [open, setOpen] = useState(false);
  const [respText, setRespText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load the screenshot once, when image evidence exists for this step.
  useEffect(() => {
    if (!isImage) return;
    let active = true;
    let made: string | null = null;
    api
      .getStepEvidence(executionId, step.id)
      .then(({ blob }) => {
        if (!active) return;
        made = URL.createObjectURL(blob);
        setImgUrl(made);
      })
      .catch((e: unknown) => {
        if (active) setErr(e instanceof Error ? e.message : 'load failed');
      });
    return () => {
      active = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [executionId, step.id, isImage]);

  if (!result) return <span className="text-slate-300">—</span>;

  if (isImage) {
    return (
      <>
        {imgUrl ? (
          <button type="button" onClick={() => setEnlarged(true)} className="block">
            <img
              src={imgUrl}
              alt="step screenshot"
              className="h-16 w-auto rounded border border-slate-200 hover:opacity-80"
            />
          </button>
        ) : err ? (
          <span className="text-xs text-rose-400">{err}</span>
        ) : (
          <span className="text-xs text-slate-300">loading…</span>
        )}
        {enlarged && imgUrl && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
            onClick={() => setEnlarged(false)}
            role="presentation"
          >
            <img
              src={imgUrl}
              alt="step screenshot"
              className="max-h-full max-w-full rounded shadow-lg"
            />
          </div>
        )}
      </>
    );
  }

  if (isHttp) {
    const req = (step.artifactSpec as { request?: HttpArtifactRequest } | null)?.request;
    const reqText = req
      ? [
          `${req.method} ${req.path}`,
          req.query ? `?${new URLSearchParams(req.query).toString()}` : '',
          ...(req.headers ? Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`) : []),
          req.body !== undefined
            ? `\n${typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '(no request spec)';

    const toggle = () => {
      const next = !open;
      setOpen(next);
      if (next && respText === null && mime) {
        api
          .getStepEvidence(executionId, step.id)
          .then(({ blob }) => blob.text())
          .then((t) => setRespText(t))
          .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'load failed'));
      }
    };

    return (
      <div className="text-xs">
        <button type="button" onClick={toggle} className="text-indigo-600 hover:underline">
          {open ? 'Hide request/response' : 'Request / Response'}
        </button>
        {open && (
          <div className="mt-1 space-y-2">
            <div>
              <div className="font-medium text-slate-500">Request</div>
              <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                {reqText}
              </pre>
            </div>
            <div>
              <div className="font-medium text-slate-500">Response</div>
              {respText !== null ? (
                <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700">
                  {respText}
                </pre>
              ) : err ? (
                <span className="text-rose-400">{err}</span>
              ) : mime ? (
                <span className="text-slate-300">loading…</span>
              ) : (
                <span className="text-slate-300">no capture</span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return mime ? (
    <span className="text-xs text-slate-400">{mime}</span>
  ) : (
    <span className="text-slate-300">—</span>
  );
}

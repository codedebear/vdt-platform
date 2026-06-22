/**
 * QA workspace (QAX-6).
 *
 * Shows a QA phase's staged run: the current stage, run metadata, the
 * scenarios → steps → results tables, and a "Download UATR" button (QA-capable
 * roles, enabled at RESULTS_REVIEW/EXPORTED). The stage-appropriate actions —
 * generate/confirm/compile/start, the review→feedback→regen loops, results
 * sign-off and revise — live in {@link QaStageActions}. While the run is
 * EXECUTING the page polls for results so they appear without a manual refresh.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { PhaseExecution, TestRun, TestScenario } from '../lib/types';
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
  const canExport =
    canWorkQa && testRun != null && EXPORTABLE_STAGES.includes(testRun.stage);
  // The phase must be in a writable status for the QA run to be mutated.
  const writable =
    phase?.status === 'IN_PROGRESS' || phase?.status === 'CHANGES_REQUESTED';

  async function handleDownload(): Promise<void> {
    if (!executionId) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await api.downloadUatr(executionId);
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
                      Download UATR
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
                    <ScenarioCard key={scenario.id} scenario={scenario} />
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

/** One scenario block: header + a read-only steps/results table. */
function ScenarioCard({ scenario }: { scenario: TestScenario }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400">#{scenario.no}</span>
            <span className="font-medium text-slate-800">{scenario.testName}</span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {scenario.topic}
            {scenario.system ? ` · ${scenario.system}` : ''}
          </p>
        </div>
        <ScenarioResultBadge result={scenario.result} />
      </div>

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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

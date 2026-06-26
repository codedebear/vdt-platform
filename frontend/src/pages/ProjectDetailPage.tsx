/**
 * Project detail: header (name/track/status), the engine's suggested next phase,
 * a "start phase" panel, and the chronological phase-execution history with
 * inline lifecycle actions (generate / submit / review). Actions and their
 * visibility are gated by the viewer's role; the backend re-checks every call.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ProjectDetail } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { can } from '../lib/permissions';
import { useAuth } from '../auth/AuthContext';
import {
  Card,
  PHASE_LABELS,
  ProjectStatusBadge,
  TrackBadge,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/PageState';
import PhaseExecutionCard from '../components/PhaseExecutionCard';
import StartPhaseCard from '../components/StartPhaseCard';
import TargetSecretsCard from '../components/TargetSecretsCard';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const data = await api.getProject(id);
      setProject(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 404
            ? 'Project not found.'
            : err.message
          : 'Failed to load project',
      );
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    setProject(null);
    setError(null);
    // Guard against a stale response landing after navigation.
    api
      .getProject(id ?? '')
      .then((data) => active && setProject(data))
      .catch(
        (err) =>
          active &&
          setError(
            err instanceof ApiError
              ? err.status === 404
                ? 'Project not found.'
                : err.message
              : 'Failed to load project',
          ),
      );
    return () => {
      active = false;
    };
  }, [id]);

  // Auto-refresh while any run is QUEUED (a batch generation in flight). Instead
  // of refetching the whole project every tick, poll just the queued runs via the
  // lightweight GET /api/phases/:id; only when one leaves QUEUED do we do a full
  // reload (to refresh nextPhase / startablePhases / etc.). Polling pauses while
  // the tab is hidden and resumes (with an immediate check) when it returns.
  const queuedKey = (project?.executions ?? [])
    .filter((e) => e.status === 'QUEUED')
    .map((e) => e.id)
    .join(',');
  useEffect(() => {
    if (!queuedKey) return;
    const ids = queuedKey.split(',');
    let stopped = false;
    const poll = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const runs = await Promise.all(ids.map((id) => api.getPhase(id)));
        if (!stopped && runs.some((r) => r.status !== 'QUEUED')) {
          await load();
        }
      } catch {
        // Transient (e.g. network) — keep polling; a later tick will catch up.
      }
    };
    const timer = setInterval(() => void poll(), 10_000);
    const onVisible = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queuedKey, load]);

  const role = user?.role;
  const isOwner = Boolean(user && project && user.id === project.ownerId);
  const canReview = Boolean(role && can(role, 'PHASE_REVIEW', { isProjectOwner: isOwner }));

  return (
    <div>
      <Link to="/projects" className="text-sm text-brand-600 hover:text-brand-700">
        ← Back to projects
      </Link>

      {error && <ErrorState message={error} />}
      {!error && project === null && <LoadingState label="Loading project…" />}

      {!error && project && role && (
        <>
          <header className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-slate-800">{project.name}</h1>
              {project.description && (
                <p className="mt-1 max-w-2xl text-sm text-slate-500">{project.description}</p>
              )}
              <p className="mt-2 text-xs text-slate-400">
                Created {formatDateTime(project.createdAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <TrackBadge track={project.track} />
              <ProjectStatusBadge status={project.status} />
            </div>
          </header>

          <Card className="mb-6 flex items-center justify-between p-4">
            <span className="text-sm text-slate-500">Next phase</span>
            {project.nextPhase ? (
              <span className="rounded-lg bg-brand-50 px-3 py-1 text-sm font-medium text-brand-700">
                {PHASE_LABELS[project.nextPhase]}
              </span>
            ) : (
              <span className="rounded-lg bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
                All phases complete
              </span>
            )}
          </Card>

          <StartPhaseCard project={project} role={role} onChanged={load} />

          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Phase history
          </h2>

          {project.executions.length === 0 ? (
            <Card className="p-8 text-center text-sm text-slate-400">
              No phase runs yet.
            </Card>
          ) : (
            <div className="space-y-3">
              {project.executions.map((ex) => (
                <PhaseExecutionCard
                  key={ex.id}
                  execution={ex}
                  canWork={can(role, 'PHASE_SUBMIT', { phaseType: ex.phaseType })}
                  canReview={canReview}
                  onChanged={load}
                />
              ))}
            </div>
          )}

          {(role === 'PROJECT_OWNER' || role === 'SUPER_ADMIN') && (
            <TargetSecretsCard projectId={project.id} />
          )}
        </>
      )}
    </div>
  );
}

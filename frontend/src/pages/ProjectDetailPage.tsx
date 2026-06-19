/**
 * Project detail: header (name/track/status), the engine's suggested next phase,
 * and the chronological phase-execution history. Phase actions (start / generate
 * / review) arrive in FE-3 — this view is read-only.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ProjectDetail } from '../lib/types';
import { formatDateTime } from '../lib/format';
import {
  Card,
  PHASE_LABELS,
  PhaseStatusBadge,
  ProjectStatusBadge,
  TrackBadge,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/PageState';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setProject(null);
    setError(null);
    api
      .getProject(id)
      .then((data) => active && setProject(data))
      .catch((err) =>
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

  return (
    <div>
      <Link to="/projects" className="text-sm text-brand-600 hover:text-brand-700">
        ← Back to projects
      </Link>

      {error && <ErrorState message={error} />}
      {!error && project === null && <LoadingState label="Loading project…" />}

      {!error && project && (
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
                <Card key={ex.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-slate-800">
                        {PHASE_LABELS[ex.phaseType]}
                      </span>
                      <span className="text-xs text-slate-400">Run #{ex.runNumber}</span>
                    </div>
                    <PhaseStatusBadge status={ex.status} />
                  </div>
                  {ex.reviewNote && (
                    <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
                      <span className="font-medium">Review note:</span> {ex.reviewNote}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span>Started {formatDateTime(ex.startedAt)}</span>
                    {ex.completedAt && <span>Completed {formatDateTime(ex.completedAt)}</span>}
                    {ex.outputTokens != null && (
                      <span>{ex.outputTokens.toLocaleString()} output tokens</span>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

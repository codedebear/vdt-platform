/** Lists all projects with track, status, and execution count; links to detail. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ProjectListItem } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { Button, Card, ProjectStatusBadge, TrackBadge } from '../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../components/PageState';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listProjects()
      .then((data) => active && setProjects(data))
      .catch((err) => active && setError(err instanceof ApiError ? err.message : 'Failed to load projects'));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Projects</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every project managed by your virtual development team.
          </p>
        </div>
        <Link to="/projects/new">
          <Button>New project</Button>
        </Link>
      </div>

      {error && <ErrorState message={error} />}
      {!error && projects === null && <LoadingState label="Loading projects…" />}

      {!error && projects?.length === 0 && (
        <EmptyState
          title="No projects yet"
          description="Create your first project to kick off the Planner → Dev → QA → Review → Docs workflow."
          action={
            <Link to="/projects/new">
              <Button>New project</Button>
            </Link>
          }
        />
      )}

      {!error && projects && projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="block">
              <Card className="h-full p-5 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold text-slate-800">{p.name}</h2>
                  <ProjectStatusBadge status={p.status} />
                </div>
                {p.description && (
                  <p className="mt-1.5 line-clamp-2 text-sm text-slate-500">{p.description}</p>
                )}
                <div className="mt-4 flex items-center gap-2">
                  <TrackBadge track={p.track} />
                  <span className="text-xs text-slate-400">
                    {p._count.executions} phase run{p._count.executions === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="mt-3 text-xs text-slate-400">Created {formatDateTime(p.createdAt)}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

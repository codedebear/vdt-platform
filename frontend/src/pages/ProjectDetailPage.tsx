/**
 * Project detail: header (name/track/status), the engine's suggested next phase,
 * a "start phase" panel, and the chronological phase-execution history with
 * inline lifecycle actions (generate / submit / review). Actions and their
 * visibility are gated by the viewer's role; the backend re-checks every call.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ProjectDetail } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { can } from '../lib/permissions';
import { useAuth } from '../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  PHASE_LABELS,
  ProjectStatusBadge,
  Textarea,
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

  const navigate = useNavigate();
  const role = user?.role;
  const isOwner = Boolean(user && project && user.id === project.ownerId);
  const canReview = Boolean(role && can(role, 'PHASE_REVIEW', { isProjectOwner: isOwner }));
  const canManage = isOwner || role === 'SUPER_ADMIN';

  // ---- inline edit state ----
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = () => {
    if (!project) return;
    setEditName(project.name);
    setEditDesc(project.description ?? '');
    setEditError(null);
    setEditing(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setEditSaving(true);
    setEditError(null);
    try {
      await api.updateProject(project.id, {
        name: editName,
        description: editDesc || null,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Failed to save changes');
    } finally {
      setEditSaving(false);
    }
  };

  // ---- delete confirm state ----
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!project) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteProject(project.id);
      navigate('/projects');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete project');
      setDeleting(false);
    }
  };

  return (
    <div>
      <Link to="/projects" className="text-sm text-brand-600 hover:text-brand-700">
        ← Back to projects
      </Link>

      {error && <ErrorState message={error} />}
      {!error && project === null && <LoadingState label="Loading project…" />}

      {!error && project && role && (
        <>
          <header className="mt-3 mb-4">
            {editing ? (
              <form onSubmit={(e) => { void handleSaveEdit(e); }} className="space-y-3">
                <input
                  autoFocus
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xl font-semibold text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                />
                <Textarea
                  rows={2}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Description (optional)"
                />
                {editError && <Alert kind="error">{editError}</Alert>}
                <div className="flex gap-2">
                  <Button type="submit" loading={editSaving} disabled={!editName.trim()}>
                    Save
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-4">
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
                  {canManage && (
                    <>
                      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={startEdit}>
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        className="px-2 py-1 text-xs"
                        onClick={() => { setConfirmDelete(true); setDeleteError(null); }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </header>

          {confirmDelete && (
            <Card className="mb-4 border-red-200 bg-red-50 p-4">
              <p className="mb-3 text-sm text-red-700">
                This will permanently delete <strong>{project.name}</strong> and all its phase
                history. This cannot be undone.
              </p>
              {deleteError && <Alert kind="error">{deleteError}</Alert>}
              <div className="mt-3 flex gap-2">
                <Button variant="danger" loading={deleting} onClick={() => { void handleDelete(); }}>
                  Confirm Delete
                </Button>
                <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}

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

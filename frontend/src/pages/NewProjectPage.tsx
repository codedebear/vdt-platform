/** Create-project form: name, optional description, and workflow track. */
import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { Track } from '../lib/types';
import { Alert, Button, Card, Field, Input, Textarea } from '../components/ui';

const TRACKS: { value: Track; title: string; desc: string }[] = [
  {
    value: 'FULL_SDLC',
    title: 'Full SDLC',
    desc: 'Planner → Dev → QA → Code Review → Docs, with a review gate at each phase.',
  },
  {
    value: 'QA_ONLY',
    title: 'QA Only',
    desc: 'Lightweight test-scope planning, then repeatable QA cycles for existing code.',
  },
];

export default function NewProjectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [track, setTrack] = useState<Track>('FULL_SDLC');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        track,
      });
      navigate(`/projects/${project.id}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? 'You do not have permission to create projects.'
            : err.message
          : 'Failed to create project',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <Link to="/projects" className="text-sm text-brand-600 hover:text-brand-700">
          ← Back to projects
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-800">New project</h1>
      </div>

      <Card className="p-6 sm:p-8">
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && <Alert>{error}</Alert>}

          <Field label="Project name">
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Trade-In Platform"
            />
          </Field>

          <Field label="Description" hint="Optional — a short summary of the engagement.">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
            />
          </Field>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Workflow track</span>
            <div className="grid gap-3 sm:grid-cols-2">
              {TRACKS.map((t) => {
                const selected = track === t.value;
                return (
                  <button
                    type="button"
                    key={t.value}
                    onClick={() => setTrack(t.value)}
                    className={[
                      'rounded-lg border p-4 text-left transition-colors',
                      selected
                        ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                        : 'border-slate-300 hover:border-slate-400',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-semibold text-slate-800">{t.title}</span>
                    <span className="mt-1 block text-xs text-slate-500">{t.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Link to="/projects">
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </Link>
            <Button type="submit" loading={loading} disabled={!name.trim()}>
              Create project
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

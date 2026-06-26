import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { TargetEnvironment } from '../lib/types';
import { Alert, Button, Card, Field, Input, Spinner, Textarea } from './ui';

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

interface Props {
  projectId: string;
}

export default function TargetSecretsCard({ projectId }: Props) {
  /* ---- target state ---- */
  const [targetLoading, setTargetLoading] = useState(true);
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetSuccess, setTargetSuccess] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [hostAllowlist, setHostAllowlist] = useState('');

  /* ---- secrets state ---- */
  const [secretsLoading, setSecretsLoading] = useState(true);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  /* ---- load target ---- */
  const loadTarget = useCallback(async () => {
    setTargetLoading(true);
    setTargetError(null);
    try {
      const t: TargetEnvironment | null = await api.getTarget(projectId);
      if (t) {
        setLabel(t.label ?? '');
        setBaseUrl(t.baseUrl);
        setHostAllowlist(t.hostAllowlist.join(', '));
      }
    } catch (err) {
      setTargetError(err instanceof ApiError ? err.message : 'Failed to load target environment');
    } finally {
      setTargetLoading(false);
    }
  }, [projectId]);

  /* ---- load secrets ---- */
  const loadSecrets = useCallback(async () => {
    setSecretsLoading(true);
    setSecretsError(null);
    try {
      setSecretNames(await api.listSecrets(projectId));
    } catch (err) {
      setSecretsError(err instanceof ApiError ? err.message : 'Failed to load secrets');
    } finally {
      setSecretsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTarget();
    void loadSecrets();
  }, [loadTarget, loadSecrets]);

  /* ---- save target ---- */
  const handleSaveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    setTargetSaving(true);
    setTargetError(null);
    setTargetSuccess(false);
    try {
      const hosts = hostAllowlist
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      await api.setTarget(projectId, { label: label || undefined, baseUrl, hostAllowlist: hosts, isNonProd: true });
      setTargetSuccess(true);
      setTimeout(() => setTargetSuccess(false), 3000);
    } catch (err) {
      setTargetError(err instanceof ApiError ? err.message : 'Failed to save target');
    } finally {
      setTargetSaving(false);
    }
  };

  /* ---- delete secret ---- */
  const handleDeleteSecret = async (name: string) => {
    setDeletingName(name);
    setSecretsError(null);
    try {
      await api.deleteSecret(projectId, name);
      await loadSecrets();
    } catch (err) {
      setSecretsError(err instanceof ApiError ? err.message : 'Failed to delete secret');
    } finally {
      setDeletingName(null);
    }
  };

  /* ---- add secret ---- */
  const handleAddSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameError(null);
    setAddError(null);
    if (!SECRET_NAME_RE.test(newName)) {
      setNameError('Name must match [A-Z][A-Z0-9_]* (e.g. API_KEY)');
      return;
    }
    setAdding(true);
    try {
      await api.setSecret(projectId, newName, newValue);
      setNewName('');
      setNewValue('');
      await loadSecrets();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Failed to add secret');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="mt-8 space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Target &amp; Secrets
      </h2>

      {/* ---- Target Environment ---- */}
      <Card className="p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-700">Target Environment</h3>

        {targetLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : (
          <form onSubmit={(e) => { void handleSaveTarget(e); }} className="space-y-4">
            <Field label="Label" hint="Optional display name for this environment">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Staging"
                maxLength={200}
              />
            </Field>

            <Field label="Base URL" hint="Root URL of the target system (non-prod only)">
              <Input
                required
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://staging.example.com"
              />
            </Field>

            <Field
              label="Host Allowlist"
              hint="Comma-separated hostnames the worker may call. The base URL host is included automatically."
            >
              <Textarea
                rows={2}
                value={hostAllowlist}
                onChange={(e) => setHostAllowlist(e.target.value)}
                placeholder="api.example.com, auth.example.com"
              />
            </Field>

            {targetError && <Alert kind="error">{targetError}</Alert>}
            {targetSuccess && <Alert kind="info">Target environment saved.</Alert>}

            <div className="flex justify-end">
              <Button type="submit" loading={targetSaving} disabled={!baseUrl}>
                Save Target
              </Button>
            </div>
          </form>
        )}
      </Card>

      {/* ---- Secrets ---- */}
      <Card className="p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-700">Secrets</h3>
        <p className="mb-4 text-xs text-slate-400">
          Stored encrypted (AES-256-GCM). Values are never shown after saving. Use{' '}
          <code className="rounded bg-slate-100 px-1 text-slate-600">{'${VAR_NAME}'}</code> in
          step definitions to inject at execution time.
        </p>

        {secretsLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        ) : (
          <>
            {secretsError && <Alert kind="error">{secretsError}</Alert>}

            {secretNames.length === 0 ? (
              <p className="mb-4 text-sm text-slate-400">No secrets configured.</p>
            ) : (
              <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
                {secretNames.map((name) => (
                  <li key={name} className="flex items-center justify-between px-3 py-2">
                    <code className="text-sm font-mono text-slate-700">{name}</code>
                    <Button
                      variant="danger"
                      className="px-2 py-1 text-xs"
                      loading={deletingName === name}
                      onClick={() => { void handleDeleteSecret(name); }}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={(e) => { void handleAddSecret(e); }} className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Add Secret
              </h4>

              <Field label="Name" hint="Uppercase letters, digits, underscores — e.g. API_KEY">
                <Input
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value.toUpperCase()); setNameError(null); }}
                  placeholder="API_KEY"
                  maxLength={100}
                />
                {nameError && <span className="mt-1 block text-xs text-red-600">{nameError}</span>}
              </Field>

              <Field label="Value" hint="Will not be shown again after saving">
                <Input
                  type="password"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="••••••••"
                  maxLength={10000}
                />
              </Field>

              {addError && <Alert kind="error">{addError}</Alert>}

              <div className="flex justify-end">
                <Button type="submit" loading={adding} disabled={!newName || !newValue}>
                  Add Secret
                </Button>
              </div>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}

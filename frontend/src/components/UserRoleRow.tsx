/**
 * One row of the user-administration table: identity, a role <select>, and
 * save/reset controls that appear only when the role has been changed.
 *
 * The acting admin's own row is locked (you cannot change your own role — the
 * backend rejects it to prevent self-lockout); other safety rules (e.g. demoting
 * the last super admin) are enforced server-side and surfaced inline on failure.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AdminUser, Role } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { Badge, Button, ROLE_LABELS, ROLE_ORDER, Select } from './ui';

interface UserRoleRowProps {
  user: AdminUser;
  /** True when this row is the signed-in admin (own role is not editable). */
  isSelf: boolean;
  /** Called with the updated user after a successful role change. */
  onSaved: (updated: AdminUser) => void;
}

export default function UserRoleRow({ user, isSelf, onSaved }: UserRoleRowProps) {
  const [role, setRole] = useState<Role>(user.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = role !== user.role;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateUserRole(user.id, role);
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the role');
      setRole(user.role); // revert the select to the persisted value
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-800">{user.name}</span>
          {isSelf && (
            <Badge className="bg-brand-100 text-brand-700">You</Badge>
          )}
        </div>
        <div className="text-xs text-slate-400">{user.email}</div>
      </td>

      <td className="px-4 py-3">
        <Select
          value={role}
          disabled={isSelf || busy}
          onChange={(e) => setRole(e.target.value as Role)}
          className="max-w-[12rem]"
        >
          {ROLE_ORDER.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        {isSelf && (
          <p className="mt-1 text-xs text-slate-400">
            Ask another super admin to change your role.
          </p>
        )}
      </td>

      <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
        {formatDateTime(user.createdAt)}
      </td>

      <td className="px-4 py-3 text-right">
        {dirty && !isSelf && (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setRole(user.role)}>
              Reset
            </Button>
            <Button variant="primary" loading={busy} disabled={busy} onClick={save}>
              Save
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

/**
 * User administration (SUPER_ADMIN only): list every user and change their
 * global role. The route is reachable only to super admins (the nav link is
 * hidden otherwise and this page shows a not-authorized notice as a backstop);
 * the backend re-checks USER_MANAGE on every request.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AdminUser } from '../lib/types';
import { can } from '../lib/permissions';
import { useAuth } from '../auth/AuthContext';
import { Card } from '../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../components/PageState';
import UserRoleRow from '../components/UserRoleRow';

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = Boolean(user && can(user.role, 'USER_MANAGE'));

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    setUsers(null);
    setError(null);
    api
      .listUsers()
      .then((data) => active && setUsers(data))
      .catch(
        (err) =>
          active &&
          setError(err instanceof ApiError ? err.message : 'Failed to load users'),
      );
    return () => {
      active = false;
    };
  }, [isAdmin]);

  // Replace the saved user in place, keeping list order stable.
  function handleSaved(updated: AdminUser): void {
    setUsers((prev) =>
      prev ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev,
    );
  }

  if (!isAdmin) {
    return (
      <EmptyState
        title="Not authorized"
        description="User management is available to super admins only."
      />
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-800">Users</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage team members and their global roles.
        </p>
      </header>

      {error && <ErrorState message={error} />}
      {!error && users === null && <LoadingState label="Loading users…" />}

      {!error && users && users.length === 0 && (
        <EmptyState title="No users" description="No users have registered yet." />
      )}

      {!error && users && users.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Joined</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRoleRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === user?.id}
                    onSaved={handleSaved}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

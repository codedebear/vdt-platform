/** Centered card layout shared by the login and register pages. */
import type { ReactNode } from 'react';
import { Card } from '../components/ui';

export default function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">
            V
          </div>
          <h1 className="text-xl font-semibold text-slate-800">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>
        <Card className="p-6 sm:p-8">{children}</Card>
      </div>
    </div>
  );
}

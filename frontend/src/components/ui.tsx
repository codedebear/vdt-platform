/**
 * Small, dependency-free UI primitives styled with Tailwind. Kept in one file
 * to keep the component surface lean ("beautiful but simple").
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type {
  PhaseStatus,
  PhaseType,
  ProjectStatus,
  Role,
  Track,
} from '../lib/types';

function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus:ring-brand-500',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus:ring-brand-500',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 focus:ring-brand-500',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

const FIELD_BASE =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD_BASE, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(FIELD_BASE, 'resize-y', props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(FIELD_BASE, 'bg-white', props.className)} />;
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Spinner                                                                     */
/* -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin text-current', className ?? 'h-5 w-5')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Alert                                                                       */
/* -------------------------------------------------------------------------- */

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info'; children: ReactNode }) {
  const styles =
    kind === 'error'
      ? 'border-red-200 bg-red-50 text-red-700'
      : 'border-brand-100 bg-brand-50 text-brand-700';
  return (
    <div className={cx('rounded-lg border px-3 py-2 text-sm', styles)} role="alert">
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        className,
      )}
    >
      {children}
    </span>
  );
}

const PHASE_STATUS_STYLES: Record<PhaseStatus, string> = {
  IN_PROGRESS: 'bg-amber-100 text-amber-700',
  QUEUED: 'bg-indigo-100 text-indigo-700',
  AWAITING_REVIEW: 'bg-blue-100 text-blue-700',
  APPROVED: 'bg-emerald-100 text-emerald-700',
  CHANGES_REQUESTED: 'bg-orange-100 text-orange-700',
  FAILED: 'bg-red-100 text-red-700',
};

export function PhaseStatusBadge({ status }: { status: PhaseStatus }) {
  return <Badge className={PHASE_STATUS_STYLES[status]}>{labelize(status)}</Badge>;
}

const PROJECT_STATUS_STYLES: Record<ProjectStatus, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  COMPLETED: 'bg-slate-200 text-slate-600',
  ARCHIVED: 'bg-slate-100 text-slate-500',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge className={PROJECT_STATUS_STYLES[status]}>{labelize(status)}</Badge>;
}

export function TrackBadge({ track }: { track: Track }) {
  const styles =
    track === 'FULL_SDLC' ? 'bg-brand-100 text-brand-700' : 'bg-violet-100 text-violet-700';
  return <Badge className={styles}>{track === 'FULL_SDLC' ? 'Full SDLC' : 'QA Only'}</Badge>;
}

/* -------------------------------------------------------------------------- */
/* Label helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Turn an ENUM_VALUE into a "Title Case" label. */
export function labelize(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const PHASE_LABELS: Record<PhaseType, string> = {
  PLANNER: 'Planner',
  DEV: 'Dev',
  QA: 'QA',
  CODE_REVIEW: 'Code Review',
  DOCS: 'Docs',
};

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  PROJECT_OWNER: 'Project Owner',
  BA: 'Business Analyst',
  SA: 'Solution Architect',
  QA: 'QA Engineer',
  OPERATION: 'Operation',
};

/** All roles in a stable, privilege-descending display order. */
export const ROLE_ORDER: Role[] = [
  'SUPER_ADMIN',
  'PROJECT_OWNER',
  'BA',
  'SA',
  'QA',
  'OPERATION',
];

/**
 * Thin typed HTTP client for the VDT Platform API.
 *
 * - Reads the JWT from an injected getter so it stays in sync with AuthContext
 *   without creating an import cycle.
 * - Parses the backend's `{ error: string }` envelope into a typed ApiError.
 * - Emits a callback on 401 so the app can force a logout on token expiry.
 */
import type {
  AdminUser,
  AuthResponse,
  CreateProjectInput,
  PhaseExecution,
  Project,
  ProjectDetail,
  ProjectListItem,
  ReviewPhaseInput,
  Role,
  StartPhaseInput,
} from './types';

/** Base URL for API calls; empty string means same-origin relative paths. */
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

/** An error carrying the HTTP status and the server's message. */
export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type TokenGetter = () => string | null;
type UnauthorizedHandler = () => void;

let getToken: TokenGetter = () => null;
let onUnauthorized: UnauthorizedHandler = () => {};

/** Wires the client to the auth layer. Called once by AuthProvider. */
export function configureApi(opts: {
  getToken: TokenGetter;
  onUnauthorized: UnauthorizedHandler;
}): void {
  getToken = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** When true, a 401 will NOT trigger the global logout (e.g. login attempts). */
  skipAuthRedirect?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipAuthRedirect = false } = opts;
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Network error — could not reach the server', 0);
  }

  if (res.status === 401 && !skipAuthRedirect) {
    onUnauthorized();
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return payload as T;
}

/** Typed endpoint wrappers. */
export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      skipAuthRedirect: true,
    }),

  register: (name: string, email: string, password: string) =>
    request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: { name, email, password },
      skipAuthRedirect: true,
    }),

  listProjects: () => request<ProjectListItem[]>('/api/projects'),

  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),

  createProject: (input: CreateProjectInput) =>
    request<Project>('/api/projects', { method: 'POST', body: input }),

  /** Start a new run of a phase on a project. */
  startPhase: (projectId: string, input: StartPhaseInput) =>
    request<PhaseExecution>(`/api/projects/${projectId}/phases`, {
      method: 'POST',
      body: input,
    }),

  /** Generate a run's output via Claude (moves it to AWAITING_REVIEW). */
  generatePhase: (executionId: string) =>
    request<PhaseExecution>(`/api/phases/${executionId}/generate`, {
      method: 'POST',
    }),

  /** Submit a run's output manually (override of AI generation). */
  submitOutput: (executionId: string, output: string) =>
    request<PhaseExecution>(`/api/phases/${executionId}/output`, {
      method: 'POST',
      body: { output },
    }),

  /** Approve or request changes on a run awaiting review. */
  reviewPhase: (executionId: string, input: ReviewPhaseInput) =>
    request<PhaseExecution>(`/api/phases/${executionId}/review`, {
      method: 'POST',
      body: input,
    }),

  /** List all users (SUPER_ADMIN only). */
  listUsers: () => request<AdminUser[]>('/api/users'),

  /** Change a user's global role (SUPER_ADMIN only). */
  updateUserRole: (userId: string, role: Role) =>
    request<AdminUser>(`/api/users/${userId}/role`, {
      method: 'PATCH',
      body: { role },
    }),
};

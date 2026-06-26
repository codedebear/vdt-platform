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
  AppConfig,
  AttachmentMeta,
  AuthResponse,
  CreateProjectInput,
  GenerationMode,
  PhaseExecution,
  Project,
  ProjectDetail,
  ProjectListItem,
  ReviewPhaseInput,
  Role,
  StartPhaseInput,
  TargetEnvironment,
  TestRun,
  UatrSignOffInput,
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

  // For multipart uploads pass the FormData through untouched: the browser sets
  // the multipart Content-Type (with boundary) itself, so we must NOT set it.
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
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

/** Streams an authenticated binary endpoint to a browser download (blob + <a>). */
async function downloadBlobFile(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new ApiError('Network error — could not reach the server', 0);
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (j && j.error) message = String(j.error);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  const blob = await res.blob();
  const dispo = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(dispo);
  const filename = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

  /**
   * Generate a run's output via Claude.
   * - `sync` (default): runs now and returns the run AWAITING_REVIEW (HTTP 200).
   * - `batch`: submits to the Anthropic Batch API (~50% cheaper) and returns the
   *   run QUEUED (HTTP 202); a backend poller later moves it to AWAITING_REVIEW
   *   or FAILED. The request body always sends an explicit mode so the contract
   *   is unambiguous.
   */
  generatePhase: (executionId: string, mode: GenerationMode = 'sync') =>
    request<PhaseExecution>(`/api/phases/${executionId}/generate`, {
      method: 'POST',
      body: { mode },
    }),

  /** Submit a run's output manually (override of AI generation). */
  submitOutput: (executionId: string, output: string) =>
    request<PhaseExecution>(`/api/phases/${executionId}/output`, {
      method: 'POST',
      body: { output },
    }),

  /** Fetch a single run (metadata only) — used to cheaply poll QUEUED runs. */
  getPhase: (executionId: string) =>
    request<PhaseExecution>(`/api/phases/${executionId}`),

  /** Approve or request changes on a run awaiting review. */
  reviewPhase: (executionId: string, input: ReviewPhaseInput) =>
    request<PhaseExecution>(`/api/phases/${executionId}/review`, {
      method: 'POST',
      body: input,
    }),

  /** Public runtime config (attachment limits + accepted types). */
  getConfig: () => request<AppConfig>('/api/config'),

  /** List the metadata of a run's attachments (no file bytes). */
  listAttachments: (executionId: string) =>
    request<AttachmentMeta[]>(`/api/phases/${executionId}/attachments`),

  /**
   * Upload one or more files to a run (multipart field `files`). Returns the
   * run's full attachment list (newest included). Only allowed while the run is
   * IN_PROGRESS or CHANGES_REQUESTED and for the phase's worker role.
   */
  uploadAttachments: (executionId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    return request<AttachmentMeta[]>(`/api/phases/${executionId}/attachments`, {
      method: 'POST',
      body: form,
    });
  },

  /** Delete one attachment from a run. */
  deleteAttachment: (executionId: string, attachmentId: string) =>
    request<void>(`/api/phases/${executionId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    }),

  /* ---- Staged QA execution (QAX-2..5) ------------------------------------ */

  /** Fetch a phase's QA run (scenarios → steps → results), or null if none. */
  getTestRun: (executionId: string) =>
    request<{ testRun: TestRun | null }>(`/api/phases/${executionId}/qa`).then(
      (r) => r.testRun,
    ),

  /** AI-draft (or feedback-regenerate) the QA scenarios. */
  generateScenarios: (executionId: string, feedback?: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/scenarios/generate`, {
      method: 'POST',
      body: feedback ? { feedback } : {},
    }).then((r) => r.testRun),

  /** Confirm the drafted scenarios → STEPS_DRAFT. */
  confirmScenarios: (executionId: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/scenarios/confirm`, {
      method: 'POST',
    }).then((r) => r.testRun),

  /** AI-draft (or feedback-regenerate) the steps for the confirmed scenarios. */
  generateSteps: (executionId: string, feedback?: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/steps/generate`, {
      method: 'POST',
      body: feedback ? { feedback } : {},
    }).then((r) => r.testRun),

  /** Confirm + compile the steps into artifacts → COMPILED. */
  confirmSteps: (executionId: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/steps/confirm`, {
      method: 'POST',
    }).then((r) => r.testRun),

  /** Recompile artifacts (optional feedback), staying at COMPILED. */
  recompileArtifacts: (executionId: string, feedback?: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/artifacts/recompile`, {
      method: 'POST',
      body: feedback ? { feedback } : {},
    }).then((r) => r.testRun),

  /** Start executing the compiled run → EXECUTING. */
  startQaRun: (executionId: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/run/start`, {
      method: 'POST',
    }).then((r) => r.testRun),

  /**
   * Start a Full Retest: clone this reviewed/signed-off run's compiled test
   * cases into a brand-new QA run (lands at COMPILED, 0 Claude tokens). Returns
   * the new run; the caller navigates to its executionId.
   */
  retestQaRun: (executionId: string) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/retest`, {
      method: 'POST',
    }).then((r) => r.testRun),

  /** Move the run back to an earlier stage (request changes within the flow). */
  reviseQaStage: (executionId: string, targetStage: TestRun['stage']) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/revise`, {
      method: 'POST',
      body: { targetStage },
    }).then((r) => r.testRun),

  /** Sign off reviewed results → EXPORTED, optionally stamping Amendment metadata. */
  confirmResults: (executionId: string, signOff?: UatrSignOffInput) =>
    request<{ testRun: TestRun }>(`/api/phases/${executionId}/qa/results/confirm`, {
      method: 'POST',
      body: signOff ?? {},
    }).then((r) => r.testRun),

  /**
   * Download the UATR .xlsx for a run. The export is binary, so this bypasses the
   * JSON `request` helper: it fetches the blob with the auth header and triggers a
   * browser download from the Content-Disposition filename.
   */
  /**
   * Fetches a step's stored evidence (a BROWSER screenshot or an HTTP capture) as
   * a blob + MIME. Auth is sent via the Authorization header (an <img src> can't),
   * so callers build an object URL for images or read .text() for HTTP captures.
   */
  getStepEvidence: async (
    executionId: string,
    stepId: string,
  ): Promise<{ blob: Blob; mime: string }> => {
    const token = getToken();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/phases/${executionId}/qa/steps/${stepId}/evidence`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new ApiError('Network error — could not reach the server', 0);
    }
    if (res.status === 401) onUnauthorized();
    if (!res.ok) {
      let message = `Could not load evidence (${res.status})`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && j.error) message = String(j.error);
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(message, res.status);
    }
    const blob = await res.blob();
    const mime = res.headers.get('Content-Type') ?? blob.type ?? 'application/octet-stream';
    return { blob, mime };
  },

  downloadUatr: async (executionId: string): Promise<void> => {
    const token = getToken();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/phases/${executionId}/qa/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new ApiError('Network error — could not reach the server', 0);
    }
    if (res.status === 401) onUnauthorized();
    if (!res.ok) {
      let message = `Export failed (${res.status})`;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (j && j.error) message = String(j.error);
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(message, res.status);
    }
    const blob = await res.blob();
    const dispo = res.headers.get('Content-Disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(dispo);
    const filename = match ? match[1] : `UATR_${executionId}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /** Downloads the UATR PDF "Test Result Report" (full info + per-step evidence). */
  downloadUatrReport: (executionId: string): Promise<void> =>
    downloadBlobFile(`/api/phases/${executionId}/qa/report.pdf`, `UATR_${executionId}.pdf`),

  /* ---- Target environment & secrets (E-3) --------------------------------- */

  getTarget: (projectId: string) =>
    request<{ target: TargetEnvironment | null }>(`/api/projects/${projectId}/target`).then(
      (r) => r.target,
    ),

  setTarget: (
    projectId: string,
    input: { label?: string; baseUrl: string; hostAllowlist: string[]; isNonProd: boolean },
  ) =>
    request<{ target: TargetEnvironment }>(`/api/projects/${projectId}/target`, {
      method: 'PUT',
      body: input,
    }).then((r) => r.target),

  listSecrets: (projectId: string) =>
    request<{ names: string[] }>(`/api/projects/${projectId}/secrets`).then((r) => r.names),

  setSecret: (projectId: string, name: string, value: string) =>
    request<{ name: string }>(`/api/projects/${projectId}/secrets`, {
      method: 'PUT',
      body: { name, value },
    }),

  deleteSecret: (projectId: string, name: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
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

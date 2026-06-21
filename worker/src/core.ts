/**
 * Pure execution core for the VDT QA worker (QAX-3C).
 *
 * No network or process I/O — every function here is deterministic so it can be
 * unit-tested directly. The runtime layer (runner.ts / index.ts) calls these to
 * resolve secrets into an artifact, enforce the host allowlist, fire the request,
 * and decide PASS/FAIL from the assertions.
 */

/** A resilient locator (mirrors the backend artifact contract; browser only). */
export interface Selector {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
  css?: string;
}

export interface HttpArtifact {
  kind: 'HTTP';
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  };
  assertions: HttpAssertion[];
}

export type HttpAssertion =
  | { type: 'statusCode'; equals: number }
  | { type: 'jsonPath'; path: string; equals?: unknown; exists?: boolean }
  | { type: 'bodyContains'; text: string }
  | { type: 'headerContains'; name: string; text: string };

/** Result of resolving `${VAR}` placeholders, with any unresolved names. */
export interface Resolved<T> {
  value: T;
  missing: string[];
}

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/**
 * Recursively replaces `${VAR}` placeholders in all string values of `input`
 * using `secrets`. Records the names of any placeholders with no matching secret
 * (the caller fails the step rather than sending a half-resolved request).
 */
export function resolvePlaceholders<T>(input: T, secrets: Record<string, string>): Resolved<T> {
  const missing = new Set<string>();

  const walk = (val: unknown): unknown => {
    if (typeof val === 'string') {
      return val.replace(PLACEHOLDER, (_m, name: string) => {
        if (Object.prototype.hasOwnProperty.call(secrets, name)) {
          return secrets[name];
        }
        missing.add(name);
        return `\${${name}}`;
      });
    }
    if (Array.isArray(val)) {
      return val.map(walk);
    }
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = walk(v);
      }
      return out;
    }
    return val;
  };

  return { value: walk(input) as T, missing: [...missing] };
}

/** Builds the absolute request URL from a base URL, relative path and query. */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

/** Whether a URL's host is permitted by the allowlist (exact host match). */
export function isHostAllowed(urlString: string, hostAllowlist: string[]): boolean {
  let host: string;
  try {
    host = new URL(urlString).host;
  } catch {
    return false;
  }
  return hostAllowlist.includes(host);
}

/**
 * Resolves a minimal JSONPath against a value, returning every matched node.
 * Supported subset (what the compiler emits): `$`, `$.a`, `$.a.b`, `$[0]`,
 * `$[0].a`, `$[*]`, `$[*].a`. Anything unmatched yields fewer/zero results.
 */
export function queryJsonPath(root: unknown, path: string): unknown[] {
  if (path === '$' || path === '') {
    return [root];
  }
  // Tokenise: .name  |  [index]  |  [*]
  const tokens: Array<{ kind: 'field'; name: string } | { kind: 'index'; i: number } | { kind: 'wild' }> = [];
  const body = path.startsWith('$') ? path.slice(1) : path;
  const re = /\.([A-Za-z_][\w-]*)|\[(\d+)\]|\[\*\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body)) !== null) {
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) tokens.push({ kind: 'field', name: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'index', i: Number(m[2]) });
    else tokens.push({ kind: 'wild' });
  }
  if (consumed !== body.length) {
    return []; // unparseable remainder → no match
  }

  let current: unknown[] = [root];
  for (const tok of tokens) {
    const next: unknown[] = [];
    for (const node of current) {
      if (tok.kind === 'field') {
        if (node && typeof node === 'object' && !Array.isArray(node) && tok.name in (node as object)) {
          next.push((node as Record<string, unknown>)[tok.name]);
        }
      } else if (tok.kind === 'index') {
        if (Array.isArray(node) && tok.i < node.length) next.push(node[tok.i]);
      } else {
        if (Array.isArray(node)) next.push(...node);
        else if (node && typeof node === 'object') next.push(...Object.values(node));
      }
    }
    current = next;
  }
  return current;
}

/** The observed HTTP response a worker passes to the assertion evaluator. */
export interface ResponseView {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  json: unknown; // parsed body, or undefined if not JSON
  jsonOk: boolean;
}

/** Outcome of evaluating a step's assertions. */
export interface AssertionResult {
  passed: boolean;
  failures: string[];
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Evaluates all HTTP assertions against a response. PASS only if every assertion
 * holds; each failure is described for the result's actualResult / remark.
 */
export function evaluateHttpAssertions(
  assertions: HttpAssertion[],
  res: ResponseView,
): AssertionResult {
  const failures: string[] = [];

  for (const a of assertions) {
    switch (a.type) {
      case 'statusCode':
        if (res.status !== a.equals) {
          failures.push(`expected status ${a.equals}, got ${res.status}`);
        }
        break;
      case 'bodyContains':
        if (!res.bodyText.includes(a.text)) {
          failures.push(`body does not contain "${a.text}"`);
        }
        break;
      case 'headerContains': {
        const actual = res.headers[a.name.toLowerCase()];
        if (actual === undefined) {
          failures.push(`header "${a.name}" is missing`);
        } else if (!actual.toLowerCase().includes(a.text.toLowerCase())) {
          failures.push(`header "${a.name}" ("${actual}") does not contain "${a.text}"`);
        }
        break;
      }
      case 'jsonPath': {
        if (!res.jsonOk) {
          failures.push(`response is not JSON; cannot evaluate ${a.path}`);
          break;
        }
        const matches = queryJsonPath(res.json, a.path).filter((v) => v !== undefined);
        if (a.exists !== undefined) {
          const exists = matches.length > 0;
          if (exists !== a.exists) {
            failures.push(`${a.path} exists=${exists}, expected ${a.exists}`);
          }
        }
        if (a.equals !== undefined) {
          if (matches.length === 0 || !matches.some((v) => deepEqual(v, a.equals))) {
            failures.push(`${a.path} did not equal ${JSON.stringify(a.equals)}`);
          }
        }
        break;
      }
      default:
        failures.push(`unknown assertion type`);
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Project-level QA execution configuration (QAX-3A): the non-production target
 * environment the compiled tests run against, and the encrypted secrets that
 * resolve `${VAR}` placeholders at execute time.
 *
 * Secrets are stored AES-256-GCM encrypted (domain/crypto) with a master key from
 * env; the plaintext is never returned by these reads (only secret *names* are
 * listed) and never logged. Configuration is restricted to the project owner or a
 * SUPER_ADMIN, mirroring the budget endpoint.
 */
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { Role } from '../domain/permissions';
import { encrypt, decrypt, keyFromString } from '../domain/crypto';

/** The authenticated user performing an action. */
export interface Actor {
  id: string;
  role: Role;
}

/** A placeholder/secret name: uppercase letters, digits and underscore (matches `${VAR}`). */
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Returns the configured 32-byte vault key, or a 503 if unset/misconfigured. */
function secretsKey(): Buffer {
  if (!env.secretsKey) {
    throw new AppError('Secrets vault is not configured (SECRETS_KEY is missing)', 503);
  }
  try {
    return keyFromString(env.secretsKey);
  } catch (err) {
    throw new AppError(`Secrets vault key is invalid: ${(err as Error).message}`, 503);
  }
}

/** Loads a project and asserts the actor may manage it (owner or SUPER_ADMIN). */
async function assertProjectManager(projectId: string, actor: Actor): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true },
  });
  if (!project) {
    throw new AppError('Project not found', 404);
  }
  if (actor.role !== 'SUPER_ADMIN' && project.ownerId !== actor.id) {
    throw new AppError('Only the project owner or a super admin may manage QA configuration', 403);
  }
}

/** Fields accepted when setting a project's target environment. */
export interface SetTargetInput {
  label?: string;
  baseUrl: string;
  hostAllowlist: string[];
  isNonProd: boolean;
}

/** Returns the project's target environment, or null if not configured. */
export async function getTarget(projectId: string, actor: Actor) {
  await assertProjectManager(projectId, actor);
  return prisma.targetEnvironment.findUnique({ where: { projectId } });
}

/**
 * Creates or replaces the project's target environment. Enforces a valid base URL,
 * a non-empty host allowlist that includes the base URL's host, and (v1) that the
 * target is flagged non-production.
 * @throws {AppError} 404/403 per guards, 422 on invalid input.
 */
export async function setTarget(projectId: string, actor: Actor, input: SetTargetInput) {
  await assertProjectManager(projectId, actor);

  if (!input.isNonProd) {
    throw new AppError('Only non-production targets are supported (set isNonProd = true)', 422);
  }

  let baseHost: string;
  try {
    baseHost = new URL(input.baseUrl).host;
  } catch {
    throw new AppError('baseUrl must be a valid absolute URL (e.g. https://staging.example.com)', 422);
  }

  const allowlist = Array.from(new Set(input.hostAllowlist.map((h) => h.trim()).filter(Boolean)));
  if (allowlist.length === 0) {
    throw new AppError('hostAllowlist must contain at least one host', 422);
  }
  // The base URL's own host must be allowed, otherwise no test could run.
  if (!allowlist.includes(baseHost)) {
    allowlist.push(baseHost);
  }

  return prisma.targetEnvironment.upsert({
    where: { projectId },
    create: {
      projectId,
      label: input.label,
      baseUrl: input.baseUrl,
      hostAllowlist: allowlist,
      isNonProd: true,
    },
    update: {
      label: input.label,
      baseUrl: input.baseUrl,
      hostAllowlist: allowlist,
      isNonProd: true,
    },
  });
}

/** Lists the project's secret *names* only — never the values. */
export async function listSecretNames(projectId: string, actor: Actor): Promise<string[]> {
  await assertProjectManager(projectId, actor);
  const secrets = await prisma.secret.findMany({
    where: { projectId },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return secrets.map((s) => s.name);
}

/**
 * Creates or updates a project secret. The value is AES-256-GCM encrypted before
 * storage; only the name is returned.
 * @throws {AppError} 404/403 per guards, 422 on a bad name, 503 if no vault key.
 */
export async function setSecret(
  projectId: string,
  actor: Actor,
  name: string,
  value: string,
): Promise<{ name: string }> {
  await assertProjectManager(projectId, actor);
  if (!SECRET_NAME_RE.test(name)) {
    throw new AppError(
      'Secret name must be uppercase letters, digits and underscore, starting with a letter (e.g. TEST_USER)',
      422,
    );
  }
  if (value.length === 0) {
    throw new AppError('Secret value must not be empty', 422);
  }

  const enc = encrypt(value, secretsKey());
  await prisma.secret.upsert({
    where: { projectId_name: { projectId, name } },
    create: { projectId, name, ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag },
    update: { ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag },
  });
  return { name };
}

/** Deletes a project secret by name. Idempotent (404 only if the project is missing). */
export async function deleteSecret(projectId: string, actor: Actor, name: string): Promise<void> {
  await assertProjectManager(projectId, actor);
  await prisma.secret
    .delete({ where: { projectId_name: { projectId, name } } })
    .catch(() => undefined);
}

/**
 * Decrypts all of a project's secrets into a `{ name: value }` map for the
 * execution worker to resolve `${VAR}` placeholders at run time. No user-facing
 * authorization here — the only caller is the worker service, which is gated by
 * the worker token. Returns an empty map if the project has no secrets.
 * @throws {AppError} 503 if the vault key is unset/invalid.
 */
export async function getDecryptedSecrets(projectId: string): Promise<Record<string, string>> {
  const secrets = await prisma.secret.findMany({ where: { projectId } });
  if (secrets.length === 0) {
    return {};
  }
  const key = secretsKey();
  const out: Record<string, string> = {};
  for (const s of secrets) {
    out[s.name] = decrypt({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.authTag }, key);
  }
  return out;
}

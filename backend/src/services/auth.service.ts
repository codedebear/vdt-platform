/**
 * Password hashing and JWT issuance/verification utilities used by the auth flow.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { Role } from '../domain/permissions';

const SALT_ROUNDS = 12;

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

/**
 * Hashes a plaintext password using bcrypt.
 * @param plainPassword - The user-supplied plaintext password.
 * @returns The bcrypt hash to persist.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Verifies a plaintext password against a stored bcrypt hash.
 * @param plainPassword - The user-supplied plaintext password.
 * @param passwordHash - The stored bcrypt hash.
 * @returns True if the password matches the hash.
 */
export async function verifyPassword(
  plainPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainPassword, passwordHash);
}

/**
 * Issues a signed JWT for an authenticated user.
 * @param payload - The claims to embed in the token.
 * @returns A signed JWT string.
 */
export function generateToken(payload: JwtPayload): string {
  const options: jwt.SignOptions = {
    expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.jwtSecret, options);
}

/**
 * Verifies and decodes a JWT.
 * @param token - The JWT to verify.
 * @returns The decoded payload.
 * @throws {jwt.JsonWebTokenError} If the token is invalid or expired.
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwtSecret) as JwtPayload;
}

/**
 * Unit tests for password hashing and JWT helpers. Requires no database.
 */
import {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
} from '../src/services/auth.service';

describe('auth.service', () => {
  it('hashes and verifies a password correctly', async () => {
    const hash = await hashPassword('correct-password');
    await expect(verifyPassword('correct-password', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('generates a token that verifies back to the same payload', () => {
    const token = generateToken({ sub: 'user-1', email: 'test@example.com', role: 'MEMBER' });
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe('user-1');
    expect(decoded.email).toBe('test@example.com');
    expect(decoded.role).toBe('MEMBER');
  });
});

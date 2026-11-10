import { parseDuration } from '../common/utils/tokens';

/**
 * Fails startup on missing or unsafe configuration instead of falling back
 * to insecure defaults.
 */
export function validateEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const get = (key: string) => (typeof env[key] === 'string' ? env[key] : '');

  if (get('JWT_SECRET').length < 32) {
    errors.push('JWT_SECRET must be set and at least 32 characters long');
  }
  for (const key of ['JWT_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN']) {
    if (!get(key)) continue;
    try {
      parseDuration(get(key));
    } catch (e) {
      errors.push(`${key}: ${(e as Error).message}`);
    }
  }
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME', 'FRONTEND_URL']) {
    if (!get(key)) errors.push(`${key} must be set`);
  }
  if (get('NODE_ENV') === 'production' && !get('MAIL_HOST')) {
    errors.push('MAIL_HOST must be set in production');
  }
  if (
    get('NODE_ENV') === 'production' &&
    get('SECRETS_ENCRYPTION_KEY').length < 32
  ) {
    errors.push(
      'SECRETS_ENCRYPTION_KEY must be set and at least 32 characters long (encrypts provider credentials)',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n - ${errors.join('\n - ')}`,
    );
  }
  return env;
}

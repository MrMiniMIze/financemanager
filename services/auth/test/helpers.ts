import type { Env } from '../src/env';
import { AuthService } from '../src/services/auth-service';
import { InMemoryAuthRepository } from './in-memory-auth-repository';
import { RecordingEmailService } from './stubs';

export function createAuthServiceForTest(overrides: Partial<Env> = {}) {
  const repository = new InMemoryAuthRepository();
  const emailService = new RecordingEmailService();

  const env: Env = {
    NODE_ENV: 'test',
    PORT: 4001,
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    JWT_ACCESS_SECRET: 'test-access-secret-should-be-long',
    JWT_REFRESH_SECRET: 'test-refresh-secret-should-be-long',
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
    EMAIL_VERIFICATION_TOKEN_TTL_HOURS: 24,
    PASSWORD_RESET_TOKEN_TTL_MINUTES: 60,
    COOKIE_DOMAIN: undefined,
    COOKIE_SECURE: false,
    RATE_LIMIT_MAX: 200,
    RATE_LIMIT_WINDOW_MINUTES: 1,
    isProduction: false,
    MFA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    MFA_TOTP_ISSUER: 'FinanceManager-Test',
    MFA_CHALLENGE_TTL_SECONDS: 600,
    MFA_MAX_ATTEMPTS: 5,
    MFA_REMEMBER_DEVICE_DAYS: 30,
    MFA_REMEMBER_COOKIE_NAME: 'fm_mfa_remember',
    ...overrides,
  };

  const service = new AuthService({
    repository,
    env,
    emailService,
  });

  return { service, repository, emailService, env };
}

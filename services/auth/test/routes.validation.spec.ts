import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import validationPlugin from '../src/plugins/validation';
import { authRoutes } from '../src/routes/auth-routes';
import type { Env } from '../src/env';
import type { AuthTokens } from '../src/services/auth-service';
import type { AuthUser } from '../src/domain/models';

function buildTestEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 4001,
    HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://localhost:5432/test',
    JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh',
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
    EMAIL_VERIFICATION_TOKEN_TTL_HOURS: 24,
    PASSWORD_RESET_TOKEN_TTL_MINUTES: 60,
    COOKIE_DOMAIN: undefined,
    COOKIE_SECURE: false,
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MINUTES: 1,
    MFA_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    MFA_TOTP_ISSUER: 'FinanceManager',
    MFA_CHALLENGE_TTL_SECONDS: 600,
    MFA_MAX_ATTEMPTS: 5,
    MFA_REMEMBER_DEVICE_DAYS: 30,
    MFA_REMEMBER_COOKIE_NAME: 'fm_mfa_remember',
    isProduction: false,
  };
}

function createAuthArtifacts() {
  const now = Date.now();
  const user: AuthUser = {
    id: 'user-123',
    email: 'user@example.com',
    status: 'active',
    planTier: 'free',
    roles: ['user'],
    emailVerifiedAt: null,
    createdAt: new Date(now - 1_000),
    updatedAt: new Date(now - 1_000),
    lastLoginAt: null,
    timezone: null,
    firstName: null,
    lastName: null,
    mfa: null,
  };

  const tokens: AuthTokens = {
    accessToken: 'access-token',
    accessTokenExpiresAt: new Date(now + 60_000),
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: new Date(now + 120_000),
  };

  return { user, tokens };
}

function createAuthServiceStub(user: AuthUser, tokens: AuthTokens) {
  return {
    signup: vi.fn(async () => ({
      user,
      tokens,
      requiresEmailVerification: true,
      debug: { emailVerificationToken: 'debug-token' },
    })),
    login: vi.fn(async () => ({
      type: 'authenticated' as const,
      user,
      tokens,
      emailVerified: true,
    })),
    refreshSession: vi.fn(async () => ({ user, tokens })),
    requestPasswordReset: vi.fn(async () => ({ requested: true })),
    resetPassword: vi.fn(async () => ({ user })),
    verifyEmail: vi.fn(async () => ({ user })),
    startMfaEnrollment: vi.fn(async () => ({
      challengeId: 'challenge-id',
      secret: 'secret',
      otpauthUrl: 'otpauth://totp/test',
      qrCodeSvg: '<svg></svg>',
      expiresAt: new Date(Date.now() + 300_000),
    })),
    verifyMfaChallenge: vi.fn(async () => ({
      type: 'setup' as const,
      backupCodes: ['AAAA-BBBB'],
      activatedAt: new Date(),
    })),
  };
}

async function buildTestApp() {
  const env = buildTestEnv();
  const artifacts = createAuthArtifacts();
  const authService = createAuthServiceStub(artifacts.user, artifacts.tokens);
  const app = fastify();

  app.decorateRequest('authUser', null);
  app.decorate('authService', authService);
  app.decorate(
    'authenticate',
    vi.fn(async function authenticate(request) {
      request.authUser = artifacts.user;
      return artifacts.user;
    }),
  );
  app.decorate('authorize', () => vi.fn(async () => {}));

  await app.register(validationPlugin);
  await app.register(authRoutes, { env });
  await app.ready();

  return { app, authService };
}

describe('authRoutes validation', () => {
  it('rejects payloads with missing required fields', async () => {
    const { app, authService } = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: {
          password: 'Sup3rSecurePass!',
          acceptTerms: true,
        },
      });

      expect(response.statusCode).toBe(422);
      const payload = response.json();
      expect(payload.error.code).toBe('VALIDATION_ERROR');
      expect(authService.signup).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects payloads containing unexpected keys', async () => {
    const { app, authService } = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/signup',
        payload: {
          email: 'new@example.com',
          password: 'Sup3rSecurePass!',
          acceptTerms: true,
          unexpected: true,
        },
      });

      expect(response.statusCode).toBe(422);
      const payload = response.json();
      expect(payload.error.code).toBe('VALIDATION_ERROR');
      expect(payload.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'unrecognized_keys',
            message: expect.stringContaining('"unexpected"'),
          }),
        ]),
      );
      expect(authService.signup).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('sanitizes string payloads before calling service methods', async () => {
    const { app, authService } = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/email/verify',
        payload: {
          token: '  trimmed-token  \u0000',
        },
      });

      expect(response.statusCode).toBe(200);
      const [input] = authService.verifyEmail.mock.calls[0];
      expect(input).toMatchObject({ token: 'trimmed-token' });
    } finally {
      await app.close();
    }
  });
});

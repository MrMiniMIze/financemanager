import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Env } from '../env';
import type { AuthTokens } from '../services/auth-service';
import { ServiceError } from '../errors';
import type { AuthUser } from '../domain/models';

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[0-9]/, 'Password must include a digit')
  .regex(/[^A-Za-z0-9]/, 'Password must include a symbol');

const SignupSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: passwordSchema,
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    planTier: z.enum(['free', 'pro', 'family']).optional(),
    timezone: z.string().max(64).optional(),
    acceptTerms: z.literal(true),
    marketingOptIn: z.boolean().optional(),
  })
  .strict();

const LoginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(12).max(128),
    rememberMe: z.boolean().default(false),
    challengeId: z.string().uuid().optional(),
    mfaCode: z.string().min(4).max(16).optional(),
    rememberDevice: z.boolean().optional(),
  })
  .strict()
  .refine((data) => !data.mfaCode || !!data.challengeId, {
    message: 'challengeId required when mfaCode supplied',
    path: ['challengeId'],
  });

const RefreshSchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .strict();

const LogoutSchema = z
  .object({
    refreshToken: z.string().optional(),
  })
  .strict();

const PasswordResetRequestSchema = z
  .object({
    email: z.string().trim().email().max(254),
  })
  .strict();

const PasswordResetConfirmSchema = z
  .object({
    token: z.string().min(10),
    newPassword: passwordSchema,
  })
  .strict();

const VerifyEmailSchema = z
  .object({
    token: z.string().min(10),
  })
  .strict();

const MfaSetupSchema = z
  .object({
    method: z.literal('totp'),
    deviceName: z.string().min(1).max(100).optional(),
  })
  .strict();

const MfaVerifySchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z.string().min(4).max(16),
    rememberDevice: z.boolean().optional(),
  })
  .strict();

export interface AuthRoutesOptions {
  env: Env;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, opts) => {
  const { env } = opts;

  fastify.post(
    '/api/auth/signup',
    fastify.withValidation({ body: SignupSchema }, async (request, reply) => {
      const { body } = request.validated;

      try {
        const result = await fastify.authService.signup(body, buildContext(request));
        setAuthCookies(reply, env, result.tokens);

        return reply.code(201).send({
          data: {
            user: serializeUser(result.user),
            session: serializeSession(result.tokens),
            requiresEmailVerification: result.requiresEmailVerification,
            debug: result.debug,
          },
          meta: {},
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/login',
    fastify.withValidation({ body: LoginSchema }, async (request, reply) => {
      const { body } = request.validated;

      try {
        const rememberedDeviceToken = request.cookies?.[env.MFA_REMEMBER_COOKIE_NAME] ?? null;
        const result = await fastify.authService.login(
          {
            ...body,
            rememberedDeviceToken,
          },
          buildContext(request),
        );

        if (result.type === 'authenticated') {
          setAuthCookies(reply, env, result.tokens);
          setRememberDeviceCookie(reply, env, result.rememberDevice ? result.rememberDevice : null);

          return reply.code(200).send({
            data: {
              user: serializeUser(result.user),
              session: serializeSession(result.tokens),
            },
            meta: {
              mfaRequired: false,
            },
          });
        }

        clearAuthCookies(reply, env);

        return reply.code(200).send({
          data: {
            challengeId: result.challengeId,
            mfaMethods: result.methods,
            expiresAt: result.expiresAt.toISOString(),
          },
          meta: {
            mfaRequired: true,
          },
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/refresh',
    fastify.withValidation({ body: RefreshSchema }, async (request, reply) => {
      const { body } = request.validated;
      const refreshToken = body.refreshToken ?? request.cookies.fm_refresh;

      if (!refreshToken) {
        return reply.code(400).send({
          error: {
            code: 'AUTH_MISSING_REFRESH_TOKEN',
            message: 'Refresh token not provided.',
          },
          correlationId: request.id,
        });
      }

      try {
        const result = await fastify.authService.refreshSession(
          refreshToken,
          buildContext(request),
        );
        setAuthCookies(reply, env, result.tokens);

        return reply.code(200).send({
          data: {
            user: serializeUser(result.user),
            session: serializeSession(result.tokens),
          },
          meta: {},
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/logout',
    fastify.withValidation({ body: LogoutSchema }, async (request, reply) => {
      const { body } = request.validated;
      const refreshToken = body.refreshToken ?? request.cookies.fm_refresh;

      if (!refreshToken) {
        clearAuthCookies(reply, env);
        return reply.code(204).send();
      }

      clearAuthCookies(reply, env);
      return reply.code(204).send();
    }),
  );

  fastify.post(
    '/api/auth/password/reset-request',
    fastify.withValidation({ body: PasswordResetRequestSchema }, async (request, reply) => {
      const { body } = request.validated;

      try {
        const result = await fastify.authService.requestPasswordReset(body, buildContext(request));

        return reply.code(200).send({
          data: {
            requested: result.requested,
          },
          meta: {},
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/password/reset',
    fastify.withValidation({ body: PasswordResetConfirmSchema }, async (request, reply) => {
      const { body } = request.validated;

      try {
        const result = await fastify.authService.resetPassword(body, buildContext(request));

        return reply.code(200).send({
          data: {
            user: serializeUser(result.user),
          },
          meta: {},
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/email/verify',
    fastify.withValidation({ body: VerifyEmailSchema }, async (request, reply) => {
      const { body } = request.validated;

      try {
        const result = await fastify.authService.verifyEmail(body, buildContext(request));

        return reply.code(200).send({
          data: {
            user: serializeUser(result.user),
          },
          meta: {},
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/mfa/setup',
    {
      preHandler: [fastify.authenticate.bind(fastify), fastify.authorize(['user', 'admin'])],
    },
    fastify.withValidation({ body: MfaSetupSchema }, async (request, reply) => {
      const user = request.authUser as AuthUser;
      const { body } = request.validated;

      try {
        const result = await fastify.authService.startMfaEnrollment(
          user,
          body.deviceName ?? null,
          buildContext(request),
        );

        return reply.code(200).send({
          data: {
            challengeId: result.challengeId,
            secret: result.secret,
            otpauthUrl: result.otpauthUrl,
            qrCodeSvg: result.qrCodeSvg,
            expiresAt: result.expiresAt.toISOString(),
          },
          meta: {},
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );

  fastify.post(
    '/api/auth/mfa/verify',
    fastify.withValidation({ body: MfaVerifySchema }, async (request, reply) => {
      const { body } = request.validated;

      try {
        const result = await fastify.authService.verifyMfaChallenge(body, buildContext(request));

        if (result.type === 'setup') {
          return reply.code(200).send({
            data: {
              mfaEnabled: true,
              backupCodes: result.backupCodes,
            },
            meta: {},
          });
        }

        setAuthCookies(reply, env, result.tokens);
        setRememberDeviceCookie(reply, env, result.rememberDevice ?? null);

        return reply.code(200).send({
          data: {
            user: serializeUser(result.user),
            session: serializeSession(result.tokens),
          },
          meta: {
            mfaRequired: false,
          },
        });
      } catch (error) {
        return handleServiceError(request, reply, error);
      }
    }),
  );
};

function buildContext(request: FastifyRequest) {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function serializeUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    planTier: user.planTier,
    roles: user.roles,
    mfaEnabled: Boolean(user.mfa?.activatedAt),
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    timezone: user.timezone ?? null,
  };
}

function serializeSession(tokens: AuthTokens) {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
  };
}

function setAuthCookies(reply: FastifyReply, env: Env, tokens: AuthTokens) {
  const accessMaxAge = Math.max(
    1,
    Math.floor((tokens.accessTokenExpiresAt.getTime() - Date.now()) / 1000),
  );
  const refreshMaxAge = Math.max(
    1,
    Math.floor((tokens.refreshTokenExpiresAt.getTime() - Date.now()) / 1000),
  );

  reply.setCookie('fm_session', tokens.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: accessMaxAge,
  });

  reply.setCookie('fm_refresh', tokens.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: refreshMaxAge,
  });
}

function setRememberDeviceCookie(
  reply: FastifyReply,
  env: Env,
  remember: { value: string; expiresAt: Date } | null,
) {
  const name = env.MFA_REMEMBER_COOKIE_NAME;
  if (!name) {
    return;
  }

  if (remember) {
    reply.setCookie(name, remember.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      domain: env.COOKIE_DOMAIN,
      path: '/',
      expires: remember.expiresAt,
    });
  } else {
    reply.setCookie(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      domain: env.COOKIE_DOMAIN,
      path: '/',
      maxAge: 0,
    });
  }
}

function clearAuthCookies(reply: FastifyReply, env: Env) {
  reply.setCookie('fm_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: 0,
  });

  reply.setCookie('fm_refresh', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: 0,
  });

  const rememberName = env.MFA_REMEMBER_COOKIE_NAME;
  if (rememberName) {
    reply.setCookie(rememberName, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      domain: env.COOKIE_DOMAIN,
      path: '/',
      maxAge: 0,
    });
  }
}

function handleServiceError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ServiceError) {
    reply.code(error.status).send({
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? null,
      },
      correlationId: request.id,
    });
    return reply;
  }

  throw error;
}

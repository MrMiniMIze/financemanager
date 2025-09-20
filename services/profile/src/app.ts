import fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';

import { env as defaultEnv, type Env } from './env';
import prismaPlugin from './plugins/prisma';
import validationPlugin from './plugins/validation';
import authContextPlugin from './plugins/auth-context';
import { PrismaProfileRepository } from './repositories/prisma-profile-repository';
import type { ProfileRepository } from './repositories/profile-repository';
import { ProfileService } from './services/profile-service';
import { ServiceError } from './errors';
import { profileRoutes } from './routes/profile-routes';

export interface BuildAppOptions {
  env?: Env;
  prismaClient?: PrismaClient;
  repository?: ProfileRepository;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions = {}) {
  const resolvedEnv = options.env ?? defaultEnv;

  const app = fastify({
    logger: options.logger ?? { level: resolvedEnv.LOG_LEVEL },
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: resolvedEnv.RATE_LIMIT_MAX,
    timeWindow: `${resolvedEnv.RATE_LIMIT_WINDOW_MINUTES} minutes`,
  });

  const prismaClient =
    options.prismaClient ?? (options.repository ? createNoopPrismaClient() : undefined);
  await app.register(prismaPlugin, { client: prismaClient });

  const repository = options.repository ?? new PrismaProfileRepository(app.prisma);
  const profileService = new ProfileService(repository);
  app.decorate('profileService', profileService);

  await app.register(validationPlugin);
  await app.register(authContextPlugin);
  await app.register(profileRoutes);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      request.log.warn({ err: error }, 'Handled service error');
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
        correlationId: request.id,
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
      },
      correlationId: request.id,
    });
  });

  return app;
}

function createNoopPrismaClient(): PrismaClient {
  return {
    $connect: async () => {},
    $disconnect: async () => {},
  } as unknown as PrismaClient;
}

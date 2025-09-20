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
import { PrismaTransactionsRepository } from './repositories/prisma-transactions-repository';
import type { TransactionsRepository } from './repositories/transactions-repository';
import { TransactionsService } from './services/transactions-service';
import { ServiceError } from './errors';
import { transactionRoutes } from './routes/transaction-routes';

export interface BuildAppOptions {
  env?: Env;
  prismaClient?: PrismaClient;
  repository?: TransactionsRepository;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
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

  const repository = options.repository ?? new PrismaTransactionsRepository(app.prisma);
  const transactionsService = new TransactionsService(repository, {
    importEstimateSeconds: resolvedEnv.IMPORT_JOB_ESTIMATED_SECONDS,
  });
  app.decorate('transactionsService', transactionsService);

  await app.register(validationPlugin);
  await app.register(authContextPlugin);
  await app.register(transactionRoutes);

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

    if ((error as { statusCode?: number }).statusCode) {
      return reply.send(error);
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

import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import type { AuthenticatedUser } from '../plugins/auth-context';
import type { ValidationHandler, ValidationSchemas } from '../plugins/validation';
import type { AccountsService } from '../services/accounts-service';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    accountsService: AccountsService;
    withValidation<T extends ValidationSchemas>(
      schemas: T,
      handler: ValidationHandler<T>,
    ): RouteHandlerMethod;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser>;
  }

  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    validated: Record<string, unknown>;
  }
}

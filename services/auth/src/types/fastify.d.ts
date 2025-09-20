import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import type { AuthService } from '../services/auth-service';
import type { AuthUser } from '../domain/models';
import type { ValidationHandler, ValidationSchemas } from '../plugins/validation';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    authService: AuthService;
    withValidation<T extends ValidationSchemas>(
      schemas: T,
      handler: ValidationHandler<T>,
    ): RouteHandlerMethod;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser>;
    authorize(roles?: string[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    authUser: AuthUser | null;
    validated: Record<string, unknown>;
  }
}

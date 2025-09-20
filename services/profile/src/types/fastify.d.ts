import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import type { AuthenticatedUser } from '../plugins/auth-context';
import type { ValidationHandler, ValidationSchemas } from '../plugins/validation';
import type { GetProfileContext, ProfileService } from '../services/profile-service';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    profileService: ProfileService;
    withValidation<T extends ValidationSchemas>(
      schemas: T,
      handler: ValidationHandler<T>,
    ): RouteHandlerMethod;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser>;
    resolveProfileContext(request: FastifyRequest): GetProfileContext;
  }

  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    validated: Record<string, unknown>;
  }
}

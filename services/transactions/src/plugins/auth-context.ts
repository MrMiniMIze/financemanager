import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { unauthorized } from '../errors';

export interface AuthenticatedUser {
  id: string;
  email?: string | null;
  timezone?: string | null;
}

const headerSchema = z.object({
  'x-user-id': z.string().uuid(),
  'x-user-email': z.string().email().optional(),
  'x-user-timezone': z.string().min(1).optional(),
});

const authContextPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('authUser', null as AuthenticatedUser | null);

  fastify.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
      const parsed = headerSchema.safeParse(request.headers);
      if (!parsed.success) {
        throw unauthorized('AUTH_UNAUTHORIZED', 'Authentication required.');
      }

      const data = parsed.data;
      const user: AuthenticatedUser = {
        id: data['x-user-id'],
        email: data['x-user-email'],
        timezone: data['x-user-timezone'],
      };

      request.authUser = user;
      return user;
    },
  );
};

export default fp(authContextPlugin);

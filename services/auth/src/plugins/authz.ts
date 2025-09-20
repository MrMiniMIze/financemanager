import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { forbidden, unauthorized } from '../errors';
import type { AuthUser } from '../domain/models';

function extractBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (match) {
      return match[1].trim();
    }
  }

  const cookieToken = request.cookies?.fm_session;
  return typeof cookieToken === 'string' && cookieToken.length > 0 ? cookieToken : null;
}

const authzPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('authUser', null as AuthUser | null);

  fastify.decorate('authenticate', async function authenticate(request: FastifyRequest, reply) {
    const token = extractBearerToken(request);

    if (!token) {
      throw unauthorized('AUTH_UNAUTHORIZED', 'Authentication required.');
    }

    let payload: { sub: string };
    try {
      payload = await fastify.jwt.verify<{ sub: string }>(token);
    } catch {
      throw unauthorized('AUTH_UNAUTHORIZED', 'Authentication required.');
    }

    const user = await fastify.authService.getUserById(payload.sub);

    if (!user) {
      throw unauthorized('AUTH_UNAUTHORIZED', 'Authentication required.');
    }

    if (user.status === 'suspended') {
      throw forbidden('AUTH_ACCOUNT_SUSPENDED', 'Your account is currently suspended.');
    }

    request.authUser = user;
    return user;
  });

  fastify.decorate('authorize', function authorize(requiredRoles: string[] = []) {
    return async function preHandler(request: FastifyRequest, reply) {
      const user = await fastify.authenticate(request, reply);
      if (requiredRoles.length === 0) {
        return;
      }

      const hasRole = requiredRoles.some((role) => user.roles.includes(role));
      if (!hasRole) {
        throw forbidden('AUTH_FORBIDDEN', 'You do not have permission to access this resource.');
      }
    };
  });
};

export default fp(authzPlugin);

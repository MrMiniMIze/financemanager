import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z, type ZodTypeAny } from 'zod';

type ValidationSegment = 'body' | 'query' | 'params' | 'headers';

export type ValidationSchemas = Partial<Record<ValidationSegment, ZodTypeAny>>;

export type ValidatedData<T extends ValidationSchemas> = {
  readonly [K in keyof T]: z.infer<T[K]>;
};

export type ValidationHandler<T extends ValidationSchemas> = (
  request: FastifyRequest & { readonly validated: ValidatedData<T> },
  reply: FastifyReply,
) => unknown | Promise<unknown>;

const validationPlugin = async (fastify: FastifyInstance) => {
  fastify.decorateRequest('validated', null);

  fastify.decorate('withValidation', function withValidation<
    T extends ValidationSchemas,
  >(schemas: T, handler: ValidationHandler<T>) {
    return async function wrappedHandler(request: FastifyRequest, reply: FastifyReply) {
      try {
        const validated: Partial<Record<ValidationSegment, unknown>> = {};

        if (schemas.body) {
          const parsed = schemas.body.parse(request.body ?? {});
          const sanitized = sanitize(parsed);
          validated.body = sanitized;
          request.body = sanitized;
        }

        if (schemas.query) {
          const parsed = schemas.query.parse(request.query ?? {});
          const sanitized = sanitize(parsed);
          validated.query = sanitized;
          request.query = sanitized;
        }

        if (schemas.params) {
          const parsed = schemas.params.parse(request.params ?? {});
          const sanitized = sanitize(parsed);
          validated.params = sanitized;
          request.params = sanitized;
        }

        if (schemas.headers) {
          const parsed = schemas.headers.parse(request.headers ?? {});
          const sanitized = sanitize(parsed);
          validated.headers = sanitized;
          request.headers = sanitized as typeof request.headers;
        }

        request.validated = validated as ValidatedData<T>;
      } catch (error) {
        if (error instanceof ZodError) {
          return reply.code(422).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed.',
              details: error.issues.map((issue) => ({
                path: issue.path.length ? issue.path.join('.') : 'root',
                message: issue.message,
                code: issue.code,
              })),
            },
            correlationId: request.id,
          });
        }

        throw error;
      }

      return handler(request as FastifyRequest & { readonly validated: ValidatedData<T> }, reply);
    };
  });
};

function sanitize<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    const withoutControl = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return withoutControl.trim() as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item)) as T;
  }

  if (value instanceof Date || value instanceof RegExp || value instanceof Buffer) {
    return value;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      sanitize(val),
    ]);
    return Object.fromEntries(entries) as T;
  }

  return value;
}

export default fp(validationPlugin, {
  name: 'validation-plugin',
});

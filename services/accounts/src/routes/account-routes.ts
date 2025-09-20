import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Account, AccountListItem, AccountSnapshot } from '../domain/models';
import type { LinkAccountsInput } from '../services/accounts-service';

const LinkSchema = z.object({
  publicToken: z.string().min(1).max(256),
  institutionId: z.string().min(1).max(128),
  metadata: z.object({
    institutionName: z.string().min(1).max(128),
    linkSessionId: z.string().uuid(),
    accounts: z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          name: z.string().min(1).max(128),
          mask: z.string().regex(/^\d{2,4}$/),
          type: z.string().min(1).max(64),
          subtype: z.string().min(1).max(64).optional(),
        }),
      )
      .min(1),
  }),
});

const ListQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'pending_unlink']).optional(),
  includeSnapshots: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .default('false')
    .transform((value) => {
      if (typeof value === 'boolean') {
        return value;
      }
      return value === 'true';
    }),
  search: z.string().max(128).optional(),
});

const AccountIdParams = z.object({ accountId: z.string().uuid() });

const AccountUpdateSchema = z
  .object({
    accountName: z.string().min(1).max(128).optional(),
    status: z.enum(['active', 'archived']).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field required',
    path: ['accountName'],
  });

const AccountDeleteSchema = z.object({
  retention: z.enum(['keep_transactions', 'purge_after_30_days']),
  reason: z.enum(['user_request', 'switched_bank', 'fraud_suspected', 'other']).optional(),
});

export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (request) => ({
    status: 'ok',
    correlationId: request.id,
  }));

  fastify.post('/accounts/link', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ body: LinkSchema }, async (request, reply) => {
      const user = request.authUser!;
      const body = request.validated.body as LinkAccountsInput;

      const accounts = await fastify.accountsService.linkAccounts(user.id, body);

      reply.code(201).send({
        data: {
          linkedAccounts: accounts.map(serializeAccount),
        },
        meta: {
          nextPlaidUpdateWebhook: 'https://api.financemanager.local/webhooks/plaid',
        },
      });
    }),
  });

  fastify.get('/accounts', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ query: ListQuerySchema }, async (request, reply) => {
      const user = request.authUser!;
      const query = request.validated.query;

      const accounts = await fastify.accountsService.listAccounts(user.id, {
        status: query.status,
        includeSnapshots: query.includeSnapshots,
        search: query.search,
      });

      reply.send({
        data: {
          accounts: accounts.map((account) => serializeAccount(account, query.includeSnapshots)),
        },
        meta: {
          page: 1,
          pageSize: accounts.length,
          total: accounts.length,
          hasNextPage: false,
        },
      });
    }),
  });

  fastify.patch('/accounts/:accountId', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation(
      { params: AccountIdParams, body: AccountUpdateSchema },
      async (request, reply) => {
        const user = request.authUser!;
        const params = request.validated.params;
        const body = request.validated.body;

        const account = await fastify.accountsService.updateAccount(
          user.id,
          params.accountId,
          body,
        );

        reply.send({
          data: {
            account: serializeAccount(account),
          },
        });
      },
    ),
  });

  fastify.delete('/accounts/:accountId', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation(
      { params: AccountIdParams, body: AccountDeleteSchema },
      async (request, reply) => {
        const user = request.authUser!;
        const params = request.validated.params;
        const body = request.validated.body;

        const result = await fastify.accountsService.deleteAccount(user.id, params.accountId, body);

        reply.code(202).send({
          data: result,
        });
      },
    ),
  });
};

function serializeAccount(account: Account | AccountListItem, includeSnapshots = false) {
  return {
    id: account.id,
    institutionId: account.institutionId,
    institutionName: account.institutionName,
    accountName: account.accountName,
    accountType: account.accountType,
    accountSubtype: account.accountSubtype,
    mask: account.mask,
    currency: account.currency,
    currentBalance: account.currentBalance,
    availableBalance: account.availableBalance,
    status: account.status,
    lastSyncedAt: account.lastSyncedAt ? account.lastSyncedAt.toISOString() : null,
    notes: account.notes,
    plaidItemId: account.plaidItemId,
    plaidAccountId: account.plaidAccountId,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    pendingDeletionAt: account.pendingDeletionAt ? account.pendingDeletionAt.toISOString() : null,
    retentionPolicy: account.retentionPolicy,
    snapshots: includeSnapshots
      ? serializeSnapshots((account as AccountListItem).snapshots ?? [])
      : undefined,
  };
}

function serializeSnapshots(snapshots: AccountSnapshot[]) {
  return snapshots.map((snapshot) => ({
    capturedAt: snapshot.capturedAt.toISOString(),
    currentBalance: snapshot.currentBalance,
    availableBalance: snapshot.availableBalance,
  }));
}

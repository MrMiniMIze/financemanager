import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Transaction, TransactionListItem } from '../domain/models';

const AmountSchema = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Invalid amount format');

const OptionalIsoDate = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const SortSchema = z
  .string()
  .regex(/^(postedAt|amount|merchantName|createdAt):(asc|desc)$/)
  .default('postedAt:desc');

const ListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  sort: SortSchema.optional(),
  search: z.string().max(128).optional(),
  'filter[accountId]': z.string().uuid().optional(),
  'filter[categoryId]': z.string().max(64).optional(),
  'filter[direction]': z.enum(['credit', 'debit']).optional(),
  'filter[source]': z.enum(['plaid', 'import', 'manual']).optional(),
  'filter[status]': z.enum(['pending', 'cleared', 'disputed']).optional(),
  'filter[minAmount]': AmountSchema.optional(),
  'filter[maxAmount]': AmountSchema.optional(),
  'filter[from]': OptionalIsoDate.optional(),
  'filter[to]': OptionalIsoDate.optional(),
});

const ImportSchema = z.object({
  uploadId: z.string().uuid(),
  accountId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  hasHeaderRow: z.boolean().default(true),
  columnMapping: z
    .object({
      date: z.string().min(1),
      description: z.string().min(1),
      amount: z.string().min(1),
      direction: z.string().min(1),
      category: z.string().min(1).optional(),
      notes: z.string().min(1).optional(),
    })
    .strict(),
});

const IdempotencyHeaderSchema = z.object({
  'idempotency-key': z.string().min(1).max(128),
});

const TransactionUpdateSchema = z
  .object({
    categoryId: z.string().max(64).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    tags: z.array(z.string().min(1).max(32)).max(20).optional(),
    status: z.enum(['pending', 'cleared', 'disputed']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field required',
    path: ['categoryId'],
  });

const TransactionIdParams = z.object({ id: z.string().uuid() });

const BulkTagSchema = z
  .object({
    transactionIds: z.array(z.string().uuid()).min(1).max(200),
    addTags: z.array(z.string().min(1).max(32)).max(20).optional(),
    removeTags: z.array(z.string().min(1).max(32)).max(20).optional(),
    categoryId: z.string().max(64).nullable().optional(),
    replaceTags: z.boolean().default(false),
  })
  .refine(
    (value) =>
      Boolean(value.addTags?.length || value.removeTags?.length || value.categoryId !== undefined),
    {
      message: 'Must supply at least addTags, removeTags, or categoryId',
      path: ['addTags'],
    },
  );

export const transactionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (request) => ({
    status: 'ok',
    correlationId: request.id,
  }));

  fastify.get('/transactions', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ query: ListQuerySchema }, async (request, reply) => {
      const user = request.authUser!;
      const query = request.validated.query;

      const sortValue = query.sort ?? 'postedAt:desc';
      const [sortField, sortDirection] = sortValue.split(':') as [
        'postedAt' | 'amount' | 'merchantName' | 'createdAt',
        'asc' | 'desc',
      ];

      const page = await fastify.transactionsService.listTransactions(user.id, {
        page: query.page,
        pageSize: query.pageSize,
        sortField,
        sortDirection,
        filters: {
          accountId: query['filter[accountId]'] ?? undefined,
          categoryId: normalizeCategoryFilter(query['filter[categoryId]']),
          direction: query['filter[direction]'] ?? undefined,
          source: query['filter[source]'] ?? undefined,
          status: query['filter[status]'] ?? undefined,
          minAmount: query['filter[minAmount]'] ?? undefined,
          maxAmount: query['filter[maxAmount]'] ?? undefined,
          from: query['filter[from]'] ?? undefined,
          to: query['filter[to]'] ?? undefined,
          search: query.search ?? undefined,
        },
      });

      reply.send({
        data: {
          transactions: page.transactions.map(serializeTransaction),
        },
        meta: {
          page: page.page,
          pageSize: page.pageSize,
          total: page.total,
          hasNextPage: page.hasNextPage,
        },
      });
    }),
  });

  fastify.post('/transactions/import', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation(
      { body: ImportSchema, headers: IdempotencyHeaderSchema },
      async (request, reply) => {
        const user = request.authUser!;
        const body = request.validated.body;
        const headers = request.validated.headers;

        const job = await fastify.transactionsService.queueImport(user.id, {
          uploadId: body.uploadId,
          accountId: body.accountId,
          fileName: body.fileName,
          hasHeaderRow: body.hasHeaderRow,
          columnMapping: body.columnMapping,
          idempotencyKey: headers['idempotency-key'],
        });

        reply.code(202).send({
          data: {
            importJobId: job.id,
            status: job.status,
            estimatedCompletionSeconds: job.estimatedDuration,
          },
        });
      },
    ),
  });

  fastify.patch('/transactions/:id', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation(
      { params: TransactionIdParams, body: TransactionUpdateSchema },
      async (request, reply) => {
        const user = request.authUser!;
        const body = request.validated.body;
        const params = request.validated.params;

        const transaction = await fastify.transactionsService.updateTransaction(
          user.id,
          params.id,
          {
            categoryId: Object.prototype.hasOwnProperty.call(body, 'categoryId')
              ? body.categoryId
              : undefined,
            notes: Object.prototype.hasOwnProperty.call(body, 'notes') ? body.notes : undefined,
            tags: body.tags,
            status: body.status,
          },
        );

        reply.send({
          data: {
            transaction: serializeTransaction(transaction),
          },
        });
      },
    ),
  });

  fastify.post('/transactions/bulk-tag', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ body: BulkTagSchema }, async (request, reply) => {
      const user = request.authUser!;
      const body = request.validated.body;

      const result = await fastify.transactionsService.bulkTagTransactions(user.id, {
        transactionIds: body.transactionIds,
        addTags: body.addTags,
        removeTags: body.removeTags,
        categoryId: Object.prototype.hasOwnProperty.call(body, 'categoryId')
          ? body.categoryId
          : undefined,
        replaceTags: body.replaceTags,
      });

      reply.send({
        data: result,
      });
    }),
  });
};

function serializeTransaction(transaction: Transaction | TransactionListItem) {
  return {
    id: transaction.id,
    accountId: transaction.accountId,
    userId: transaction.userId,
    postedAt: transaction.postedAt.toISOString(),
    amount: transaction.amount,
    direction: transaction.direction,
    merchantName: transaction.merchantName,
    description: transaction.description,
    categoryId: transaction.categoryId,
    notes: transaction.notes,
    status: transaction.status,
    source: transaction.source,
    receiptUrl: transaction.receiptUrl,
    externalId: transaction.externalId,
    tags: [...transaction.tags],
    importBatchId: transaction.importBatchId,
    duplicateOfId: transaction.duplicateOfId,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
  };
}

function normalizeCategoryFilter(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'null') {
    return null;
  }
  return value;
}

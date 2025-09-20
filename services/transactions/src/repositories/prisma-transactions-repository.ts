import { Prisma, type PrismaClient } from '@prisma/client';

import type {
  BulkTagResult,
  CategorizationRule as DomainCategorizationRule,
  Transaction,
  TransactionDraft,
  TransactionImportJob,
  TransactionQueryOptions,
  TransactionsPage,
} from '../domain/models';
import { badRequest, notFound } from '../errors';
import type {
  BulkTagUpdateInput,
  TransactionImportInput,
  TransactionUpdateInput,
  TransactionsRepository,
} from './transactions-repository';

export class PrismaTransactionsRepository implements TransactionsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async paginateTransactions(
    userId: string,
    options: TransactionQueryOptions,
  ): Promise<TransactionsPage> {
    const page = Math.max(1, options.page);
    const pageSize = Math.min(Math.max(options.pageSize, 1), 100);

    const where = buildWhere(userId, options);

    const [records, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: mapOrder(options),
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { tags: true },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      transactions: records.map(mapTransaction),
      total,
      page,
      pageSize,
      hasNextPage: page * pageSize < total,
    };
  }

  async findTransactionById(userId: string, transactionId: string): Promise<Transaction | null> {
    const record = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId },
      include: { tags: true },
    });

    return record ? mapTransaction(record) : null;
  }

  async updateTransaction(
    userId: string,
    transactionId: string,
    update: TransactionUpdateInput,
  ): Promise<Transaction> {
    const updateData: Prisma.TransactionUpdateInput = {};

    if (update.categoryId !== undefined) {
      updateData.categoryId = update.categoryId;
    }

    if (update.notes !== undefined) {
      updateData.notes = update.notes;
    }

    if (update.status !== undefined) {
      updateData.status = update.status;
      if (update.status === 'cleared') {
        updateData.reconciledAt = new Date();
      }
    }

    if (update.tags !== undefined) {
      const tags = sanitizeTags(update.tags);
      updateData.tags = {
        deleteMany: {},
        createMany: {
          data: tags.map((tag) => ({ tag })),
          skipDuplicates: true,
        },
      };
    }

    try {
      const record = await this.prisma.transaction.update({
        where: { id_userId: { id: transactionId, userId } },
        data: updateData,
        include: { tags: true },
      });
      return mapTransaction(record);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('TRANSACTIONS_NOT_FOUND', 'Transaction not found.');
      }

      throw error;
    }
  }

  async bulkUpdateTransactions(
    userId: string,
    ids: string[],
    update: BulkTagUpdateInput,
  ): Promise<BulkTagResult> {
    if (!ids.length) {
      return { updatedCount: 0, failedIds: [] };
    }

    const uniqueIds = Array.from(new Set(ids));

    return this.prisma.$transaction(async (tx) => {
      const records = await tx.transaction.findMany({
        where: {
          userId,
          id: { in: uniqueIds },
        },
        include: { tags: true },
      });

      const foundIds = new Set(records.map((record) => record.id));
      const failedIds = uniqueIds.filter((id) => !foundIds.has(id));

      for (const record of records) {
        const newTags = computeBulkTags(
          record.tags.map((tag) => tag.tag),
          update,
        );
        const data: Prisma.TransactionUpdateInput = {};

        if (update.categoryId !== undefined) {
          data.categoryId = update.categoryId;
        }

        if (newTags !== null) {
          data.tags = {
            deleteMany: {},
            createMany: {
              data: newTags.map((tag) => ({ tag })),
              skipDuplicates: true,
            },
          };
        }

        if (Object.keys(data).length > 0) {
          await tx.transaction.update({
            where: { id_userId: { id: record.id, userId } },
            data,
          });
        }
      }

      return {
        updatedCount: records.length,
        failedIds,
      } satisfies BulkTagResult;
    });
  }

  async createTransactions(userId: string, drafts: TransactionDraft[]): Promise<Transaction[]> {
    if (!drafts.length) {
      return [];
    }

    return this.prisma.$transaction(async (tx) => {
      const created: Transaction[] = [];

      for (const draft of drafts) {
        const tags = sanitizeTags(draft.tags ?? []);
        const record = await tx.transaction.create({
          data: {
            userId,
            accountId: draft.accountId,
            postedAt: draft.postedAt,
            amount: new Prisma.Decimal(draft.amount),
            direction: draft.direction,
            merchantName: draft.merchantName,
            description: draft.description ?? null,
            categoryId: draft.categoryId ?? null,
            notes: draft.notes ?? null,
            status: draft.status ?? 'pending',
            source: draft.source,
            receiptUrl: draft.receiptUrl ?? null,
            externalId: draft.externalId ?? null,
            importBatchId: draft.importBatchId ?? null,
            tags: tags.length
              ? {
                  createMany: {
                    data: tags.map((tag) => ({ tag })),
                    skipDuplicates: true,
                  },
                }
              : undefined,
          },
          include: { tags: true },
        });

        created.push(mapTransaction(record));
      }

      return created;
    });
  }

  async findImportJobByUploadId(
    userId: string,
    uploadId: string,
  ): Promise<TransactionImportJob | null> {
    const record = await this.prisma.transactionImportBatch.findFirst({
      where: { userId, uploadId },
    });
    return record ? mapImport(record) : null;
  }

  async findImportJobByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<TransactionImportJob | null> {
    const record = await this.prisma.transactionImportBatch.findFirst({
      where: { userId, idempotencyKey },
    });
    return record ? mapImport(record) : null;
  }

  async createImportJob(
    userId: string,
    input: TransactionImportInput,
  ): Promise<TransactionImportJob> {
    const existingUpload = await this.findImportJobByUploadId(userId, input.uploadId);
    if (existingUpload) {
      throw badRequest('TRANSACTIONS_IMPORT_DUPLICATE', 'Upload already processed.');
    }

    if (input.idempotencyKey) {
      const existingKey = await this.findImportJobByIdempotencyKey(userId, input.idempotencyKey);
      if (existingKey) {
        return existingKey;
      }
    }

    const record = await this.prisma.transactionImportBatch.create({
      data: {
        userId,
        accountId: input.accountId,
        uploadId: input.uploadId,
        fileName: input.fileName,
        hasHeaderRow: input.hasHeaderRow,
        columnMapping: input.columnMapping,
        estimatedDuration: input.estimatedCompletionSeconds,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    return mapImport(record);
  }

  async listCategorizationRules(userId: string): Promise<DomainCategorizationRule[]> {
    const records = await this.prisma.categorizationRule.findMany({
      where: { userId, isActive: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });

    return records.map(mapRule);
  }
}

function mapTransaction(
  record: Prisma.Transaction & { tags: Prisma.TransactionTag[] },
): Transaction {
  return {
    id: record.id,
    userId: record.userId,
    accountId: record.accountId,
    postedAt: record.postedAt,
    amount: record.amount.toString(),
    direction: record.direction,
    merchantName: record.merchantName,
    description: record.description,
    categoryId: record.categoryId,
    notes: record.notes,
    status: record.status,
    source: record.source,
    receiptUrl: record.receiptUrl,
    externalId: record.externalId,
    tags: sanitizeTags(record.tags.map((tag) => tag.tag)),
    reviewedAt: record.reviewedAt,
    reconciledAt: record.reconciledAt,
    reconciledBy: record.reconciledBy,
    importBatchId: record.importBatchId,
    duplicateOfId: record.duplicateOfId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapImport(record: Prisma.TransactionImportBatch): TransactionImportJob {
  return {
    id: record.id,
    userId: record.userId,
    accountId: record.accountId,
    uploadId: record.uploadId,
    fileName: record.fileName,
    hasHeaderRow: record.hasHeaderRow,
    columnMapping: (record.columnMapping ?? {}) as Record<string, string>,
    status: record.status,
    failureReason: record.failureReason,
    idempotencyKey: record.idempotencyKey,
    processedCount: record.processedCount,
    errorCount: record.errorCount,
    estimatedDuration: record.estimatedDuration,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapRule(record: Prisma.CategorizationRule): DomainCategorizationRule {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    priority: record.priority,
    matchType: record.matchType,
    matchValue: record.matchValue,
    categoryId: record.categoryId,
    tags: Array.isArray(record.tags) ? (record.tags as string[]) : [],
    isActive: record.isActive,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }

  return result.slice(0, 20);
}

function computeBulkTags(current: string[], update: BulkTagUpdateInput): string[] | null {
  if (update.replaceTags) {
    if (!update.addTags) {
      return [];
    }
    return sanitizeTags(update.addTags);
  }

  const tagMap = new Map<string, string>();
  for (const tag of sanitizeTags(current)) {
    tagMap.set(tag.toLowerCase(), tag);
  }

  let changed = false;

  if (update.addTags) {
    for (const tag of sanitizeTags(update.addTags)) {
      const key = tag.toLowerCase();
      if (!tagMap.has(key)) {
        tagMap.set(key, tag);
        changed = true;
      }
    }
  }

  if (update.removeTags) {
    for (const raw of update.removeTags) {
      const key = raw.trim().toLowerCase();
      if (key && tagMap.delete(key)) {
        changed = true;
      }
    }
  }

  if (!changed) {
    return null;
  }

  return Array.from(tagMap.values()).slice(0, 20);
}

function buildWhere(
  userId: string,
  options: TransactionQueryOptions,
): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = { userId };
  const filters = options.filters;

  if (filters.accountId) {
    where.accountId = filters.accountId;
  }

  if (filters.categoryId !== undefined) {
    where.categoryId = filters.categoryId;
  }

  if (filters.direction) {
    where.direction = filters.direction;
  }

  if (filters.source) {
    where.source = filters.source;
  }

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.minAmount || filters.maxAmount) {
    where.amount = {
      ...(filters.minAmount ? { gte: new Prisma.Decimal(filters.minAmount) } : {}),
      ...(filters.maxAmount ? { lte: new Prisma.Decimal(filters.maxAmount) } : {}),
    };
  }

  if (filters.from || filters.to) {
    where.postedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  if (filters.search) {
    const search = filters.search.trim();
    if (search.length) {
      where.OR = [
        { merchantName: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }
  }

  return where;
}

function mapOrder(options: TransactionQueryOptions): Prisma.TransactionOrderByWithRelationInput {
  const field = options.sortField ?? 'postedAt';
  const direction = options.sortDirection ?? 'desc';

  switch (field) {
    case 'amount':
      return { amount: direction };
    case 'merchantName':
      return { merchantName: direction };
    case 'createdAt':
      return { createdAt: direction };
    case 'postedAt':
    default:
      return { postedAt: direction };
  }
}

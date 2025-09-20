import { randomUUID } from 'node:crypto';

import type {
  BulkTagResult,
  CategorizationRule,
  Transaction,
  TransactionDraft,
  TransactionImportJob,
  TransactionQueryOptions,
  TransactionsPage,
} from '../src/domain/models';
import { badRequest, notFound } from '../src/errors';
import type {
  BulkTagUpdateInput,
  TransactionImportInput,
  TransactionUpdateInput,
  TransactionsRepository,
} from '../src/repositories/transactions-repository';

interface StoredImportJob extends TransactionImportJob {}

export class InMemoryTransactionsRepository implements TransactionsRepository {
  private readonly transactions = new Map<string, Transaction>();
  private readonly importJobs = new Map<string, StoredImportJob>();
  private readonly rules = new Map<string, CategorizationRule[]>();

  setRules(userId: string, rules: CategorizationRule[]) {
    this.rules.set(
      userId,
      rules.map((rule) => ({ ...rule })),
    );
  }

  async paginateTransactions(
    userId: string,
    options: TransactionQueryOptions,
  ): Promise<TransactionsPage> {
    const records = Array.from(this.transactions.values()).filter(
      (transaction) => transaction.userId === userId,
    );

    const filtered = records.filter((transaction) => filterTransaction(transaction, options));

    const sorted = filtered.sort((a, b) => compareTransactions(a, b, options));

    const page = Math.max(1, options.page);
    const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const slice = sorted.slice(start, end).map(cloneTransaction);

    return {
      transactions: slice,
      total: filtered.length,
      page,
      pageSize,
      hasNextPage: end < filtered.length,
    };
  }

  async findTransactionById(userId: string, transactionId: string): Promise<Transaction | null> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.userId !== userId) {
      return null;
    }
    return cloneTransaction(transaction);
  }

  async updateTransaction(
    userId: string,
    transactionId: string,
    update: TransactionUpdateInput,
  ): Promise<Transaction> {
    const existing = await this.findTransactionById(userId, transactionId);
    if (!existing) {
      throw notFound('TRANSACTIONS_NOT_FOUND', 'Transaction not found.');
    }

    const next: Transaction = {
      ...existing,
      categoryId: update.categoryId !== undefined ? update.categoryId : existing.categoryId,
      notes: update.notes !== undefined ? update.notes : existing.notes,
      status: update.status ?? existing.status,
      tags: update.tags ? sanitizeTags(update.tags) : existing.tags,
      reconciledAt:
        update.status === 'cleared'
          ? new Date()
          : update.status
            ? existing.reconciledAt
            : existing.reconciledAt,
      updatedAt: new Date(),
    };

    this.transactions.set(transactionId, next);
    return cloneTransaction(next);
  }

  async bulkUpdateTransactions(
    userId: string,
    ids: string[],
    update: BulkTagUpdateInput,
  ): Promise<BulkTagResult> {
    const seen = new Set<string>();
    const failed: string[] = [];
    let updatedCount = 0;

    for (const id of ids) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const existing = await this.findTransactionById(userId, id);
      if (!existing) {
        failed.push(id);
        continue;
      }

      let tags = existing.tags;
      if (update.replaceTags) {
        tags = update.addTags ? sanitizeTags(update.addTags) : [];
      } else {
        if (update.addTags) {
          tags = sanitizeTags([...tags, ...update.addTags]);
        }
        if (update.removeTags) {
          const removals = new Set(update.removeTags.map((tag) => tag.trim().toLowerCase()));
          tags = tags.filter((tag) => !removals.has(tag.toLowerCase()));
        }
      }

      if (tags.length > 20) {
        tags = tags.slice(0, 20);
      }

      const next: Transaction = {
        ...existing,
        categoryId: update.categoryId !== undefined ? update.categoryId : existing.categoryId,
        tags,
        updatedAt: new Date(),
      };

      this.transactions.set(existing.id, next);
      updatedCount += 1;
    }

    return { updatedCount, failedIds: failed };
  }

  async createTransactions(userId: string, drafts: TransactionDraft[]): Promise<Transaction[]> {
    const created: Transaction[] = [];

    for (const draft of drafts) {
      const id = randomUUID();
      const transaction: Transaction = {
        id,
        userId,
        accountId: draft.accountId,
        postedAt: new Date(draft.postedAt),
        amount: draft.amount,
        direction: draft.direction,
        merchantName: draft.merchantName,
        description: draft.description ?? null,
        categoryId: draft.categoryId ?? null,
        notes: draft.notes ?? null,
        status: draft.status ?? 'pending',
        source: draft.source,
        receiptUrl: draft.receiptUrl ?? null,
        externalId: draft.externalId ?? null,
        tags: sanitizeTags(draft.tags ?? []),
        reviewedAt: null,
        reconciledAt: null,
        reconciledBy: null,
        importBatchId: draft.importBatchId ?? null,
        duplicateOfId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      this.transactions.set(id, transaction);
      created.push(cloneTransaction(transaction));
    }

    return created;
  }

  async findImportJobByUploadId(
    userId: string,
    uploadId: string,
  ): Promise<TransactionImportJob | null> {
    for (const job of this.importJobs.values()) {
      if (job.userId === userId && job.uploadId === uploadId) {
        return { ...job };
      }
    }
    return null;
  }

  async findImportJobByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<TransactionImportJob | null> {
    for (const job of this.importJobs.values()) {
      if (job.userId === userId && job.idempotencyKey === idempotencyKey) {
        return { ...job };
      }
    }
    return null;
  }

  async createImportJob(
    userId: string,
    input: TransactionImportInput,
  ): Promise<TransactionImportJob> {
    const existing = await this.findImportJobByUploadId(userId, input.uploadId);
    if (existing) {
      throw badRequest('TRANSACTIONS_IMPORT_DUPLICATE', 'Upload already processed.');
    }

    if (input.idempotencyKey) {
      const existingKey = await this.findImportJobByIdempotencyKey(userId, input.idempotencyKey);
      if (existingKey) {
        return existingKey;
      }
    }

    const job: StoredImportJob = {
      id: randomUUID(),
      userId,
      accountId: input.accountId,
      uploadId: input.uploadId,
      fileName: input.fileName,
      hasHeaderRow: input.hasHeaderRow,
      columnMapping: { ...input.columnMapping },
      status: 'queued',
      failureReason: null,
      idempotencyKey: input.idempotencyKey ?? null,
      processedCount: 0,
      errorCount: 0,
      estimatedDuration: input.estimatedCompletionSeconds,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.importJobs.set(job.id, job);
    return { ...job };
  }

  async listCategorizationRules(userId: string): Promise<CategorizationRule[]> {
    return this.rules.get(userId)?.map((rule) => ({ ...rule })) ?? [];
  }
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

function cloneTransaction(transaction: Transaction): Transaction {
  return {
    ...transaction,
    postedAt: new Date(transaction.postedAt),
    reviewedAt: transaction.reviewedAt ? new Date(transaction.reviewedAt) : null,
    reconciledAt: transaction.reconciledAt ? new Date(transaction.reconciledAt) : null,
    createdAt: new Date(transaction.createdAt),
    updatedAt: new Date(transaction.updatedAt),
    tags: [...transaction.tags],
  };
}

function filterTransaction(transaction: Transaction, options: TransactionQueryOptions): boolean {
  const filters = options.filters;

  if (filters.accountId && transaction.accountId !== filters.accountId) {
    return false;
  }

  if (filters.categoryId !== undefined) {
    if (filters.categoryId === null && transaction.categoryId !== null) {
      return false;
    }
    if (filters.categoryId !== null && transaction.categoryId !== filters.categoryId) {
      return false;
    }
  }

  if (filters.direction && transaction.direction !== filters.direction) {
    return false;
  }

  if (filters.source && transaction.source !== filters.source) {
    return false;
  }

  if (filters.status && transaction.status !== filters.status) {
    return false;
  }

  if (filters.minAmount !== undefined) {
    if (Number.parseFloat(transaction.amount) < Number.parseFloat(filters.minAmount)) {
      return false;
    }
  }

  if (filters.maxAmount !== undefined) {
    if (Number.parseFloat(transaction.amount) > Number.parseFloat(filters.maxAmount)) {
      return false;
    }
  }

  if (filters.from && transaction.postedAt < filters.from) {
    return false;
  }

  if (filters.to && transaction.postedAt > filters.to) {
    return false;
  }

  if (filters.search) {
    const search = filters.search.toLowerCase();
    const haystack =
      `${transaction.merchantName} ${transaction.description ?? ''} ${transaction.notes ?? ''}`.toLowerCase();
    if (!haystack.includes(search)) {
      return false;
    }
  }

  return true;
}

function compareTransactions(
  a: Transaction,
  b: Transaction,
  options: TransactionQueryOptions,
): number {
  const direction = options.sortDirection === 'asc' ? 1 : -1;

  switch (options.sortField) {
    case 'amount': {
      const diff = Number.parseFloat(a.amount) - Number.parseFloat(b.amount);
      return diff === 0 ? compareByPostedAt(a, b, direction) : diff * direction;
    }
    case 'merchantName': {
      const cmp = a.merchantName.localeCompare(b.merchantName);
      return cmp === 0 ? compareByPostedAt(a, b, direction) : cmp * direction;
    }
    case 'createdAt':
      return (a.createdAt.getTime() - b.createdAt.getTime()) * direction;
    case 'postedAt':
    default:
      return compareByPostedAt(a, b, direction);
  }
}

function compareByPostedAt(a: Transaction, b: Transaction, direction: number): number {
  return (a.postedAt.getTime() - b.postedAt.getTime()) * direction;
}

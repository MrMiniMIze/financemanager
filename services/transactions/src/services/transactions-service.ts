import {
  type BulkTagResult,
  type CategorizationSuggestion,
  type IngestTransactionsResult,
  type Transaction,
  type TransactionDraft,
  type TransactionImportJob,
  type TransactionQueryFilters,
  type TransactionQueryOptions,
  type TransactionsPage,
} from '../domain/models';
import { badRequest, conflict, notFound } from '../errors';
import type {
  BulkTagUpdateInput,
  TransactionImportInput,
  TransactionUpdateInput,
  TransactionsRepository,
} from '../repositories/transactions-repository';
import { CategorizationEngine, type CategorizationInput } from './categorization-engine';

export interface TransactionsServiceOptions {
  importEstimateSeconds: number;
}

export interface ListTransactionsParams {
  page?: number;
  pageSize?: number;
  sortField?: TransactionQueryOptions['sortField'];
  sortDirection?: TransactionQueryOptions['sortDirection'];
  filters?: Partial<TransactionQueryFilters>;
}

export interface BulkTagRequest extends BulkTagUpdateInput {
  transactionIds: string[];
}

export interface ImportRequest extends TransactionImportInput {
  idempotencyKey?: string;
}

export class TransactionsService {
  constructor(
    private readonly repository: TransactionsRepository,
    private readonly options: TransactionsServiceOptions,
  ) {}

  async listTransactions(
    userId: string,
    params: ListTransactionsParams,
  ): Promise<TransactionsPage> {
    const query: TransactionQueryOptions = {
      page: params.page && params.page > 0 ? params.page : 1,
      pageSize: params.pageSize ? Math.min(Math.max(params.pageSize, 1), 100) : 25,
      sortField: params.sortField ?? 'postedAt',
      sortDirection: params.sortDirection ?? 'desc',
      filters: {
        accountId: params.filters?.accountId,
        categoryId: params.filters?.categoryId,
        direction: params.filters?.direction,
        source: params.filters?.source,
        status: params.filters?.status,
        minAmount: params.filters?.minAmount,
        maxAmount: params.filters?.maxAmount,
        from: params.filters?.from,
        to: params.filters?.to,
        search: params.filters?.search?.trim() || undefined,
      },
    };

    return this.repository.paginateTransactions(userId, query);
  }

  async updateTransaction(
    userId: string,
    transactionId: string,
    update: TransactionUpdateInput,
  ): Promise<Transaction> {
    const transaction = await this.repository.findTransactionById(userId, transactionId);
    if (!transaction) {
      throw notFound('TRANSACTIONS_NOT_FOUND', 'Transaction not found.');
    }

    if (
      transaction.status === 'disputed' &&
      update.status &&
      update.status !== transaction.status
    ) {
      throw conflict(
        'TRANSACTIONS_STATUS_IMMUTABLE',
        'Cannot change status for disputed transactions.',
      );
    }

    if (update.tags) {
      update.tags = sanitizeTags(update.tags);
    }

    return this.repository.updateTransaction(userId, transactionId, update);
  }

  async bulkTagTransactions(userId: string, request: BulkTagRequest): Promise<BulkTagResult> {
    if (request.transactionIds.length > 200) {
      throw badRequest(
        'TRANSACTIONS_BULK_TOO_LARGE',
        'Cannot update more than 200 transactions at once.',
      );
    }

    if (request.replaceTags && (!request.addTags || request.addTags.length === 0)) {
      throw badRequest(
        'TRANSACTIONS_BULK_TAGS_REQUIRED',
        'replaceTags requires addTags to supply the new tag set.',
      );
    }

    const update: BulkTagUpdateInput = {
      categoryId: request.categoryId,
      replaceTags: request.replaceTags,
      addTags: request.addTags ? sanitizeTags(request.addTags) : undefined,
      removeTags: request.removeTags ? sanitizeTags(request.removeTags) : undefined,
    };

    return this.repository.bulkUpdateTransactions(userId, request.transactionIds, update);
  }

  async queueImport(userId: string, input: ImportRequest): Promise<TransactionImportJob> {
    const normalized: TransactionImportInput = {
      uploadId: input.uploadId,
      accountId: input.accountId,
      fileName: input.fileName,
      hasHeaderRow: input.hasHeaderRow,
      columnMapping: input.columnMapping,
      estimatedCompletionSeconds:
        input.estimatedCompletionSeconds ?? this.options.importEstimateSeconds,
      idempotencyKey: input.idempotencyKey,
    };

    return this.repository.createImportJob(userId, normalized);
  }

  async ingestTransactions(
    userId: string,
    drafts: TransactionDraft[],
  ): Promise<IngestTransactionsResult> {
    if (!drafts.length) {
      return { created: [], suggestions: {} };
    }

    const engine = await this.buildEngine(userId);
    const suggestions: Record<string, CategorizationSuggestion | null> = {};
    const enrichedDrafts: TransactionDraft[] = [];

    for (const draft of drafts) {
      const normalized: TransactionDraft = {
        ...draft,
        merchantName: draft.merchantName.trim(),
        description: draft.description?.trim() ?? null,
        notes: draft.notes?.trim() ?? null,
        tags: draft.tags ? sanitizeTags(draft.tags) : undefined,
      };

      if (engine) {
        const input: CategorizationInput = {
          merchantName: normalized.merchantName,
          description: normalized.description,
          amount: normalized.amount,
          direction: normalized.direction,
        };
        const suggestion = engine.suggest(input);
        const reference =
          draft.clientReference ?? draft.externalId ?? normalized.merchantName + normalized.amount;
        suggestions[reference] = suggestion;

        if (suggestion) {
          if (!normalized.categoryId && suggestion.categoryId) {
            normalized.categoryId = suggestion.categoryId;
          }

          if ((!normalized.tags || normalized.tags.length === 0) && suggestion.tags.length) {
            normalized.tags = suggestion.tags.slice(0, 20);
          }
        }
      }

      enrichedDrafts.push(normalized);
    }

    const created = await this.repository.createTransactions(userId, enrichedDrafts);
    return { created, suggestions };
  }

  private async buildEngine(userId: string): Promise<CategorizationEngine | null> {
    const rules = await this.repository.listCategorizationRules(userId);
    if (!rules.length) {
      return new CategorizationEngine([]);
    }

    return new CategorizationEngine(rules);
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

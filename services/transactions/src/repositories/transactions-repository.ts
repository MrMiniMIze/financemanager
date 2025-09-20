import type {
  BulkTagResult,
  CategorizationRule,
  Transaction,
  TransactionDraft,
  TransactionImportJob,
  TransactionQueryOptions,
  TransactionStatus,
  TransactionsPage,
} from '../domain/models';

export interface TransactionUpdateInput {
  categoryId?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: TransactionStatus;
}

export interface BulkTagUpdateInput {
  addTags?: string[];
  removeTags?: string[];
  replaceTags?: boolean;
  categoryId?: string | null;
}

export interface TransactionImportInput {
  uploadId: string;
  accountId: string;
  fileName: string;
  hasHeaderRow: boolean;
  columnMapping: Record<string, string>;
  estimatedCompletionSeconds: number;
  idempotencyKey?: string;
}

export interface TransactionsRepository {
  paginateTransactions(userId: string, options: TransactionQueryOptions): Promise<TransactionsPage>;
  findTransactionById(userId: string, transactionId: string): Promise<Transaction | null>;
  updateTransaction(
    userId: string,
    transactionId: string,
    update: TransactionUpdateInput,
  ): Promise<Transaction>;
  bulkUpdateTransactions(
    userId: string,
    ids: string[],
    update: BulkTagUpdateInput,
  ): Promise<BulkTagResult>;
  createTransactions(userId: string, drafts: TransactionDraft[]): Promise<Transaction[]>;
  findImportJobByUploadId(userId: string, uploadId: string): Promise<TransactionImportJob | null>;
  findImportJobByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<TransactionImportJob | null>;
  createImportJob(userId: string, input: TransactionImportInput): Promise<TransactionImportJob>;
  listCategorizationRules(userId: string): Promise<CategorizationRule[]>;
}

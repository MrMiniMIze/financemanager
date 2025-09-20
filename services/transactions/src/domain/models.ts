export type TransactionDirection = 'debit' | 'credit';
export type TransactionSource = 'plaid' | 'import' | 'manual';
export type TransactionStatus = 'pending' | 'cleared' | 'disputed';
export type ImportStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type RuleMatchType =
  | 'merchant_equals'
  | 'merchant_contains'
  | 'description_contains'
  | 'amount_greater_than'
  | 'amount_less_than';

export type TransactionSortField = 'postedAt' | 'amount' | 'merchantName' | 'createdAt';

export interface Transaction {
  id: string;
  userId: string;
  accountId: string;
  postedAt: Date;
  amount: string;
  direction: TransactionDirection;
  merchantName: string;
  description: string | null;
  categoryId: string | null;
  notes: string | null;
  status: TransactionStatus;
  source: TransactionSource;
  receiptUrl: string | null;
  externalId: string | null;
  tags: string[];
  reviewedAt: Date | null;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  importBatchId: string | null;
  duplicateOfId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionDraft {
  accountId: string;
  postedAt: Date;
  amount: string;
  direction: TransactionDirection;
  merchantName: string;
  description?: string | null;
  notes?: string | null;
  status?: TransactionStatus;
  source: TransactionSource;
  receiptUrl?: string | null;
  categoryId?: string | null;
  tags?: string[];
  importBatchId?: string | null;
  externalId?: string | null;
  clientReference?: string;
}

export interface TransactionListItem extends Transaction {
  accountName?: string | null;
}

export interface TransactionQueryFilters {
  accountId?: string;
  categoryId?: string | null;
  direction?: TransactionDirection;
  source?: TransactionSource;
  status?: TransactionStatus;
  minAmount?: string;
  maxAmount?: string;
  from?: Date;
  to?: Date;
  search?: string;
}

export interface TransactionQueryOptions {
  page: number;
  pageSize: number;
  sortField: TransactionSortField;
  sortDirection: 'asc' | 'desc';
  filters: TransactionQueryFilters;
}

export interface TransactionsPage {
  transactions: TransactionListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

export interface TransactionImportJob {
  id: string;
  userId: string;
  accountId: string;
  uploadId: string;
  fileName: string;
  hasHeaderRow: boolean;
  columnMapping: Record<string, string>;
  status: ImportStatus;
  failureReason: string | null;
  idempotencyKey: string | null;
  processedCount: number;
  errorCount: number;
  estimatedDuration: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategorizationRule {
  id: string;
  userId: string;
  name: string;
  priority: number;
  matchType: RuleMatchType;
  matchValue: string;
  categoryId: string | null;
  tags: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategorizationSuggestion {
  categoryId: string | null;
  tags: string[];
  confidence: number;
  source: 'rule' | 'ml' | 'manual';
}

export interface BulkTagResult {
  updatedCount: number;
  failedIds: string[];
}

export interface IngestTransactionsResult {
  created: Transaction[];
  suggestions: Record<string, CategorizationSuggestion | null>;
}

import type {
  Account,
  AccountListItem,
  AccountRetentionPolicy,
  AccountSnapshot,
  AccountStatus,
} from '../domain/models';

export interface LinkedAccountInput {
  userId: string;
  institutionId: string;
  institutionName: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  mask: string;
  currency: string;
  currentBalance: string;
  availableBalance: string | null;
  plaidItemId: string | null;
  plaidAccountId: string | null;
  lastSyncedAt: Date | null;
}

export interface SnapshotInput {
  capturedAt: Date;
  currentBalance: string;
  availableBalance: string | null;
}

export interface LinkAccountsPayload {
  accounts: LinkedAccountInput[];
  snapshots?: Record<string, SnapshotInput | undefined>;
}

export interface AccountQueryOptions {
  status?: AccountStatus;
  includeSnapshots?: boolean;
  search?: string;
}

export interface AccountUpdateInput {
  accountName?: string;
  status?: Extract<AccountStatus, 'active' | 'archived'>;
  notes?: string | null;
}

export interface AccountDeletionInput {
  retention: AccountRetentionPolicy;
  reason?: string | null;
  scheduledPurgeAt: Date;
}

export interface AccountRepository {
  linkAccounts(payload: LinkAccountsPayload): Promise<Account[]>;
  listAccounts(userId: string, options: AccountQueryOptions): Promise<AccountListItem[]>;
  findAccountById(userId: string, accountId: string): Promise<Account | null>;
  updateAccount(userId: string, accountId: string, update: AccountUpdateInput): Promise<Account>;
  markAccountForDeletion(
    userId: string,
    accountId: string,
    input: AccountDeletionInput,
  ): Promise<Account>;
  recordSnapshot(accountId: string, snapshot: SnapshotInput): Promise<AccountSnapshot>;
  findSnapshots(accountId: string, limit?: number): Promise<AccountSnapshot[]>;
}

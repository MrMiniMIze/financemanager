export type AccountStatus = 'active' | 'archived' | 'pending_unlink';

export type AccountRetentionPolicy = 'keep_transactions' | 'purge_after_30_days';

export interface Account {
  id: string;
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
  status: AccountStatus;
  lastSyncedAt: Date | null;
  notes: string | null;
  plaidItemId: string | null;
  plaidAccountId: string | null;
  createdAt: Date;
  updatedAt: Date;
  pendingDeletionAt: Date | null;
  retentionPolicy: AccountRetentionPolicy | null;
}

export interface AccountSnapshot {
  id: string;
  accountId: string;
  capturedAt: Date;
  currentBalance: string;
  availableBalance: string | null;
  createdAt: Date;
}

export interface LinkedAccountResult {
  account: Account;
  snapshots: AccountSnapshot[];
}

export interface AccountListItem extends Account {
  snapshots?: AccountSnapshot[];
}

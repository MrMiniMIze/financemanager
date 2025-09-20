import { randomUUID } from 'node:crypto';

import type {
  Account,
  AccountListItem,
  AccountRetentionPolicy,
  AccountSnapshot,
} from '../src/domain/models';
import type {
  AccountDeletionInput,
  AccountQueryOptions,
  AccountRepository,
  AccountUpdateInput,
  LinkAccountsPayload,
  LinkedAccountInput,
  SnapshotInput,
} from '../src/repositories/account-repository';

interface StoredAccount extends Account {
  snapshots: AccountSnapshot[];
}

export class InMemoryAccountRepository implements AccountRepository {
  private accounts = new Map<string, StoredAccount>();

  async linkAccounts(payload: LinkAccountsPayload): Promise<Account[]> {
    const results: Account[] = [];

    for (const account of payload.accounts) {
      const existing = this.findExistingAccount(account);
      const stored = existing
        ? this.updateAccountRecord(existing, account)
        : this.createAccountRecord(account);

      const snapshotInput = payload.snapshots?.[stored.plaidAccountId ?? stored.id];
      if (snapshotInput) {
        this.upsertSnapshot(stored, snapshotInput);
      }

      results.push(this.cloneAccount(stored));
    }

    return results;
  }

  async listAccounts(userId: string, options: AccountQueryOptions): Promise<AccountListItem[]> {
    return Array.from(this.accounts.values())
      .filter((account) => account.userId === userId)
      .filter((account) => (options.status ? account.status === options.status : true))
      .filter((account) =>
        options.search
          ? account.accountName.toLowerCase().includes(options.search.toLowerCase()) ||
            account.institutionName.toLowerCase().includes(options.search.toLowerCase())
          : true,
      )
      .map((account) => this.cloneAccount(account, options.includeSnapshots));
  }

  async findAccountById(userId: string, accountId: string): Promise<Account | null> {
    const account = this.accounts.get(accountId);
    if (!account || account.userId !== userId) {
      return null;
    }

    return this.cloneAccount(account);
  }

  async updateAccount(
    userId: string,
    accountId: string,
    update: AccountUpdateInput,
  ): Promise<Account> {
    const account = this.accounts.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    if (update.accountName) {
      account.accountName = update.accountName;
    }

    if (update.status) {
      account.status = update.status;
    }

    if (update.notes !== undefined) {
      account.notes = update.notes;
    }

    account.updatedAt = new Date();
    return this.cloneAccount(account);
  }

  async markAccountForDeletion(
    userId: string,
    accountId: string,
    input: AccountDeletionInput,
  ): Promise<Account> {
    const account = this.accounts.get(accountId);
    if (!account || account.userId !== userId) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    account.status = 'pending_unlink';
    account.pendingDeletionAt = input.scheduledPurgeAt;
    account.retentionPolicy = input.retention;
    account.notes = input.reason ?? account.notes;
    account.updatedAt = new Date();

    return this.cloneAccount(account);
  }

  async recordSnapshot(accountId: string, snapshot: SnapshotInput): Promise<AccountSnapshot> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    const stored = this.upsertSnapshot(account, snapshot);
    return { ...stored };
  }

  async findSnapshots(accountId: string, limit = 30): Promise<AccountSnapshot[]> {
    const account = this.accounts.get(accountId);
    if (!account) {
      return [];
    }

    return account.snapshots
      .slice()
      .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
      .slice(0, limit)
      .map((snapshot) => ({ ...snapshot }));
  }

  private findExistingAccount(input: LinkedAccountInput): StoredAccount | null {
    for (const account of this.accounts.values()) {
      if (account.userId !== input.userId) {
        continue;
      }

      if (input.plaidAccountId && account.plaidAccountId === input.plaidAccountId) {
        return account;
      }

      if (account.institutionId === input.institutionId && account.mask === input.mask) {
        return account;
      }
    }

    return null;
  }

  private createAccountRecord(input: LinkedAccountInput): StoredAccount {
    const id = randomUUID();
    const now = new Date();
    const account: StoredAccount = {
      id,
      userId: input.userId,
      institutionId: input.institutionId,
      institutionName: input.institutionName,
      accountName: input.accountName,
      accountType: input.accountType,
      accountSubtype: input.accountSubtype,
      mask: input.mask,
      currency: input.currency,
      currentBalance: input.currentBalance,
      availableBalance: input.availableBalance,
      status: 'active',
      lastSyncedAt: input.lastSyncedAt,
      notes: null,
      plaidItemId: input.plaidItemId,
      plaidAccountId: input.plaidAccountId,
      createdAt: now,
      updatedAt: now,
      pendingDeletionAt: null,
      retentionPolicy: null,
      snapshots: [],
    };

    this.accounts.set(account.id, account);
    return account;
  }

  private updateAccountRecord(account: StoredAccount, input: LinkedAccountInput): StoredAccount {
    account.institutionId = input.institutionId;
    account.institutionName = input.institutionName;
    account.accountName = input.accountName;
    account.accountType = input.accountType;
    account.accountSubtype = input.accountSubtype;
    account.mask = input.mask;
    account.currency = input.currency;
    account.currentBalance = input.currentBalance;
    account.availableBalance = input.availableBalance;
    account.lastSyncedAt = input.lastSyncedAt;
    account.plaidItemId = input.plaidItemId;
    account.plaidAccountId = input.plaidAccountId;
    account.updatedAt = new Date();
    account.status = 'active';
    account.pendingDeletionAt = null;
    account.retentionPolicy = null;
    return account;
  }

  private upsertSnapshot(account: StoredAccount, snapshot: SnapshotInput): AccountSnapshot {
    const existingIndex = account.snapshots.findIndex(
      (item) => item.capturedAt.getTime() === snapshot.capturedAt.getTime(),
    );
    const stored: AccountSnapshot = {
      id: existingIndex >= 0 ? account.snapshots[existingIndex].id : randomUUID(),
      accountId: account.id,
      capturedAt: snapshot.capturedAt,
      currentBalance: snapshot.currentBalance,
      availableBalance: snapshot.availableBalance,
      createdAt: existingIndex >= 0 ? account.snapshots[existingIndex].createdAt : new Date(),
    };

    if (existingIndex >= 0) {
      account.snapshots[existingIndex] = stored;
    } else {
      account.snapshots.push(stored);
    }

    return stored;
  }

  private cloneAccount(account: StoredAccount, includeSnapshots = false): AccountListItem {
    return {
      id: account.id,
      userId: account.userId,
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
      lastSyncedAt: account.lastSyncedAt,
      notes: account.notes,
      plaidItemId: account.plaidItemId,
      plaidAccountId: account.plaidAccountId,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      pendingDeletionAt: account.pendingDeletionAt,
      retentionPolicy: account.retentionPolicy,
      snapshots: includeSnapshots
        ? account.snapshots.map((snapshot) => ({ ...snapshot }))
        : undefined,
    };
  }
}

import { randomUUID } from 'node:crypto';

import type {
  Account,
  AccountListItem,
  AccountRetentionPolicy,
  AccountSnapshot,
} from '../domain/models';
import { badRequest, notFound } from '../errors';
import type {
  AccountRepository,
  AccountUpdateInput,
  LinkAccountsPayload,
} from '../repositories/account-repository';

export interface LinkAccountsInput {
  publicToken: string;
  institutionId: string;
  metadata: {
    institutionName: string;
    linkSessionId: string;
    accounts: {
      id: string;
      name: string;
      mask: string;
      type: string;
      subtype?: string;
    }[];
  };
}

export interface ListAccountsOptions {
  status?: 'active' | 'archived' | 'pending_unlink';
  includeSnapshots?: boolean;
  search?: string;
}

export interface AddSnapshotInput {
  accountId: string;
  capturedAt: Date;
  currentBalance: string;
  availableBalance: string | null;
}

export interface DeleteAccountInput {
  retention: AccountRetentionPolicy;
  reason?: string | null;
}

export interface DeleteAccountResult {
  accountId: string;
  status: 'pending_unlink' | 'archived' | 'active';
  scheduledPurgeAt: Date;
}

export interface PlaidAccountPayload {
  plaidAccountId: string;
  name: string;
  mask: string;
  accountType: string;
  accountSubtype: string | null;
  currency: string;
  currentBalance: string;
  availableBalance: string | null;
  lastSyncedAt: Date;
}

export interface PlaidExchangeResult {
  itemId: string;
  institutionId: string;
  institutionName: string;
  accounts: PlaidAccountPayload[];
}

export interface PlaidLinkClient {
  exchangePublicToken(userId: string, input: LinkAccountsInput): Promise<PlaidExchangeResult>;
}

const DEFAULT_PLAID_CLIENT = new (class implements PlaidLinkClient {
  async exchangePublicToken(
    userId: string,
    input: LinkAccountsInput,
  ): Promise<PlaidExchangeResult> {
    const now = new Date();
    return {
      itemId: 'item_' + randomUUID(),
      institutionId: input.institutionId,
      institutionName: input.metadata.institutionName,
      accounts: input.metadata.accounts.map((account, index) => {
        const base = 2400 + index * 125;
        return {
          plaidAccountId: account.id,
          name: account.name,
          mask: account.mask,
          accountType: account.subtype ?? account.type,
          accountSubtype: account.subtype ?? null,
          currency: 'USD',
          currentBalance: base.toFixed(2),
          availableBalance: (base - 200).toFixed(2),
          lastSyncedAt: now,
        } satisfies PlaidAccountPayload;
      }),
    };
  }
})();

export class AccountsService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly plaidClient: PlaidLinkClient = DEFAULT_PLAID_CLIENT,
  ) {}

  async linkAccounts(userId: string, input: LinkAccountsInput): Promise<Account[]> {
    if (!input.metadata.accounts.length) {
      throw badRequest('ACCOUNTS_LINK_METADATA_INVALID', 'No accounts provided by Plaid metadata.');
    }

    const exchange = await this.plaidClient.exchangePublicToken(userId, input);
    const payload: LinkAccountsPayload = {
      accounts: exchange.accounts.map((account) => ({
        userId,
        institutionId: exchange.institutionId,
        institutionName: exchange.institutionName,
        accountName: account.name,
        accountType: account.accountType,
        accountSubtype: account.accountSubtype,
        mask: account.mask,
        currency: account.currency,
        currentBalance: account.currentBalance,
        availableBalance: account.availableBalance,
        plaidItemId: exchange.itemId,
        plaidAccountId: account.plaidAccountId,
        lastSyncedAt: account.lastSyncedAt,
      })),
      snapshots: Object.fromEntries(
        exchange.accounts.map((account) => [
          account.plaidAccountId,
          {
            capturedAt: account.lastSyncedAt,
            currentBalance: account.currentBalance,
            availableBalance: account.availableBalance,
          },
        ]),
      ),
    };

    return this.repository.linkAccounts(payload);
  }

  async listAccounts(
    userId: string,
    options: ListAccountsOptions = {},
  ): Promise<AccountListItem[]> {
    return this.repository.listAccounts(userId, options);
  }

  async updateAccount(
    userId: string,
    accountId: string,
    update: AccountUpdateInput,
  ): Promise<Account> {
    const existing = await this.repository.findAccountById(userId, accountId);
    if (!existing) {
      throw notFound('ACCOUNTS_NOT_FOUND', 'Account not found.');
    }

    return this.repository.updateAccount(userId, accountId, update);
  }

  async addSnapshot(input: AddSnapshotInput): Promise<AccountSnapshot> {
    return this.repository.recordSnapshot(input.accountId, {
      capturedAt: input.capturedAt,
      currentBalance: input.currentBalance,
      availableBalance: input.availableBalance,
    });
  }

  async deleteAccount(
    userId: string,
    accountId: string,
    input: DeleteAccountInput,
  ): Promise<DeleteAccountResult> {
    const existing = await this.repository.findAccountById(userId, accountId);
    if (!existing) {
      throw notFound('ACCOUNTS_NOT_FOUND', 'Account not found.');
    }

    const scheduledPurgeAt = this.computePurgeTimestamp(input.retention);
    const updated = await this.repository.markAccountForDeletion(userId, accountId, {
      retention: input.retention,
      reason: input.reason ?? null,
      scheduledPurgeAt,
    });

    return {
      accountId: updated.id,
      status: updated.status,
      scheduledPurgeAt,
    };
  }

  private computePurgeTimestamp(retention: AccountRetentionPolicy): Date {
    const now = new Date();
    if (retention === 'purge_after_30_days') {
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    return now;
  }
}

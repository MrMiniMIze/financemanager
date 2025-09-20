import type { PrismaClient } from '@prisma/client';

import type { Account, AccountListItem, AccountSnapshot } from '../domain/models';
import type {
  AccountDeletionInput,
  AccountQueryOptions,
  AccountRepository,
  AccountUpdateInput,
  LinkAccountsPayload,
  LinkedAccountInput,
  SnapshotInput,
} from './account-repository';

function decimalToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '0';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return value.toFixed(2);
  }

  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const raw = (value as { toString(): string }).toString();
    return raw.includes('.') ? raw : raw + '.00';
  }

  return '0';
}

function nullableDecimalToString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return decimalToString(value);
}

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async linkAccounts(payload: LinkAccountsPayload): Promise<Account[]> {
    const accounts: Account[] = [];

    await this.prisma.$transaction(async (transaction) => {
      for (const input of payload.accounts) {
        const record = await this.upsertAccount(transaction as PrismaTransaction, input);
        const snapshotInput = payload.snapshots?.[record.plaidAccountId ?? record.id];

        if (snapshotInput) {
          await this.createSnapshot(transaction as PrismaTransaction, record.id, snapshotInput);
        }

        accounts.push(mapAccount(record));
      }
    });

    return accounts;
  }

  async listAccounts(userId: string, options: AccountQueryOptions): Promise<AccountListItem[]> {
    const delegate = this.prisma as unknown as AccountsPrismaClient;
    const records = await delegate.financialAccount.findMany({
      where: buildAccountWhere(userId, options),
      orderBy: { createdAt: 'desc' },
      include: options.includeSnapshots
        ? { snapshots: { orderBy: { capturedAt: 'desc' }, take: 12 } }
        : undefined,
    });

    return records.map((record) => mapAccount(record, options.includeSnapshots));
  }

  async findAccountById(userId: string, accountId: string): Promise<Account | null> {
    const delegate = this.prisma as unknown as AccountsPrismaClient;
    const record = await delegate.financialAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    return record ? mapAccount(record) : null;
  }

  async updateAccount(
    userId: string,
    accountId: string,
    update: AccountUpdateInput,
  ): Promise<Account> {
    const delegate = this.prisma as unknown as AccountsPrismaClient;
    const record = await delegate.financialAccount.update({
      where: { id: accountId },
      data: {
        accountName: update.accountName,
        status: update.status,
        notes: update.notes ?? undefined,
      },
    });

    if (record.userId !== userId) {
      throw new Error('ACCOUNT_ACCESS_DENIED');
    }

    return mapAccount(record);
  }

  async markAccountForDeletion(
    userId: string,
    accountId: string,
    input: AccountDeletionInput,
  ): Promise<Account> {
    const delegate = this.prisma as unknown as AccountsPrismaClient;
    const record = await delegate.financialAccount.update({
      where: { id: accountId },
      data: {
        status: 'pending_unlink',
        pendingDeletionAt: input.scheduledPurgeAt,
        retentionPolicy: input.retention,
        deletionReason: input.reason ?? null,
      },
    });

    if (record.userId !== userId) {
      throw new Error('ACCOUNT_ACCESS_DENIED');
    }

    return mapAccount(record);
  }

  async recordSnapshot(accountId: string, snapshot: SnapshotInput): Promise<AccountSnapshot> {
    const delegate = this.prisma as unknown as AccountsPrismaClient;
    const record = await delegate.accountSnapshot.create({
      data: {
        accountId,
        capturedAt: snapshot.capturedAt,
        currentBalance: snapshot.currentBalance,
        availableBalance: snapshot.availableBalance,
      },
    });

    return mapSnapshot(record);
  }

  async findSnapshots(accountId: string, limit = 30): Promise<AccountSnapshot[]> {
    const delegate = this.prisma as unknown as AccountsPrismaClient;
    const records = await delegate.accountSnapshot.findMany({
      where: { accountId },
      orderBy: { capturedAt: 'desc' },
      take: limit,
    });

    return records.map(mapSnapshot);
  }

  private async upsertAccount(prisma: PrismaTransaction, input: LinkedAccountInput) {
    const delegate = prisma;

    const existing = input.plaidAccountId
      ? await delegate.financialAccount.findFirst({
          where: {
            userId: input.userId,
            plaidAccountId: input.plaidAccountId,
          },
        })
      : await delegate.financialAccount.findFirst({
          where: {
            userId: input.userId,
            institutionId: input.institutionId,
            mask: input.mask,
          },
        });

    if (existing) {
      return delegate.financialAccount.update({
        where: { id: existing.id },
        data: buildAccountUpdateData(input),
      });
    }

    return delegate.financialAccount.create({
      data: buildAccountCreateData(input),
    });
  }

  private async createSnapshot(
    prisma: PrismaTransaction,
    accountId: string,
    snapshot: SnapshotInput,
  ) {
    const delegate = prisma;
    return delegate.accountSnapshot.upsert({
      where: {
        accountId_capturedAt: {
          accountId,
          capturedAt: snapshot.capturedAt,
        },
      },
      update: {
        currentBalance: snapshot.currentBalance,
        availableBalance: snapshot.availableBalance,
      },
      create: {
        accountId,
        capturedAt: snapshot.capturedAt,
        currentBalance: snapshot.currentBalance,
        availableBalance: snapshot.availableBalance,
      },
    });
  }
}

function mapAccount(record: any, includeSnapshots = false): AccountListItem {
  const base: AccountListItem = {
    id: record.id,
    userId: record.userId,
    institutionId: record.institutionId,
    institutionName: record.institutionName,
    accountName: record.accountName,
    accountType: record.accountType,
    accountSubtype: record.accountSubtype,
    mask: record.mask,
    currency: record.currency,
    currentBalance: decimalToString(record.currentBalance),
    availableBalance: nullableDecimalToString(record.availableBalance),
    status: record.status,
    lastSyncedAt: record.lastSyncedAt,
    notes: record.notes ?? null,
    plaidItemId: record.plaidItemId ?? null,
    plaidAccountId: record.plaidAccountId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pendingDeletionAt: record.pendingDeletionAt ?? null,
    retentionPolicy: record.retentionPolicy ?? null,
    snapshots: undefined,
  };

  if (includeSnapshots && Array.isArray(record.snapshots)) {
    base.snapshots = record.snapshots.map(mapSnapshot);
  }

  return base;
}

function mapSnapshot(record: any): AccountSnapshot {
  return {
    id: record.id,
    accountId: record.accountId,
    capturedAt: record.capturedAt,
    currentBalance: decimalToString(record.currentBalance),
    availableBalance: nullableDecimalToString(record.availableBalance),
    createdAt: record.createdAt,
  };
}

function buildAccountWhere(userId: string, options: AccountQueryOptions) {
  const where: Record<string, unknown> = { userId };

  if (options.status) {
    where.status = options.status;
  }

  if (options.search) {
    where.OR = [
      { accountName: { contains: options.search, mode: 'insensitive' } },
      { institutionName: { contains: options.search, mode: 'insensitive' } },
    ];
  }

  return where;
}

function buildAccountUpdateData(input: LinkedAccountInput) {
  return {
    institutionId: input.institutionId,
    institutionName: input.institutionName,
    accountName: input.accountName,
    accountType: input.accountType,
    accountSubtype: input.accountSubtype,
    mask: input.mask,
    currency: input.currency,
    currentBalance: input.currentBalance,
    availableBalance: input.availableBalance,
    lastSyncedAt: input.lastSyncedAt,
    plaidItemId: input.plaidItemId,
    plaidAccountId: input.plaidAccountId,
  };
}

function buildAccountCreateData(input: LinkedAccountInput) {
  return {
    userId: input.userId,
    ...buildAccountUpdateData(input),
  };
}

interface AccountsPrismaClient {
  financialAccount: {
    findMany(args: any): Promise<any[]>;
    findFirst(args: any): Promise<any | null>;
    create(args: any): Promise<any>;
    update(args: any): Promise<any>;
  };
  accountSnapshot: {
    findMany(args: any): Promise<any[]>;
    create(args: any): Promise<any>;
    upsert(args: any): Promise<any>;
  };
}

type PrismaTransaction = AccountsPrismaClient;

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { CategorizationRule } from '../src/domain/models';
import { TransactionsService } from '../src/services/transactions-service';
import { InMemoryTransactionsRepository } from './in-memory-transactions-repository';

const USER_ID = randomUUID();

function createService(ruleOverrides: CategorizationRule[] = []) {
  const repository = new InMemoryTransactionsRepository();
  if (ruleOverrides.length) {
    repository.setRules(USER_ID, ruleOverrides);
  }
  const service = new TransactionsService(repository, { importEstimateSeconds: 45 });
  return { repository, service };
}

describe('TransactionsService', () => {
  it('ingests transactions and applies categorization rules', async () => {
    const rules: CategorizationRule[] = [
      {
        id: randomUUID(),
        userId: USER_ID,
        name: 'Coffee rule',
        priority: 1,
        matchType: 'merchant_contains',
        matchValue: 'coffee',
        categoryId: 'cat-coffee',
        tags: ['coffee', 'treat'],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const { service, repository } = createService(rules);

    const result = await service.ingestTransactions(USER_ID, [
      {
        accountId: randomUUID(),
        postedAt: new Date('2025-09-14T12:30:00Z'),
        amount: '12.35',
        direction: 'debit',
        merchantName: 'Blue Bottle Coffee',
        description: 'Morning latte',
        source: 'plaid',
      },
    ]);

    expect(result.created).toHaveLength(1);
    expect(result.created[0].categoryId).toBe('cat-coffee');
    expect(result.created[0].tags).toContain('coffee');

    const stored = await repository.findTransactionById(USER_ID, result.created[0].id);
    expect(stored?.categoryId).toBe('cat-coffee');
  });

  it('prevents changing status for disputed transactions', async () => {
    const { service } = createService();

    const ingestion = await service.ingestTransactions(USER_ID, [
      {
        accountId: randomUUID(),
        postedAt: new Date(),
        amount: '100.00',
        direction: 'debit',
        merchantName: 'Contested Vendor',
        status: 'disputed',
        source: 'manual',
      },
    ]);

    const transaction = ingestion.created[0];

    await expect(
      service.updateTransaction(USER_ID, transaction.id, {
        status: 'cleared',
      }),
    ).rejects.toMatchObject({ code: 'TRANSACTIONS_STATUS_IMMUTABLE' });
  });

  it('applies bulk tags and category updates', async () => {
    const { service } = createService();

    const created = await service.ingestTransactions(USER_ID, [
      {
        accountId: randomUUID(),
        postedAt: new Date(),
        amount: '45.78',
        direction: 'debit',
        merchantName: 'Supermarket',
        source: 'manual',
      },
      {
        accountId: randomUUID(),
        postedAt: new Date(),
        amount: '20.00',
        direction: 'debit',
        merchantName: 'Supermarket',
        source: 'manual',
      },
    ]);

    const ids = created.created.map((transaction) => transaction.id);

    const result = await service.bulkTagTransactions(USER_ID, {
      transactionIds: ids,
      addTags: ['groceries'],
      categoryId: 'cat-groceries',
    });

    expect(result.updatedCount).toBe(2);

    const updated = await service.listTransactions(USER_ID, { page: 1, pageSize: 10 });
    expect(
      updated.transactions.every((transaction) => transaction.categoryId === 'cat-groceries'),
    ).toBe(true);
    expect(updated.transactions[0].tags).toContain('groceries');
  });

  it('enqueues import job with idempotency key reuse', async () => {
    const { service } = createService();
    const accountId = randomUUID();
    const uploadId = randomUUID();

    const first = await service.queueImport(USER_ID, {
      uploadId,
      accountId,
      fileName: 'transactions.csv',
      hasHeaderRow: true,
      columnMapping: {
        date: 'Date',
        description: 'Description',
        amount: 'Amount',
        direction: 'Type',
      },
      idempotencyKey: 'import-key-1',
    });

    expect(first.status).toBe('queued');

    const retry = await service.queueImport(USER_ID, {
      uploadId,
      accountId,
      fileName: 'transactions.csv',
      hasHeaderRow: true,
      columnMapping: {
        date: 'Date',
        description: 'Description',
        amount: 'Amount',
        direction: 'Type',
      },
      idempotencyKey: 'import-key-1',
    });

    expect(retry.id).toBe(first.id);
  });

  it('supports filtering and sorting in listings', async () => {
    const { service } = createService();

    await service.ingestTransactions(USER_ID, [
      {
        accountId: 'acct-1',
        postedAt: new Date('2025-01-01T10:00:00Z'),
        amount: '100.00',
        direction: 'debit',
        merchantName: 'Rent',
        source: 'manual',
        categoryId: 'cat-housing',
      },
      {
        accountId: 'acct-1',
        postedAt: new Date('2025-02-01T10:00:00Z'),
        amount: '50.00',
        direction: 'debit',
        merchantName: 'Coffee Shop',
        source: 'manual',
        categoryId: 'cat-coffee',
      },
    ]);

    const filtered = await service.listTransactions(USER_ID, {
      page: 1,
      pageSize: 10,
      sortField: 'amount',
      sortDirection: 'asc',
      filters: { categoryId: 'cat-coffee' },
    });

    expect(filtered.transactions).toHaveLength(1);
    expect(filtered.transactions[0].merchantName).toBe('Coffee Shop');
  });
});

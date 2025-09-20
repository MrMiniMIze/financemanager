import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { InMemoryTransactionsRepository } from './in-memory-transactions-repository';

const USER_ID = randomUUID();
const AUTH_HEADERS = {
  'x-user-id': USER_ID,
  'x-user-email': 'casey@example.com',
  'x-user-timezone': 'America/New_York',
  'idempotency-key': 'default-key',
};

describe('Transactions routes', () => {
  let app: FastifyInstance;
  let repository: InMemoryTransactionsRepository;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/test';
  });

  beforeEach(async () => {
    repository = new InMemoryTransactionsRepository();
    app = await buildApp({ repository, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    delete process.env.DATABASE_URL;
  });

  it('lists transactions with pagination', async () => {
    await repository.createTransactions(USER_ID, [
      {
        accountId: randomUUID(),
        postedAt: new Date('2025-09-14T12:30:00Z'),
        amount: '45.28',
        direction: 'debit',
        merchantName: 'Blue Bottle Coffee',
        description: 'Coffee',
        source: 'plaid',
      },
    ]);

    const response = await request(app.server)
      .get('/transactions')
      .set(AUTH_HEADERS)
      .query({ page: 1, pageSize: 10 })
      .expect(200);

    expect(response.body.data.transactions).toHaveLength(1);
  });

  it('queues import job', async () => {
    const response = await request(app.server)
      .post('/transactions/import')
      .set(AUTH_HEADERS)
      .send({
        uploadId: randomUUID(),
        accountId: randomUUID(),
        fileName: 'checking.csv',
        hasHeaderRow: true,
        columnMapping: {
          date: 'Date',
          description: 'Description',
          amount: 'Amount',
          direction: 'Type',
        },
      })
      .expect(202);

    expect(response.body.data.status).toBe('queued');
  });

  it('updates a transaction', async () => {
    const created = await repository.createTransactions(USER_ID, [
      {
        accountId: randomUUID(),
        postedAt: new Date(),
        amount: '19.99',
        direction: 'debit',
        merchantName: 'Streaming Service',
        source: 'manual',
      },
    ]);

    const transactionId = created[0].id;

    const response = await request(app.server)
      .patch(`/transactions/${transactionId}`)
      .set(AUTH_HEADERS)
      .send({
        categoryId: 'cat-subscriptions',
        notes: 'Monthly plan',
        tags: ['entertainment'],
        status: 'cleared',
      })
      .expect(200);

    expect(response.body.data.transaction.categoryId).toBe('cat-subscriptions');
    expect(response.body.data.transaction.tags).toContain('entertainment');
  });

  it('bulk updates tags', async () => {
    const created = await repository.createTransactions(USER_ID, [
      {
        accountId: randomUUID(),
        postedAt: new Date(),
        amount: '9.50',
        direction: 'debit',
        merchantName: 'Cafe',
        source: 'manual',
      },
      {
        accountId: randomUUID(),
        postedAt: new Date(),
        amount: '4.25',
        direction: 'debit',
        merchantName: 'Cafe',
        source: 'manual',
      },
    ]);

    await request(app.server)
      .post('/transactions/bulk-tag')
      .set(AUTH_HEADERS)
      .send({
        transactionIds: created.map((transaction) => transaction.id),
        addTags: ['coffee'],
        replaceTags: false,
      })
      .expect(200);

    const list = await request(app.server).get('/transactions').set(AUTH_HEADERS).expect(200);

    expect(list.body.data.transactions[0].tags).toContain('coffee');
  });
});

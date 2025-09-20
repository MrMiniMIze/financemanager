import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { InMemoryAccountRepository } from './in-memory-account-repository';

const USER_ID = randomUUID();
const AUTH_HEADERS = {
  'x-user-id': USER_ID,
  'x-user-email': 'casey@example.com',
  'x-user-timezone': 'America/New_York',
};

describe('Accounts routes', () => {
  let app: FastifyInstance;
  let repository: InMemoryAccountRepository;
  let buildApp: (typeof import('../src/app'))['buildApp'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/test';
    ({ buildApp } = await import('../src/app'));
  });

  beforeEach(async () => {
    repository = new InMemoryAccountRepository();
    app = await buildApp({ repository, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    delete process.env.DATABASE_URL;
  });

  it('links accounts', async () => {
    const response = await request(app.server)
      .post('/accounts/link')
      .set(AUTH_HEADERS)
      .send({
        publicToken: 'public-token-abc',
        institutionId: 'ins_123',
        metadata: {
          institutionName: 'Plaid Bank',
          linkSessionId: randomUUID(),
          accounts: [
            {
              id: 'acct-1',
              name: 'Primary Checking',
              mask: '1234',
              type: 'depository',
              subtype: 'checking',
            },
          ],
        },
      })
      .expect(201);

    expect(response.body.data.linkedAccounts).toHaveLength(1);
  });

  it('lists accounts with snapshots', async () => {
    await request(app.server)
      .post('/accounts/link')
      .set(AUTH_HEADERS)
      .send({
        publicToken: 'public-token-def',
        institutionId: 'ins_456',
        metadata: {
          institutionName: 'Chase',
          linkSessionId: randomUUID(),
          accounts: [
            {
              id: 'acct-1',
              name: 'Checking',
              mask: '5678',
              type: 'depository',
              subtype: 'checking',
            },
          ],
        },
      });

    const response = await request(app.server)
      .get('/accounts')
      .query({ includeSnapshots: 'true' })
      .set(AUTH_HEADERS)
      .expect(200);

    expect(response.body.data.accounts).toHaveLength(1);
    expect(response.body.data.accounts[0].snapshots).toHaveLength(1);
  });

  it('validates update payload', async () => {
    const link = await request(app.server)
      .post('/accounts/link')
      .set(AUTH_HEADERS)
      .send({
        publicToken: 'public-token-ghi',
        institutionId: 'ins_789',
        metadata: {
          institutionName: 'Citi',
          linkSessionId: randomUUID(),
          accounts: [
            { id: 'acct-1', name: 'Savings', mask: '9012', type: 'depository', subtype: 'savings' },
          ],
        },
      });

    const accountId = link.body.data.linkedAccounts[0].id as string;

    await request(app.server)
      .patch('/accounts/' + accountId)
      .set(AUTH_HEADERS)
      .send({})
      .expect(400);

    const update = await request(app.server)
      .patch('/accounts/' + accountId)
      .set(AUTH_HEADERS)
      .send({ accountName: 'Emergency Savings' })
      .expect(200);

    expect(update.body.data.account.accountName).toBe('Emergency Savings');
  });

  it('marks account for deletion', async () => {
    const link = await request(app.server)
      .post('/accounts/link')
      .set(AUTH_HEADERS)
      .send({
        publicToken: 'public-token-jkl',
        institutionId: 'ins_246',
        metadata: {
          institutionName: 'Amex',
          linkSessionId: randomUUID(),
          accounts: [
            {
              id: 'acct-1',
              name: 'Platinum',
              mask: '3456',
              type: 'credit',
              subtype: 'credit card',
            },
          ],
        },
      });

    const accountId = link.body.data.linkedAccounts[0].id as string;

    const response = await request(app.server)
      .delete('/accounts/' + accountId)
      .set(AUTH_HEADERS)
      .send({
        retention: 'keep_transactions',
        reason: 'user_request',
      })
      .expect(202);

    expect(response.body.data.status).toBe('pending_unlink');
  });
});

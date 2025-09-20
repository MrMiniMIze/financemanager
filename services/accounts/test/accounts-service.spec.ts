import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { AccountsService, type LinkAccountsInput } from '../src/services/accounts-service';
import { InMemoryAccountRepository } from './in-memory-account-repository';

const USER_ID = randomUUID();

describe('AccountsService', () => {
  let service: AccountsService;
  let repository: InMemoryAccountRepository;

  beforeEach(() => {
    repository = new InMemoryAccountRepository();
    service = new AccountsService(repository);
  });

  it('links accounts using Plaid metadata', async () => {
    const input: LinkAccountsInput = {
      publicToken: 'public-token-123',
      institutionId: 'ins_123',
      metadata: {
        institutionName: 'Chase',
        linkSessionId: randomUUID(),
        accounts: [
          {
            id: 'account-1',
            name: 'Everyday Checking',
            mask: '1234',
            type: 'depository',
            subtype: 'checking',
          },
        ],
      },
    };

    const accounts = await service.linkAccounts(USER_ID, input);

    expect(accounts).toHaveLength(1);
    expect(accounts[0].institutionName).toBe('Chase');
    expect(accounts[0].currentBalance).toBe('2400.00');

    const listed = await service.listAccounts(USER_ID, { includeSnapshots: true });
    expect(listed[0].snapshots).toHaveLength(1);
  });

  it('updates account metadata', async () => {
    const [linked] = await service.linkAccounts(USER_ID, {
      publicToken: 'token',
      institutionId: 'ins_456',
      metadata: {
        institutionName: 'Capital One',
        linkSessionId: randomUUID(),
        accounts: [
          {
            id: 'acct-1',
            name: 'Capital Checking',
            mask: '5678',
            type: 'depository',
            subtype: 'checking',
          },
        ],
      },
    });

    const updated = await service.updateAccount(USER_ID, linked.id, {
      accountName: 'Family Checking',
      status: 'archived',
      notes: 'closing soon',
    });

    expect(updated.accountName).toBe('Family Checking');
    expect(updated.status).toBe('archived');
    expect(updated.notes).toBe('closing soon');
  });

  it('marks account for deletion and schedules purge', async () => {
    const [linked] = await service.linkAccounts(USER_ID, {
      publicToken: 'token',
      institutionId: 'ins_789',
      metadata: {
        institutionName: 'Ally',
        linkSessionId: randomUUID(),
        accounts: [
          { id: 'acct-1', name: 'Savings', mask: '9012', type: 'depository', subtype: 'savings' },
        ],
      },
    });

    const result = await service.deleteAccount(USER_ID, linked.id, {
      retention: 'purge_after_30_days',
      reason: 'switched_bank',
    });

    expect(result.status).toBe('pending_unlink');
    expect(result.scheduledPurgeAt.getTime()).toBeGreaterThan(Date.now());
  });
});

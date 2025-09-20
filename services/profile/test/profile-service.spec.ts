import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ProfileService } from '../src/services/profile-service';
import { InMemoryProfileRepository } from './in-memory-profile-repository';

describe('ProfileService', () => {
  const userId = randomUUID();
  let repository: InMemoryProfileRepository;
  let service: ProfileService;

  beforeEach(() => {
    repository = new InMemoryProfileRepository();
    service = new ProfileService(repository);
  });

  it('creates a profile with defaults when none exists', async () => {
    const profile = await service.getProfile(userId, {
      email: 'casey@example.com',
      timezone: 'America/New_York',
    });

    expect(profile.email).toBe('casey@example.com');
    expect(profile.timezone).toBe('America/New_York');
    expect(profile.firstName).toBe('');
    expect(profile.createdAt).toBeInstanceOf(Date);
  });

  it('updates profile details', async () => {
    await service.getProfile(userId);

    const updated = await service.updateProfile(userId, {
      firstName: 'Casey',
      lastName: 'Patel',
      phone: '+12025550123',
      timezone: 'America/New_York',
      email: 'casey@example.com',
    });

    expect(updated.firstName).toBe('Casey');
    expect(updated.phone).toBe('+12025550123');
    expect(updated.email).toBe('casey@example.com');
  });

  it('returns default preferences when none exist', async () => {
    await service.getProfile(userId);

    const preferences = await service.getPreferences(userId);
    expect(preferences.theme).toBe('system');
    expect(preferences.notificationChannels.email).toBe(true);
    expect(preferences.featureFlags).toEqual({});
  });

  it('updates preferences and preserves existing feature flags when omitted', async () => {
    await service.getProfile(userId);

    await service.updatePreferences(userId, {
      theme: 'dark',
      aiAssistantOptIn: true,
      language: 'en-US',
      currency: 'USD',
      notificationChannels: {
        email: true,
        sms: false,
        push: true,
        inApp: true,
      },
      digestSchedule: 'weekly',
      featureFlags: { betaGoals: true },
    });

    const second = await service.updatePreferences(userId, {
      theme: 'light',
      aiAssistantOptIn: false,
      language: 'en-GB',
      currency: 'GBP',
      notificationChannels: {
        email: true,
        sms: true,
        push: false,
        inApp: true,
      },
      digestSchedule: 'monthly',
    });

    expect(second.theme).toBe('light');
    expect(second.featureFlags).toEqual({ betaGoals: true });
    expect(second.notificationChannels.sms).toBe(true);
  });

  it('persists widget layouts and prevents overlap', async () => {
    await service.getProfile(userId);

    const layout = await service.updateWidgetLayout(userId, 'desktop', [
      { widgetId: 'cashFlow', x: 0, y: 0, w: 6, h: 3 },
      { widgetId: 'spending', x: 6, y: 0, w: 6, h: 3 },
    ]);

    expect(layout.layout).toHaveLength(2);

    await expect(
      service.updateWidgetLayout(userId, 'desktop', [
        { widgetId: 'a', x: 0, y: 0, w: 6, h: 3 },
        { widgetId: 'b', x: 5, y: 1, w: 6, h: 3 },
      ]),
    ).rejects.toThrow(/PROFILE_WIDGET_CONFLICT/);
  });
});

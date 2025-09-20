import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';
import { InMemoryProfileRepository } from './in-memory-profile-repository';

const USER_ID = randomUUID();
const AUTH_HEADERS = {
  'x-user-id': USER_ID,
  'x-user-email': 'casey@example.com',
  'x-user-timezone': 'America/New_York',
};

describe('Profile routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({
      repository: new InMemoryProfileRepository(),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns profile details', async () => {
    const response = await request(app.server).get('/profile').set(AUTH_HEADERS).expect(200);

    expect(response.body.data.profile.email).toBe('casey@example.com');
    expect(response.body.data.profile.timezone).toBe('America/New_York');
  });

  it('updates profile metadata', async () => {
    await request(app.server).get('/profile').set(AUTH_HEADERS);

    const response = await request(app.server)
      .put('/profile')
      .set(AUTH_HEADERS)
      .send({
        firstName: 'Casey',
        lastName: 'Patel',
        phone: '+12025550123',
        timezone: 'America/New_York',
      })
      .expect(200);

    expect(response.body.data.profile.firstName).toBe('Casey');
  });

  it('rejects invalid phone numbers', async () => {
    await request(app.server)
      .put('/profile')
      .set(AUTH_HEADERS)
      .send({
        firstName: 'Casey',
        lastName: 'Patel',
        phone: '202-555-0123',
        timezone: 'America/New_York',
      })
      .expect(400)
      .then((response) => {
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });
  });

  it('returns and updates preferences', async () => {
    const initial = await request(app.server)
      .get('/profile/preferences')
      .set(AUTH_HEADERS)
      .expect(200);

    expect(initial.body.data.preferences.theme).toBe('system');

    const updated = await request(app.server)
      .put('/profile/preferences')
      .set(AUTH_HEADERS)
      .send({
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
      })
      .expect(200);

    expect(updated.body.data.preferences.theme).toBe('dark');
  });

  it('stores dashboard widget layout and detects conflicts', async () => {
    const layoutResponse = await request(app.server)
      .put('/profile/widgets')
      .set(AUTH_HEADERS)
      .send({
        breakpoint: 'desktop',
        layout: [
          { widgetId: 'cashFlow', x: 0, y: 0, w: 6, h: 3 },
          { widgetId: 'spending', x: 6, y: 0, w: 6, h: 3 },
        ],
      })
      .expect(200);

    expect(layoutResponse.body.data.layout).toHaveLength(2);

    await request(app.server)
      .put('/profile/widgets')
      .set(AUTH_HEADERS)
      .send({
        breakpoint: 'desktop',
        layout: [
          { widgetId: 'a', x: 0, y: 0, w: 6, h: 3 },
          { widgetId: 'b', x: 5, y: 1, w: 6, h: 3 },
        ],
      })
      .expect(409)
      .then((response) => {
        expect(response.body.error.code).toBe('PROFILE_WIDGET_CONFLICT');
      });
  });
});

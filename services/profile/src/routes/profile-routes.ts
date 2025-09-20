import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Preferences, Profile, WidgetLayout } from '../domain/models';

const PhoneSchema = z.string().regex(/^\+[1-9]\d{1,14}$/);

const ProfileUpdateSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.union([PhoneSchema, z.null()]).optional(),
  timezone: z.string().min(1).max(64),
});

const PreferencesUpdateSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  aiAssistantOptIn: z.boolean(),
  language: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  currency: z.string().length(3),
  notificationChannels: z.object({
    email: z.boolean(),
    sms: z.boolean(),
    push: z.boolean(),
    inApp: z.boolean(),
  }),
  digestSchedule: z.enum(['daily', 'weekly', 'monthly', 'never']),
  featureFlags: z.record(z.boolean()).optional(),
});

const WidgetLayoutItemSchema = z.object({
  widgetId: z.string().min(1).max(64),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(12),
  minW: z.number().int().min(1).max(12).optional(),
  minH: z.number().int().min(1).max(12).optional(),
});

const WidgetLayoutUpdateSchema = z.object({
  layout: z.array(WidgetLayoutItemSchema).min(1),
  breakpoint: z.enum(['mobile', 'tablet', 'desktop']),
});

export const profileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (request) => ({
    status: 'ok',
    correlationId: request.id,
  }));

  fastify.get('/profile', async (request, reply) => {
    const user = await fastify.authenticate(request, reply);
    const context = fastify.resolveProfileContext(request);
    const profile = await fastify.profileService.getProfile(user.id, context);

    reply.send({
      data: {
        profile: serializeProfile(profile),
      },
    });
  });

  fastify.put('/profile', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ body: ProfileUpdateSchema }, async (request, reply) => {
      const user = request.authUser!;
      const body = request.validated.body;

      const profile = await fastify.profileService.updateProfile(user.id, {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone ?? null,
        timezone: body.timezone,
        email: user.email ?? undefined,
      });

      reply.send({
        data: {
          profile: serializeProfile(profile),
        },
      });
    }),
  });

  fastify.get('/profile/preferences', async (request, reply) => {
    const user = await fastify.authenticate(request, reply);
    const preferences = await fastify.profileService.getPreferences(user.id);

    reply.send({
      data: {
        preferences: serializePreferences(preferences),
      },
    });
  });

  fastify.put('/profile/preferences', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ body: PreferencesUpdateSchema }, async (request, reply) => {
      const user = request.authUser!;
      const body = request.validated.body;

      const preferences = await fastify.profileService.updatePreferences(user.id, body);
      reply.send({
        data: {
          preferences: serializePreferences(preferences),
        },
      });
    }),
  });

  fastify.put('/profile/widgets', {
    preHandler: fastify.authenticate.bind(fastify),
    handler: fastify.withValidation({ body: WidgetLayoutUpdateSchema }, async (request, reply) => {
      const user = request.authUser!;
      const body = request.validated.body;

      const layout = await fastify.profileService.updateWidgetLayout(
        user.id,
        body.breakpoint,
        body.layout,
      );

      reply.send({
        data: {
          layout: serializeLayout(layout),
        },
      });
    }),
  });
};

function serializeProfile(profile: Profile) {
  return {
    userId: profile.userId,
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    timezone: profile.timezone,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function serializePreferences(preferences: Preferences) {
  return {
    theme: preferences.theme,
    aiAssistantOptIn: preferences.aiAssistantOptIn,
    language: preferences.language,
    currency: preferences.currency,
    notificationChannels: preferences.notificationChannels,
    digestSchedule: preferences.digestSchedule,
    featureFlags: preferences.featureFlags,
  };
}

function serializeLayout(layout: WidgetLayout) {
  return layout.layout;
}

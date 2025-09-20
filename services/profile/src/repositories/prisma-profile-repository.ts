import type { Prisma, PrismaClient } from '@prisma/client';

import type {
  LayoutBreakpoint,
  NotificationChannels,
  Preferences,
  Profile,
  WidgetLayout,
  WidgetLayoutItem,
} from '../domain/models';
import type {
  CreateProfileInput,
  PreferencesInput,
  ProfileRepository,
  UpdateProfileInput,
} from './profile-repository';

const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = {
  email: true,
  sms: false,
  push: true,
  inApp: true,
};

export class PrismaProfileRepository implements ProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findProfileByUserId(userId: string): Promise<Profile | null> {
    const record = await this.prisma.userProfile.findUnique({ where: { userId } });
    return record ? mapProfile(record) : null;
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const record = await this.prisma.userProfile.create({
      data: {
        userId: input.userId,
        email: input.email ?? null,
        firstName: input.firstName ?? '',
        lastName: input.lastName ?? '',
        phone: input.phone ?? null,
        timezone: input.timezone ?? 'UTC',
      },
    });

    return mapProfile(record);
  }

  async updateProfile(userId: string, update: UpdateProfileInput): Promise<Profile> {
    const record = await this.prisma.userProfile.upsert({
      where: { userId },
      update: {
        firstName: update.firstName,
        lastName: update.lastName,
        phone: update.phone,
        timezone: update.timezone,
        ...(update.email !== undefined ? { email: update.email } : {}),
      },
      create: {
        userId,
        firstName: update.firstName,
        lastName: update.lastName,
        phone: update.phone,
        timezone: update.timezone,
        email: update.email ?? null,
      },
    });

    return mapProfile(record);
  }

  async findPreferencesByUserId(userId: string): Promise<Preferences | null> {
    const record = await this.prisma.profilePreferences.findUnique({ where: { userId } });
    return record ? mapPreferences(record) : null;
  }

  async upsertPreferences(userId: string, input: PreferencesInput): Promise<Preferences> {
    const baseData = {
      theme: input.theme,
      aiAssistantOptIn: input.aiAssistantOptIn,
      language: input.language,
      currency: input.currency,
      notificationChannels: serializeNotificationChannels(input.notificationChannels),
      digestSchedule: input.digestSchedule,
    } satisfies Partial<Prisma.ProfilePreferencesUncheckedCreateInput>;

    const featureFlagsData =
      input.featureFlags !== undefined
        ? { featureFlags: serializeFeatureFlags(input.featureFlags) }
        : {};

    const record = await this.prisma.profilePreferences.upsert({
      where: { userId },
      update: {
        ...baseData,
        ...featureFlagsData,
      },
      create: {
        userId,
        ...baseData,
        featureFlags: serializeFeatureFlags(input.featureFlags ?? {}),
      },
    });

    return mapPreferences(record);
  }

  async upsertLayout(
    userId: string,
    breakpoint: LayoutBreakpoint,
    layout: WidgetLayoutItem[],
  ): Promise<WidgetLayout> {
    const record = await this.prisma.dashboardLayout.upsert({
      where: { userId_breakpoint: { userId, breakpoint } },
      update: {
        layout: serializeLayout(layout),
      },
      create: {
        userId,
        breakpoint,
        layout: serializeLayout(layout),
      },
    });

    return mapLayout(record);
  }
}

function mapProfile(record: Prisma.UserProfile): Profile {
  return {
    userId: record.userId,
    email: record.email,
    firstName: record.firstName,
    lastName: record.lastName,
    phone: record.phone,
    timezone: record.timezone,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapPreferences(record: Prisma.ProfilePreferences): Preferences {
  return {
    userId: record.userId,
    theme: record.theme,
    aiAssistantOptIn: record.aiAssistantOptIn,
    language: record.language,
    currency: record.currency,
    notificationChannels: mapNotificationChannels(record.notificationChannels),
    digestSchedule: record.digestSchedule,
    featureFlags: mapFeatureFlags(record.featureFlags),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapLayout(record: Prisma.DashboardLayout): WidgetLayout {
  return {
    userId: record.userId,
    breakpoint: record.breakpoint,
    layout: Array.isArray(record.layout) ? (record.layout as WidgetLayoutItem[]) : [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapNotificationChannels(value: Prisma.JsonValue): NotificationChannels {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    return {
      email: typeof raw.email === 'boolean' ? raw.email : DEFAULT_NOTIFICATION_CHANNELS.email,
      sms: typeof raw.sms === 'boolean' ? raw.sms : DEFAULT_NOTIFICATION_CHANNELS.sms,
      push: typeof raw.push === 'boolean' ? raw.push : DEFAULT_NOTIFICATION_CHANNELS.push,
      inApp: typeof raw.inApp === 'boolean' ? raw.inApp : DEFAULT_NOTIFICATION_CHANNELS.inApp,
    };
  }

  return { ...DEFAULT_NOTIFICATION_CHANNELS };
}

function serializeNotificationChannels(channels: NotificationChannels): Prisma.JsonValue {
  return {
    email: channels.email,
    sms: channels.sms,
    push: channels.push,
    inApp: channels.inApp,
  } satisfies Record<string, boolean>;
}

function mapFeatureFlags(value: Prisma.JsonValue): Record<string, boolean> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).map(([key, val]) => [key, Boolean(val)]));
  }

  return {};
}

function serializeFeatureFlags(flags: Record<string, boolean>): Prisma.JsonValue {
  return Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, Boolean(value)]));
}

function serializeLayout(layout: WidgetLayoutItem[]): Prisma.JsonValue {
  return layout.map((item) => ({
    widgetId: item.widgetId,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    ...(item.minW !== undefined ? { minW: item.minW } : {}),
    ...(item.minH !== undefined ? { minH: item.minH } : {}),
  }));
}

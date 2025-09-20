import { randomUUID } from 'node:crypto';

import type {
  LayoutBreakpoint,
  Preferences,
  Profile,
  WidgetLayout,
  WidgetLayoutItem,
} from '../src/domain/models';
import type {
  CreateProfileInput,
  PreferencesInput,
  ProfileRepository,
  UpdateProfileInput,
} from '../src/repositories/profile-repository';

interface StoredLayout extends WidgetLayout {
  id: string;
}

export class InMemoryProfileRepository implements ProfileRepository {
  private profiles = new Map<string, Profile>();
  private preferences = new Map<string, Preferences>();
  private layouts = new Map<string, Map<LayoutBreakpoint, StoredLayout>>();

  async findProfileByUserId(userId: string): Promise<Profile | null> {
    return this.profiles.get(userId) ?? null;
  }

  async createProfile(input: CreateProfileInput): Promise<Profile> {
    const now = new Date();
    const profile: Profile = {
      userId: input.userId,
      email: input.email ?? null,
      firstName: input.firstName ?? '',
      lastName: input.lastName ?? '',
      phone: input.phone ?? null,
      timezone: input.timezone ?? 'UTC',
      createdAt: now,
      updatedAt: now,
    };

    this.profiles.set(profile.userId, profile);
    return profile;
  }

  async updateProfile(userId: string, update: UpdateProfileInput): Promise<Profile> {
    const existing = this.profiles.get(userId);
    const now = new Date();

    const next: Profile = {
      userId,
      email: update.email ?? existing?.email ?? null,
      firstName: update.firstName,
      lastName: update.lastName,
      phone: update.phone ?? null,
      timezone: update.timezone,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.profiles.set(userId, next);
    return next;
  }

  async findPreferencesByUserId(userId: string): Promise<Preferences | null> {
    return this.preferences.get(userId) ?? null;
  }

  async upsertPreferences(userId: string, input: PreferencesInput): Promise<Preferences> {
    const now = new Date();
    const existing = this.preferences.get(userId);
    const next: Preferences = {
      userId,
      theme: input.theme,
      aiAssistantOptIn: input.aiAssistantOptIn,
      language: input.language,
      currency: input.currency,
      notificationChannels: { ...input.notificationChannels },
      digestSchedule: input.digestSchedule,
      featureFlags: { ...(input.featureFlags ?? existing?.featureFlags ?? {}) },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.preferences.set(userId, next);
    return next;
  }

  async upsertLayout(
    userId: string,
    breakpoint: LayoutBreakpoint,
    layout: WidgetLayoutItem[],
  ): Promise<WidgetLayout> {
    const now = new Date();
    const forUser = this.layouts.get(userId) ?? new Map<LayoutBreakpoint, StoredLayout>();
    const existing = forUser.get(breakpoint);
    const stored: StoredLayout = {
      id: existing?.id ?? randomUUID(),
      userId,
      breakpoint,
      layout: layout.map((item) => ({ ...item })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    forUser.set(breakpoint, stored);
    this.layouts.set(userId, forUser);

    return stored;
  }
}

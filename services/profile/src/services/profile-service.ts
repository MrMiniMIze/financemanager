import { conflict } from '../errors';
import type {
  LayoutBreakpoint,
  Preferences,
  Profile,
  WidgetLayout,
  WidgetLayoutItem,
} from '../domain/models';
import type {
  PreferencesInput,
  ProfileRepository,
  UpdateProfileInput,
} from '../repositories/profile-repository';

const DEFAULT_PREFERENCES: Omit<Preferences, 'userId' | 'createdAt' | 'updatedAt'> = {
  theme: 'system',
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
  featureFlags: {},
};

export interface GetProfileContext {
  email?: string | null;
  timezone?: string | null;
}

export class ProfileService {
  constructor(private readonly repository: ProfileRepository) {}

  async getProfile(userId: string, context: GetProfileContext = {}): Promise<Profile> {
    return this.ensureProfile(userId, context);
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile> {
    await this.ensureProfile(userId, { email: input.email });
    return this.repository.updateProfile(userId, input);
  }

  async getPreferences(userId: string): Promise<Preferences> {
    await this.ensureProfile(userId);
    const existing = await this.repository.findPreferencesByUserId(userId);
    if (existing) {
      return existing;
    }

    return this.repository.upsertPreferences(userId, {
      ...DEFAULT_PREFERENCES,
    });
  }

  async updatePreferences(userId: string, input: PreferencesInput): Promise<Preferences> {
    await this.ensureProfile(userId);
    const current = await this.repository.findPreferencesByUserId(userId);
    const featureFlags =
      input.featureFlags ?? current?.featureFlags ?? DEFAULT_PREFERENCES.featureFlags;

    return this.repository.upsertPreferences(userId, {
      ...input,
      featureFlags,
    });
  }

  async updateWidgetLayout(
    userId: string,
    breakpoint: LayoutBreakpoint,
    layout: WidgetLayoutItem[],
  ): Promise<WidgetLayout> {
    await this.ensureProfile(userId);
    this.assertNoOverlap(layout);
    return this.repository.upsertLayout(userId, breakpoint, layout);
  }

  private async ensureProfile(userId: string, context: GetProfileContext = {}): Promise<Profile> {
    const existing = await this.repository.findProfileByUserId(userId);
    if (existing) {
      if (context.email && existing.email !== context.email) {
        return this.repository.updateProfile(userId, {
          firstName: existing.firstName,
          lastName: existing.lastName,
          phone: existing.phone,
          timezone: existing.timezone,
          email: context.email,
        });
      }

      return existing;
    }

    return this.repository.createProfile({
      userId,
      email: context.email ?? null,
      timezone: context.timezone ?? undefined,
    });
  }

  private assertNoOverlap(layout: WidgetLayoutItem[]) {
    for (let i = 0; i < layout.length; i += 1) {
      const current = layout[i];
      for (let j = i + 1; j < layout.length; j += 1) {
        const other = layout[j];
        if (rectanglesOverlap(current, other)) {
          throw conflict(
            'PROFILE_WIDGET_CONFLICT',
            'Widget layout contains overlapping positions.',
          );
        }
      }
    }
  }
}

function rectanglesOverlap(a: WidgetLayoutItem, b: WidgetLayoutItem) {
  const aRight = a.x + a.w;
  const aBottom = a.y + a.h;
  const bRight = b.x + b.w;
  const bBottom = b.y + b.h;

  return a.x < bRight && aRight > b.x && a.y < bBottom && aBottom > b.y;
}

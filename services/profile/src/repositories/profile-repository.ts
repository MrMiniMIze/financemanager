import type {
  LayoutBreakpoint,
  Preferences,
  Profile,
  WidgetLayout,
  WidgetLayoutItem,
} from '../domain/models';

export interface CreateProfileInput {
  userId: string;
  email?: string | null;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  timezone?: string;
}

export interface UpdateProfileInput {
  firstName: string;
  lastName: string;
  phone: string | null;
  timezone: string;
  email?: string | null;
}

export interface PreferencesInput {
  theme: Preferences['theme'];
  aiAssistantOptIn: Preferences['aiAssistantOptIn'];
  language: Preferences['language'];
  currency: Preferences['currency'];
  notificationChannels: Preferences['notificationChannels'];
  digestSchedule: Preferences['digestSchedule'];
  featureFlags?: Preferences['featureFlags'];
}

export interface ProfileRepository {
  findProfileByUserId(userId: string): Promise<Profile | null>;
  createProfile(input: CreateProfileInput): Promise<Profile>;
  updateProfile(userId: string, update: UpdateProfileInput): Promise<Profile>;
  findPreferencesByUserId(userId: string): Promise<Preferences | null>;
  upsertPreferences(userId: string, input: PreferencesInput): Promise<Preferences>;
  upsertLayout(
    userId: string,
    breakpoint: LayoutBreakpoint,
    layout: WidgetLayoutItem[],
  ): Promise<WidgetLayout>;
}

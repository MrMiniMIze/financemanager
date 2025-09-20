export type ThemePreference = 'light' | 'dark' | 'system';
export type DigestSchedule = 'daily' | 'weekly' | 'monthly' | 'never';
export type LayoutBreakpoint = 'mobile' | 'tablet' | 'desktop';

export interface Profile {
  userId: string;
  email: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationChannels {
  email: boolean;
  sms: boolean;
  push: boolean;
  inApp: boolean;
}

export interface Preferences {
  userId: string;
  theme: ThemePreference;
  aiAssistantOptIn: boolean;
  language: string;
  currency: string;
  notificationChannels: NotificationChannels;
  digestSchedule: DigestSchedule;
  featureFlags: Record<string, boolean>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WidgetLayoutItem {
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface WidgetLayout {
  userId: string;
  breakpoint: LayoutBreakpoint;
  layout: WidgetLayoutItem[];
  createdAt: Date;
  updatedAt: Date;
}

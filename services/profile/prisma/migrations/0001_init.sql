CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "ThemePreference" AS ENUM ('light', 'dark', 'system');
CREATE TYPE "DigestSchedule" AS ENUM ('daily', 'weekly', 'monthly', 'never');
CREATE TYPE "LayoutBreakpoint" AS ENUM ('mobile', 'tablet', 'desktop');

CREATE TABLE "user_profiles" (
  "user_id" UUID PRIMARY KEY,
  "email" TEXT UNIQUE,
  "first_name" VARCHAR(100) NOT NULL DEFAULT '',
  "last_name" VARCHAR(100) NOT NULL DEFAULT '',
  "phone" VARCHAR(32),
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "profile_preferences" (
  "user_id" UUID PRIMARY KEY,
  "theme" "ThemePreference" NOT NULL DEFAULT 'system',
  "ai_assistant_opt_in" BOOLEAN NOT NULL DEFAULT TRUE,
  "language" VARCHAR(10) NOT NULL DEFAULT 'en-US',
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "notification_channels" JSONB NOT NULL DEFAULT jsonb_build_object('email', true, 'sms', false, 'push', true, 'inApp', true),
  "digest_schedule" "DigestSchedule" NOT NULL DEFAULT 'weekly',
  "feature_flags" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "profile_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_profiles"("user_id") ON DELETE CASCADE
);

CREATE TABLE "dashboard_layouts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "breakpoint" "LayoutBreakpoint" NOT NULL,
  "layout" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "dashboard_layouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_profiles"("user_id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "dashboard_layouts_user_id_breakpoint_key" ON "dashboard_layouts" ("user_id", "breakpoint");

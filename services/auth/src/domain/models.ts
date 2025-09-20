export type PlanTier = 'free' | 'pro' | 'family';
export type UserStatus = 'active' | 'invited' | 'suspended';
export type MfaMethod = 'totp';
export type MfaChallengeType = 'setup' | 'login' | 'recovery';

export interface MfaConfiguration {
  id: string;
  method: MfaMethod;
  secretEncrypted: string;
  deviceName?: string | null;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthUser {
  id: string;
  email: string;
  status: UserStatus;
  planTier: PlanTier;
  roles: string[];
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  timezone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  mfa?: MfaConfiguration | null;
}

export interface AuthUserWithSecrets extends AuthUser {
  passwordHash: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByTokenId: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface EmailVerificationTokenRecord {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface AuditEventInput {
  action: string;
  actor: string;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MfaChallengeRecord {
  id: string;
  userId: string;
  userMfaId?: string | null;
  method: MfaMethod;
  type: MfaChallengeType;
  secretEncrypted?: string | null;
  deviceName?: string | null;
  context?: Record<string, unknown> | null;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

export interface MfaBackupCodeRecord {
  id: string;
  userMfaId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

export interface MfaRememberedDeviceRecord {
  id: string;
  userMfaId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

import type {
  AuthUser,
  AuthUserWithSecrets,
  AuditEventInput,
  EmailVerificationTokenRecord,
  MfaBackupCodeRecord,
  MfaChallengeRecord,
  MfaConfiguration,
  MfaRememberedDeviceRecord,
  PasswordResetTokenRecord,
  RefreshTokenRecord,
} from '../domain/models';

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  planTier: AuthUser['planTier'];
  firstName?: string | null;
  lastName?: string | null;
  timezone?: string | null;
  roles?: string[];
}

export interface SaveRefreshTokenInput {
  id: string;
  userId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RefreshTokenWithUser extends RefreshTokenRecord {
  user: AuthUser;
}

export interface CreateMfaChallengeInput {
  userId: string;
  userMfaId?: string | null;
  method: MfaChallengeRecord['method'];
  type: MfaChallengeRecord['type'];
  secretEncrypted?: string | null;
  deviceName?: string | null;
  context?: Record<string, unknown> | null;
  expiresAt: Date;
}

export interface UpsertMfaSettingInput {
  userId: string;
  method: MfaConfiguration['method'];
  secretEncrypted: string;
  deviceName?: string | null;
  activatedAt?: Date | null;
}

export interface ReplaceBackupCodesInput {
  userMfaId: string;
  codes: {
    id: string;
    codeHash: string;
  }[];
}

export interface CreateRememberedDeviceInput {
  userMfaId: string;
  tokenHash: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface UpdateRememberedDeviceInput {
  id: string;
  lastUsedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthRepository {
  createUser(input: CreateUserInput): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<AuthUserWithSecrets | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  markEmailVerified(userId: string, verifiedAt: Date): Promise<AuthUser>;
  saveEmailVerificationToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<EmailVerificationTokenRecord>;
  consumeEmailVerificationToken(token: string): Promise<EmailVerificationTokenRecord | null>;
  saveRefreshToken(input: SaveRefreshTokenInput): Promise<RefreshTokenRecord>;
  findRefreshTokenById(id: string): Promise<RefreshTokenWithUser | null>;
  revokeRefreshToken(id: string, revokedAt: Date, replacedByTokenId?: string | null): Promise<void>;
  revokeRefreshTokensForUser(userId: string, revokedAt: Date): Promise<void>;
  createPasswordResetToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<PasswordResetTokenRecord>;
  consumePasswordResetToken(
    token: string,
    consumedAt: Date,
  ): Promise<PasswordResetTokenRecord | null>;
  updatePasswordHash(userId: string, passwordHash: string, when: Date): Promise<void>;
  updateLastLogin(userId: string, when: Date): Promise<void>;
  createAuditEvent(event: AuditEventInput): Promise<void>;

  getMfaConfiguration(userId: string): Promise<MfaConfiguration | null>;
  upsertMfaSetting(input: UpsertMfaSettingInput): Promise<MfaConfiguration>;
  activateMfaSetting(userMfaId: string, activatedAt: Date): Promise<MfaConfiguration>;
  deleteMfaSetting(userMfaId: string): Promise<void>;
  listMfaBackupCodes(userMfaId: string): Promise<MfaBackupCodeRecord[]>;
  replaceMfaBackupCodes(input: ReplaceBackupCodesInput): Promise<void>;
  markBackupCodeUsed(id: string, when: Date): Promise<void>;

  createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallengeRecord>;
  findMfaChallengeById(id: string): Promise<MfaChallengeRecord | null>;
  incrementMfaChallengeAttempts(id: string, attempts: number): Promise<void>;
  consumeMfaChallenge(id: string, when: Date): Promise<MfaChallengeRecord | null>;
  deleteMfaChallenge(id: string): Promise<void>;

  listRememberedDevices(userMfaId: string): Promise<MfaRememberedDeviceRecord[]>;
  createRememberedDevice(input: CreateRememberedDeviceInput): Promise<MfaRememberedDeviceRecord>;
  updateRememberedDevice(input: UpdateRememberedDeviceInput): Promise<void>;
  deleteRememberedDevice(id: string): Promise<void>;
  deleteExpiredRememberedDevices(userMfaId: string, now: Date): Promise<void>;
}

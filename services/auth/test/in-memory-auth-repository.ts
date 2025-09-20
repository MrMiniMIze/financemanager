import { randomUUID } from 'node:crypto';

import type {
  AuthRepository,
  CreateMfaChallengeInput,
  CreateRememberedDeviceInput,
  CreateUserInput,
  RefreshTokenWithUser,
  ReplaceBackupCodesInput,
  SaveRefreshTokenInput,
  UpdateRememberedDeviceInput,
  UpsertMfaSettingInput,
} from '../src/repositories/auth-repository';
import type {
  AuditEventInput,
  AuthUser,
  AuthUserWithSecrets,
  EmailVerificationTokenRecord,
  MfaBackupCodeRecord,
  MfaChallengeRecord,
  MfaConfiguration,
  MfaRememberedDeviceRecord,
  PasswordResetTokenRecord,
  RefreshTokenRecord,
} from '../src/domain/models';

interface StoredUser extends AuthUserWithSecrets {}

interface StoredMfaSetting extends MfaConfiguration {
  userId: string;
}

interface StoredMfaChallenge extends MfaChallengeRecord {}

interface StoredBackupCode extends MfaBackupCodeRecord {}

interface StoredRememberedDevice extends MfaRememberedDeviceRecord {}

export class InMemoryAuthRepository implements AuthRepository {
  private users = new Map<string, StoredUser>();

  private emailIndex = new Map<string, string>();

  private emailTokens = new Map<string, EmailVerificationTokenRecord>();

  private refreshTokens = new Map<string, RefreshTokenRecord>();

  private passwordResetTokens = new Map<string, PasswordResetTokenRecord>();

  private auditEvents: AuditEventInput[] = [];

  private mfaSettingsById = new Map<string, StoredMfaSetting>();

  private mfaSettingsByUser = new Map<string, StoredMfaSetting>();

  private mfaChallenges = new Map<string, StoredMfaChallenge>();

  private backupCodesById = new Map<string, StoredBackupCode>();

  private backupCodesByMfa = new Map<string, Set<string>>();

  private rememberedDevicesById = new Map<string, StoredRememberedDevice>();

  private rememberedDevicesByMfa = new Map<string, Set<string>>();

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const now = new Date();
    const id = randomUUID();

    const user: StoredUser = {
      id,
      email: input.email,
      status: 'active',
      planTier: input.planTier,
      roles: input.roles ?? ['user'],
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      timezone: input.timezone ?? null,
      passwordHash: input.passwordHash,
      mfa: null,
    };

    this.users.set(id, user);
    this.emailIndex.set(user.email, id);

    return this.cloneUser(user);
  }

  async findUserByEmail(email: string): Promise<AuthUserWithSecrets | null> {
    const id = this.emailIndex.get(email);
    if (!id) {
      return null;
    }

    const user = this.users.get(id);
    return user ? { ...user } : null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const user = this.users.get(id);
    return user ? this.cloneUser(user) : null;
  }

  async markEmailVerified(userId: string, verifiedAt: Date): Promise<AuthUser> {
    const user = this.getUserOrThrow(userId);
    user.emailVerifiedAt = verifiedAt;
    user.updatedAt = new Date();
    this.users.set(userId, user);

    return this.cloneUser(user);
  }

  async saveEmailVerificationToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<EmailVerificationTokenRecord> {
    const record: EmailVerificationTokenRecord = {
      id: randomUUID(),
      userId,
      token,
      expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };

    this.emailTokens.set(token, record);

    return { ...record };
  }

  async consumeEmailVerificationToken(token: string): Promise<EmailVerificationTokenRecord | null> {
    const record = this.emailTokens.get(token);

    if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
      return null;
    }

    const updated = { ...record, consumedAt: new Date() };
    this.emailTokens.set(token, updated);
    return { ...updated };
  }

  async saveRefreshToken(input: SaveRefreshTokenInput): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    };

    this.refreshTokens.set(record.id, record);

    return { ...record };
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenWithUser | null> {
    const record = this.refreshTokens.get(id);
    if (!record) {
      return null;
    }

    const user = this.users.get(record.userId);

    if (!user) {
      return null;
    }

    return {
      ...record,
      user: this.cloneUser(user),
    };
  }

  async revokeRefreshToken(
    id: string,
    revokedAt: Date,
    replacedByTokenId?: string | null,
  ): Promise<void> {
    const record = this.refreshTokens.get(id);
    if (!record) {
      return;
    }

    record.revokedAt = revokedAt;
    record.replacedByTokenId = replacedByTokenId ?? null;
    this.refreshTokens.set(id, record);
  }

  async revokeRefreshTokensForUser(userId: string, revokedAt: Date): Promise<void> {
    for (const [id, record] of this.refreshTokens.entries()) {
      if (record.userId === userId && !record.revokedAt) {
        record.revokedAt = revokedAt;
        this.refreshTokens.set(id, record);
      }
    }
  }

  async createPasswordResetToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<PasswordResetTokenRecord> {
    const record: PasswordResetTokenRecord = {
      id: randomUUID(),
      userId,
      token,
      expiresAt,
      consumedAt: null,
      createdAt: new Date(),
    };

    this.passwordResetTokens.set(token, record);

    return { ...record };
  }

  async consumePasswordResetToken(
    token: string,
    consumedAt: Date,
  ): Promise<PasswordResetTokenRecord | null> {
    const record = this.passwordResetTokens.get(token);

    if (!record || record.consumedAt || record.expiresAt.getTime() < consumedAt.getTime()) {
      return null;
    }

    const updated = { ...record, consumedAt };
    this.passwordResetTokens.set(token, updated);

    return { ...updated };
  }

  async updatePasswordHash(userId: string, passwordHash: string, when: Date): Promise<void> {
    const user = this.getUserOrThrow(userId);
    user.passwordHash = passwordHash;
    user.updatedAt = when;
    this.users.set(userId, user);
  }

  async updateLastLogin(userId: string, when: Date): Promise<void> {
    const user = this.getUserOrThrow(userId);
    user.lastLoginAt = when;
    this.users.set(userId, user);
  }

  async createAuditEvent(event: AuditEventInput): Promise<void> {
    this.auditEvents.push({ ...event });
  }

  async getMfaConfiguration(userId: string): Promise<MfaConfiguration | null> {
    const setting = this.mfaSettingsByUser.get(userId);
    return setting ? this.sanitizeMfa(setting) : null;
  }

  async upsertMfaSetting(input: UpsertMfaSettingInput): Promise<MfaConfiguration> {
    const existing = this.mfaSettingsByUser.get(input.userId);
    const now = new Date();

    if (existing) {
      const updated: StoredMfaSetting = {
        ...existing,
        method: input.method,
        secretEncrypted: input.secretEncrypted,
        deviceName: input.deviceName ?? null,
        activatedAt: input.activatedAt ?? existing.activatedAt,
        updatedAt: now,
      };

      this.mfaSettingsById.set(updated.id, updated);
      this.mfaSettingsByUser.set(input.userId, updated);
      this.updateUserMfa(input.userId, updated);
      return this.sanitizeMfa(updated);
    }

    const created: StoredMfaSetting = {
      id: randomUUID(),
      userId: input.userId,
      method: input.method,
      secretEncrypted: input.secretEncrypted,
      deviceName: input.deviceName ?? null,
      activatedAt: input.activatedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.mfaSettingsById.set(created.id, created);
    this.mfaSettingsByUser.set(input.userId, created);
    this.updateUserMfa(input.userId, created);

    return this.sanitizeMfa(created);
  }

  async activateMfaSetting(userMfaId: string, activatedAt: Date): Promise<MfaConfiguration> {
    const setting = this.mfaSettingsById.get(userMfaId);
    if (!setting) {
      throw new Error('MFA setting not found');
    }

    const updated = { ...setting, activatedAt, updatedAt: new Date() };
    this.mfaSettingsById.set(userMfaId, updated);
    this.mfaSettingsByUser.set(updated.userId, updated);
    this.updateUserMfa(updated.userId, updated);

    return this.sanitizeMfa(updated);
  }

  async deleteMfaSetting(userMfaId: string): Promise<void> {
    const setting = this.mfaSettingsById.get(userMfaId);
    if (!setting) {
      return;
    }

    this.mfaSettingsById.delete(userMfaId);
    this.mfaSettingsByUser.delete(setting.userId);
    this.updateUserMfa(setting.userId, null);

    const codeIds = this.backupCodesByMfa.get(userMfaId);
    if (codeIds) {
      for (const codeId of codeIds) {
        this.backupCodesById.delete(codeId);
      }
      this.backupCodesByMfa.delete(userMfaId);
    }

    const rememberedIds = this.rememberedDevicesByMfa.get(userMfaId);
    if (rememberedIds) {
      for (const id of rememberedIds) {
        this.rememberedDevicesById.delete(id);
      }
      this.rememberedDevicesByMfa.delete(userMfaId);
    }

    for (const [id, challenge] of this.mfaChallenges.entries()) {
      if (challenge.userMfaId === userMfaId) {
        this.mfaChallenges.delete(id);
      }
    }
  }

  async listMfaBackupCodes(userMfaId: string): Promise<MfaBackupCodeRecord[]> {
    const ids = this.backupCodesByMfa.get(userMfaId);
    if (!ids) {
      return [];
    }

    return [...ids].map((id) => ({ ...this.backupCodesById.get(id)! }));
  }

  async replaceMfaBackupCodes(input: ReplaceBackupCodesInput): Promise<void> {
    const now = new Date();
    const existingIds = this.backupCodesByMfa.get(input.userMfaId);
    if (existingIds) {
      for (const id of existingIds) {
        this.backupCodesById.delete(id);
      }
    }

    const newIds = new Set<string>();
    for (const code of input.codes) {
      const record: StoredBackupCode = {
        id: code.id,
        userMfaId: input.userMfaId,
        codeHash: code.codeHash,
        usedAt: null,
        createdAt: now,
      };

      this.backupCodesById.set(record.id, record);
      newIds.add(record.id);
    }

    this.backupCodesByMfa.set(input.userMfaId, newIds);
  }

  async markBackupCodeUsed(id: string, when: Date): Promise<void> {
    const record = this.backupCodesById.get(id);
    if (!record) {
      return;
    }

    record.usedAt = when;
    this.backupCodesById.set(id, record);
  }

  async createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallengeRecord> {
    const record: StoredMfaChallenge = {
      id: randomUUID(),
      userId: input.userId,
      userMfaId: input.userMfaId ?? null,
      method: input.method,
      type: input.type,
      secretEncrypted: input.secretEncrypted ?? null,
      deviceName: input.deviceName ?? null,
      context: input.context ?? null,
      expiresAt: input.expiresAt,
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    };

    this.mfaChallenges.set(record.id, record);

    return { ...record };
  }

  async findMfaChallengeById(id: string): Promise<MfaChallengeRecord | null> {
    const record = this.mfaChallenges.get(id);
    return record ? { ...record } : null;
  }

  async incrementMfaChallengeAttempts(id: string, attempts: number): Promise<void> {
    const record = this.mfaChallenges.get(id);
    if (!record) {
      return;
    }

    record.attempts = attempts;
    this.mfaChallenges.set(id, record);
  }

  async consumeMfaChallenge(id: string, when: Date): Promise<MfaChallengeRecord | null> {
    const record = this.mfaChallenges.get(id);
    if (!record) {
      return null;
    }

    record.consumedAt = when;
    this.mfaChallenges.set(id, record);

    return { ...record };
  }

  async deleteMfaChallenge(id: string): Promise<void> {
    this.mfaChallenges.delete(id);
  }

  async listRememberedDevices(userMfaId: string): Promise<MfaRememberedDeviceRecord[]> {
    const ids = this.rememberedDevicesByMfa.get(userMfaId);
    if (!ids) {
      return [];
    }

    return [...ids].map((id) => ({ ...this.rememberedDevicesById.get(id)! }));
  }

  async createRememberedDevice(
    input: CreateRememberedDeviceInput,
  ): Promise<MfaRememberedDeviceRecord> {
    const record: StoredRememberedDevice = {
      id: randomUUID(),
      userMfaId: input.userMfaId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      lastUsedAt: null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    };

    this.rememberedDevicesById.set(record.id, record);

    let ids = this.rememberedDevicesByMfa.get(input.userMfaId);
    if (!ids) {
      ids = new Set<string>();
      this.rememberedDevicesByMfa.set(input.userMfaId, ids);
    }

    ids.add(record.id);

    return { ...record };
  }

  async updateRememberedDevice(input: UpdateRememberedDeviceInput): Promise<void> {
    const record = this.rememberedDevicesById.get(input.id);
    if (!record) {
      return;
    }

    record.lastUsedAt = input.lastUsedAt;
    record.ipAddress = input.ipAddress ?? null;
    record.userAgent = input.userAgent ?? null;
    this.rememberedDevicesById.set(input.id, record);
  }

  async deleteRememberedDevice(id: string): Promise<void> {
    const record = this.rememberedDevicesById.get(id);
    if (!record) {
      return;
    }

    this.rememberedDevicesById.delete(id);
    const ids = this.rememberedDevicesByMfa.get(record.userMfaId);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) {
        this.rememberedDevicesByMfa.delete(record.userMfaId);
      }
    }
  }

  async deleteExpiredRememberedDevices(userMfaId: string, now: Date): Promise<void> {
    const ids = this.rememberedDevicesByMfa.get(userMfaId);
    if (!ids) {
      return;
    }

    for (const id of [...ids]) {
      const record = this.rememberedDevicesById.get(id);
      if (!record) {
        ids.delete(id);
        continue;
      }

      if (record.expiresAt.getTime() < now.getTime()) {
        ids.delete(id);
        this.rememberedDevicesById.delete(id);
      }
    }

    if (ids.size === 0) {
      this.rememberedDevicesByMfa.delete(userMfaId);
    }
  }

  private sanitizeMfa(setting: StoredMfaSetting): MfaConfiguration {
    const { userId: _ignored, ...rest } = setting;
    return { ...rest };
  }

  getAuditEvents() {
    return [...this.auditEvents];
  }

  private getUserOrThrow(userId: string): StoredUser {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }

  private updateUserMfa(userId: string, setting: StoredMfaSetting | null): void {
    const user = this.users.get(userId);
    if (!user) {
      return;
    }

    user.mfa = setting ? this.sanitizeMfa(setting) : null;
    user.updatedAt = new Date();
    this.users.set(userId, user);
  }

  private cloneUser(user: StoredUser): AuthUser {
    const { passwordHash, ...rest } = user;
    return {
      ...rest,
      mfa: user.mfa ? { ...user.mfa } : null,
    };
  }
}

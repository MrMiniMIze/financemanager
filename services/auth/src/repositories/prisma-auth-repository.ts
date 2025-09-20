import type {
  PrismaClient,
  EmailVerificationToken as PrismaEmailVerificationToken,
  PasswordResetToken as PrismaPasswordResetToken,
  RefreshToken as PrismaRefreshToken,
  User as PrismaUser,
  UserMfaSetting as PrismaUserMfaSetting,
  MfaChallenge as PrismaMfaChallenge,
  MfaBackupCode as PrismaMfaBackupCode,
  MfaRememberedDevice as PrismaMfaRememberedDevice,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

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
} from './auth-repository';
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
} from '../domain/models';

function mapMfa(setting: PrismaUserMfaSetting | null | undefined): MfaConfiguration | null {
  if (!setting) {
    return null;
  }

  return {
    id: setting.id,
    method: setting.method,
    secretEncrypted: setting.secretEncrypted,
    deviceName: setting.deviceName,
    activatedAt: setting.activatedAt,
    createdAt: setting.createdAt,
    updatedAt: setting.updatedAt,
  };
}

function mapUser(user: PrismaUser & { mfaSetting?: PrismaUserMfaSetting | null }): AuthUser {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    planTier: user.planTier,
    roles: user.roles ?? [],
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    timezone: user.timezone,
    firstName: user.firstName,
    lastName: user.lastName,
    mfa: mapMfa(user.mfaSetting),
  };
}

function mapRefreshToken(record: PrismaRefreshToken): RefreshTokenRecord {
  return {
    id: record.id,
    userId: record.userId,
    tokenHash: record.tokenHash,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    replacedByTokenId: record.replacedByTokenId ?? null,
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
  };
}

function mapEmailToken(record: PrismaEmailVerificationToken): EmailVerificationTokenRecord {
  return {
    id: record.id,
    userId: record.userId,
    token: record.token,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt,
    createdAt: record.createdAt,
  };
}

function mapPasswordResetToken(record: PrismaPasswordResetToken): PasswordResetTokenRecord {
  return {
    id: record.id,
    userId: record.userId,
    token: record.token,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt,
    createdAt: record.createdAt,
  };
}

function mapMfaChallenge(record: PrismaMfaChallenge): MfaChallengeRecord {
  const contextValue = record.context;
  let context: Record<string, unknown> | null = null;

  if (contextValue && contextValue !== Prisma.DbNull) {
    context = contextValue as unknown as Record<string, unknown>;
  }

  return {
    id: record.id,
    userId: record.userId,
    userMfaId: record.userMfaId,
    method: record.method,
    type: record.type,
    secretEncrypted: record.secretEncrypted,
    deviceName: record.deviceName,
    context,
    expiresAt: record.expiresAt,
    consumedAt: record.consumedAt,
    attempts: record.attempts,
    createdAt: record.createdAt,
  };
}

function mapMfaBackupCode(record: PrismaMfaBackupCode): MfaBackupCodeRecord {
  return {
    id: record.id,
    userMfaId: record.userMfaId,
    codeHash: record.codeHash,
    usedAt: record.usedAt,
    createdAt: record.createdAt,
  };
}

function mapRememberedDevice(record: PrismaMfaRememberedDevice): MfaRememberedDeviceRecord {
  return {
    id: record.id,
    userMfaId: record.userMfaId,
    tokenHash: record.tokenHash,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
  };
}

function serializeJson(value: Record<string, unknown> | null | undefined) {
  if (value === undefined || value === null) {
    return Prisma.DbNull;
  }

  return value as Prisma.JsonObject;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          planTier: input.planTier,
          firstName: input.firstName,
          lastName: input.lastName,
          timezone: input.timezone,
          roles: input.roles ?? undefined,
        },
        include: { mfaSetting: true },
      });

      await tx.passwordCredential.create({
        data: {
          userId: created.id,
          passwordHash: input.passwordHash,
        },
      });

      return created;
    });

    return mapUser(user);
  }

  async findUserByEmail(email: string): Promise<AuthUserWithSecrets | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { passwordCredential: true, mfaSetting: true },
    });

    if (!user?.passwordCredential) {
      return null;
    }

    return {
      ...mapUser(user),
      passwordHash: user.passwordCredential.passwordHash,
    };
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { mfaSetting: true },
    });
    return user ? mapUser(user) : null;
  }

  async markEmailVerified(userId: string, verifiedAt: Date): Promise<AuthUser> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: verifiedAt },
      include: { mfaSetting: true },
    });

    return mapUser(user);
  }

  async saveEmailVerificationToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<EmailVerificationTokenRecord> {
    const record = await this.prisma.emailVerificationToken.create({
      data: {
        userId,
        token,
        expiresAt,
      },
    });

    return mapEmailToken(record);
  }

  async consumeEmailVerificationToken(token: string): Promise<EmailVerificationTokenRecord | null> {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { token },
    });

    if (!record || record.consumedAt) {
      return null;
    }

    if (record.expiresAt.getTime() < Date.now()) {
      return null;
    }

    const updated = await this.prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });

    return mapEmailToken(updated);
  }

  async saveRefreshToken(input: SaveRefreshTokenInput): Promise<RefreshTokenRecord> {
    const record = await this.prisma.refreshToken.create({
      data: {
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });

    return mapRefreshToken(record);
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenWithUser | null> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { id },
      include: { user: { include: { mfaSetting: true } } },
    });

    if (!record) {
      return null;
    }

    return {
      ...mapRefreshToken(record),
      user: mapUser(record.user),
    };
  }

  async revokeRefreshToken(
    id: string,
    revokedAt: Date,
    replacedByTokenId?: string | null,
  ): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { id },
      data: {
        revokedAt,
        replacedByTokenId: replacedByTokenId ?? null,
      },
    });
  }

  async revokeRefreshTokensForUser(userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async createPasswordResetToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<PasswordResetTokenRecord> {
    const record = await this.prisma.passwordResetToken.create({
      data: {
        userId,
        token,
        expiresAt,
      },
    });

    return mapPasswordResetToken(record);
  }

  async consumePasswordResetToken(
    token: string,
    consumedAt: Date,
  ): Promise<PasswordResetTokenRecord | null> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { token },
    });

    if (!record || record.consumedAt) {
      return null;
    }

    if (record.expiresAt.getTime() < consumedAt.getTime()) {
      return null;
    }

    const updated = await this.prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { consumedAt },
    });

    return mapPasswordResetToken(updated);
  }

  async updatePasswordHash(userId: string, passwordHash: string, when: Date): Promise<void> {
    await this.prisma.passwordCredential.update({
      where: { userId },
      data: {
        passwordHash,
        updatedAt: when,
      },
    });
  }

  async updateLastLogin(userId: string, when: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: when },
    });
  }

  async createAuditEvent(event: AuditEventInput): Promise<void> {
    const metadataValue = serializeJson(event.metadata);

    await this.prisma.auditEvent.create({
      data: {
        userId: event.userId ?? null,
        actor: event.actor,
        action: event.action,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: metadataValue,
      },
    });
  }

  async getMfaConfiguration(userId: string): Promise<MfaConfiguration | null> {
    const record = await this.prisma.userMfaSetting.findUnique({
      where: { userId },
    });

    return record ? mapMfa(record) : null;
  }

  async upsertMfaSetting(input: UpsertMfaSettingInput): Promise<MfaConfiguration> {
    const record = await this.prisma.userMfaSetting.upsert({
      where: { userId: input.userId },
      update: {
        method: input.method,
        secretEncrypted: input.secretEncrypted,
        deviceName: input.deviceName ?? null,
        activatedAt: input.activatedAt ?? null,
      },
      create: {
        userId: input.userId,
        method: input.method,
        secretEncrypted: input.secretEncrypted,
        deviceName: input.deviceName ?? null,
        activatedAt: input.activatedAt ?? null,
      },
    });

    return mapMfa(record)!;
  }

  async activateMfaSetting(userMfaId: string, activatedAt: Date): Promise<MfaConfiguration> {
    const record = await this.prisma.userMfaSetting.update({
      where: { id: userMfaId },
      data: {
        activatedAt,
      },
    });

    return mapMfa(record)!;
  }

  async deleteMfaSetting(userMfaId: string): Promise<void> {
    await this.prisma.userMfaSetting.delete({ where: { id: userMfaId } });
  }

  async listMfaBackupCodes(userMfaId: string): Promise<MfaBackupCodeRecord[]> {
    const records = await this.prisma.mfaBackupCode.findMany({
      where: { userMfaId },
    });

    return records.map(mapMfaBackupCode);
  }

  async replaceMfaBackupCodes(input: ReplaceBackupCodesInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.mfaBackupCode.deleteMany({ where: { userMfaId: input.userMfaId } });

      if (input.codes.length === 0) {
        return;
      }

      await tx.mfaBackupCode.createMany({
        data: input.codes.map((code) => ({
          id: code.id,
          userMfaId: input.userMfaId,
          codeHash: code.codeHash,
        })),
      });
    });
  }

  async markBackupCodeUsed(id: string, when: Date): Promise<void> {
    await this.prisma.mfaBackupCode.update({
      where: { id },
      data: { usedAt: when },
    });
  }

  async createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallengeRecord> {
    const record = await this.prisma.mfaChallenge.create({
      data: {
        userId: input.userId,
        userMfaId: input.userMfaId ?? null,
        method: input.method,
        type: input.type,
        secretEncrypted: input.secretEncrypted ?? null,
        deviceName: input.deviceName ?? null,
        context: serializeJson(input.context ?? null),
        expiresAt: input.expiresAt,
      },
    });

    return mapMfaChallenge(record);
  }

  async findMfaChallengeById(id: string): Promise<MfaChallengeRecord | null> {
    const record = await this.prisma.mfaChallenge.findUnique({ where: { id } });
    return record ? mapMfaChallenge(record) : null;
  }

  async incrementMfaChallengeAttempts(id: string, attempts: number): Promise<void> {
    await this.prisma.mfaChallenge.update({
      where: { id },
      data: { attempts },
    });
  }

  async consumeMfaChallenge(id: string, when: Date): Promise<MfaChallengeRecord | null> {
    try {
      const record = await this.prisma.mfaChallenge.update({
        where: { id },
        data: {
          consumedAt: when,
        },
      });

      return mapMfaChallenge(record);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }

      throw error;
    }
  }

  async deleteMfaChallenge(id: string): Promise<void> {
    await this.prisma.mfaChallenge.delete({ where: { id } });
  }

  async listRememberedDevices(userMfaId: string): Promise<MfaRememberedDeviceRecord[]> {
    const records = await this.prisma.mfaRememberedDevice.findMany({
      where: { userMfaId },
    });

    return records.map(mapRememberedDevice);
  }

  async createRememberedDevice(
    input: CreateRememberedDeviceInput,
  ): Promise<MfaRememberedDeviceRecord> {
    const record = await this.prisma.mfaRememberedDevice.create({
      data: {
        userMfaId: input.userMfaId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });

    return mapRememberedDevice(record);
  }

  async updateRememberedDevice(input: UpdateRememberedDeviceInput): Promise<void> {
    await this.prisma.mfaRememberedDevice.update({
      where: { id: input.id },
      data: {
        lastUsedAt: input.lastUsedAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async deleteRememberedDevice(id: string): Promise<void> {
    await this.prisma.mfaRememberedDevice.delete({ where: { id } });
  }

  async deleteExpiredRememberedDevices(userMfaId: string, now: Date): Promise<void> {
    await this.prisma.mfaRememberedDevice.deleteMany({
      where: {
        userMfaId,
        expiresAt: { lt: now },
      },
    });
  }
}

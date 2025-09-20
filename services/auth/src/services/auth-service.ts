import argon2 from 'argon2';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import type { AuthRepository } from '../repositories/auth-repository';
import type { Env } from '../env';
import type { EmailService } from './email-service';
import type {
  AuthUser,
  AuthUserWithSecrets,
  MfaBackupCodeRecord,
  MfaChallengeRecord,
  MfaConfiguration,
} from '../domain/models';
import { badRequest, conflict, forbidden, gone, tooManyRequests, unauthorized } from '../errors';
import { encryptSecret, decryptSecret } from '../lib/encryption';
import {
  buildOtpauthUrl,
  createTotpSecret,
  generateBackupCodes,
  isValidTotpToken,
} from '../lib/totp';

const ACCESS_TOKEN_AUDIENCE = 'finance-manager-dashboard';
const ACCESS_TOKEN_ISSUER = 'finance-manager-auth';
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export interface SignupInput {
  email: string;
  password: string;
  firstName?: string | null;
  lastName?: string | null;
  planTier?: 'free' | 'pro' | 'family';
  timezone?: string | null;
  acceptTerms?: boolean;
  marketingOptIn?: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
  rememberMe?: boolean;
  challengeId?: string;
  mfaCode?: string;
  rememberDevice?: boolean;
  rememberedDeviceToken?: string | null;
}

export interface PasswordResetRequestInput {
  email: string;
}

export interface PasswordResetConfirmInput {
  token: string;
  newPassword: string;
}

export interface VerifyEmailInput {
  token: string;
}

export interface VerifyMfaChallengeInput {
  challengeId: string;
  code: string;
  rememberDevice?: boolean;
}

export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface SignupResult {
  user: AuthUser;
  tokens: AuthTokens;
  requiresEmailVerification: boolean;
  debug?: {
    emailVerificationToken: string;
  };
}

export interface LoginSuccessResult {
  type: 'authenticated';
  user: AuthUser;
  tokens: AuthTokens;
  emailVerified: boolean;
  rememberDevice?: {
    value: string;
    expiresAt: Date;
  };
}

export interface LoginChallengeResult {
  type: 'mfa_challenge';
  challengeId: string;
  methods: ('totp' | 'backup_code')[];
  expiresAt: Date;
}

export type LoginResult = LoginSuccessResult | LoginChallengeResult;

export interface RefreshResult {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface PasswordResetRequestResult {
  requested: boolean;
}

export interface PasswordResetResult {
  user: AuthUser;
}

export interface VerifyEmailResult {
  user: AuthUser;
}

export interface StartMfaEnrollmentResult {
  challengeId: string;
  secret: string;
  otpauthUrl: string;
  qrCodeSvg: string;
  expiresAt: Date;
}

export interface VerifyMfaSetupResult {
  type: 'setup';
  backupCodes: string[];
  activatedAt: Date;
}

export interface VerifyMfaLoginResult {
  type: 'login';
  user: AuthUser;
  tokens: AuthTokens;
  rememberDevice?: {
    value: string;
    expiresAt: Date;
  };
}

export type VerifyMfaChallengeResult = VerifyMfaSetupResult | VerifyMfaLoginResult;

export interface AuthServiceDependencies {
  repository: AuthRepository;
  env: Env;
  emailService: EmailService;
}

interface LoginChallengeContext {
  rememberMe: boolean;
}

export class AuthService {
  private readonly repository: AuthRepository;

  private readonly env: Env;

  private readonly emailService: EmailService;

  constructor(dependencies: AuthServiceDependencies) {
    this.repository = dependencies.repository;
    this.env = dependencies.env;
    this.emailService = dependencies.emailService;
  }

  async signup(input: SignupInput, context: RequestContext): Promise<SignupResult> {
    const email = this.normalizeEmail(input.email);

    if (!input.acceptTerms) {
      throw badRequest('AUTH_TERMS_NOT_ACCEPTED', 'You must accept the terms of service.');
    }

    const existing = await this.repository.findUserByEmail(email);

    if (existing) {
      throw conflict('AUTH_EMAIL_EXISTS', 'An account already exists for this email.');
    }

    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    const planTier = input.planTier ?? 'free';

    const user = await this.repository.createUser({
      email,
      passwordHash,
      planTier,
      firstName: this.normalizeOptionalString(input.firstName),
      lastName: this.normalizeOptionalString(input.lastName),
      timezone: this.normalizeOptionalString(input.timezone),
    });

    const verificationToken = this.generateEmailVerificationToken();
    await this.repository.saveEmailVerificationToken(
      user.id,
      verificationToken.token,
      verificationToken.expiresAt,
    );

    await this.repository.createAuditEvent({
      action: 'auth.signup',
      actor: user.id,
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        marketingOptIn: Boolean(input.marketingOptIn),
        planTier,
      },
    });

    const tokens = await this.issueSession(user, context, undefined);

    await this.emailService.sendVerificationEmail({
      user,
      verificationToken: verificationToken.token,
      expiresAt: verificationToken.expiresAt,
    });

    return {
      user,
      tokens,
      requiresEmailVerification: true,
      debug: this.env.isProduction
        ? undefined
        : {
            emailVerificationToken: verificationToken.token,
          },
    };
  }

  async login(input: LoginInput, context: RequestContext): Promise<LoginResult> {
    if (input.challengeId && input.mfaCode) {
      const challengeResult = await this.completeLoginChallenge(
        input.challengeId,
        input.mfaCode,
        Boolean(input.rememberDevice),
        context,
      );

      return {
        type: 'authenticated',
        user: challengeResult.user,
        tokens: challengeResult.tokens,
        emailVerified: Boolean(challengeResult.user.emailVerifiedAt),
        rememberDevice: challengeResult.rememberDevice,
      };
    }

    const email = this.normalizeEmail(input.email);
    const record = await this.repository.findUserByEmail(email);

    if (!record) {
      throw unauthorized('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    const passwordValid = await argon2.verify(record.passwordHash, input.password);

    if (!passwordValid) {
      throw unauthorized('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    if (record.status === 'suspended') {
      throw forbidden('AUTH_ACCOUNT_SUSPENDED', 'Your account is currently suspended.');
    }

    const user = this.stripPassword(record);
    const mfaConfig = await this.getActiveMfaConfiguration(user.id);

    if (!mfaConfig) {
      const tokens = await this.issueSession(user, context, undefined, input.rememberMe);

      await this.repository.updateLastLogin(user.id, new Date());
      await this.repository.createAuditEvent({
        action: 'auth.login',
        actor: user.id,
        userId: user.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          rememberMe: Boolean(input.rememberMe),
        },
      });

      return {
        type: 'authenticated',
        user,
        tokens,
        emailVerified: Boolean(user.emailVerifiedAt),
      };
    }

    const remembered = await this.validateRememberedDevice(
      mfaConfig,
      input.rememberedDeviceToken ?? null,
      context,
    );

    if (remembered) {
      const tokens = await this.issueSession(user, context, undefined, input.rememberMe);

      await this.repository.updateLastLogin(user.id, new Date());
      await this.repository.createAuditEvent({
        action: 'auth.login',
        actor: user.id,
        userId: user.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          rememberMe: Boolean(input.rememberMe),
          rememberedDeviceId: remembered,
        },
      });

      return {
        type: 'authenticated',
        user,
        tokens,
        emailVerified: Boolean(user.emailVerifiedAt),
      };
    }

    const challengeExpiresAt = new Date(Date.now() + this.env.MFA_CHALLENGE_TTL_SECONDS * 1000);
    const challenge = await this.repository.createMfaChallenge({
      userId: user.id,
      userMfaId: mfaConfig.id,
      method: 'totp',
      type: 'login',
      expiresAt: challengeExpiresAt,
      context: {
        rememberMe: Boolean(input.rememberMe),
      } satisfies LoginChallengeContext,
    });

    await this.repository.createAuditEvent({
      action: 'auth.login.challenge',
      actor: user.id,
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        challengeId: challenge.id,
      },
    });

    return {
      type: 'mfa_challenge',
      challengeId: challenge.id,
      methods: ['totp', 'backup_code'],
      expiresAt: challenge.expiresAt,
    };
  }

  async refreshSession(refreshToken: string, context: RequestContext): Promise<RefreshResult> {
    const parsed = this.parseCompositeToken(refreshToken, 'AUTH_INVALID_REFRESH_TOKEN');
    const record = await this.repository.findRefreshTokenById(parsed.id);

    if (!record) {
      throw unauthorized('AUTH_INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');
    }

    const now = new Date();

    if (record.revokedAt) {
      throw unauthorized('AUTH_REFRESH_TOKEN_REVOKED', 'Refresh token is no longer valid.');
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      await this.repository.revokeRefreshToken(record.id, now);
      throw unauthorized('AUTH_REFRESH_TOKEN_EXPIRED', 'Refresh token expired.');
    }

    const secretValid = await argon2.verify(record.tokenHash, parsed.secret);

    if (!secretValid) {
      await this.repository.revokeRefreshToken(record.id, now);
      throw unauthorized('AUTH_INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired.');
    }

    if (record.user.status === 'suspended') {
      await this.repository.revokeRefreshToken(record.id, now);
      throw forbidden('AUTH_ACCOUNT_SUSPENDED', 'Your account is currently suspended.');
    }

    const tokens = await this.issueSession(record.user, context, record.id);

    await this.repository.createAuditEvent({
      action: 'auth.refresh',
      actor: record.user.id,
      userId: record.user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { refreshTokenId: parsed.id },
    });

    return {
      user: record.user,
      tokens,
    };
  }

  async requestPasswordReset(
    input: PasswordResetRequestInput,
    context: RequestContext,
  ): Promise<PasswordResetRequestResult> {
    const email = this.normalizeEmail(input.email);
    const record = await this.repository.findUserByEmail(email);

    if (!record) {
      return { requested: false };
    }

    const token = this.generatePasswordResetToken();

    await this.repository.createPasswordResetToken(record.id, token.token, token.expiresAt);

    await this.emailService.sendPasswordResetEmail({
      user: this.stripPassword(record),
      resetToken: token.token,
      expiresAt: token.expiresAt,
    });

    await this.repository.createAuditEvent({
      action: 'auth.password.reset-request',
      actor: record.id,
      userId: record.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return { requested: true };
  }

  async resetPassword(
    input: PasswordResetConfirmInput,
    context: RequestContext,
  ): Promise<PasswordResetResult> {
    const record = await this.repository.consumePasswordResetToken(input.token, new Date());

    if (!record) {
      throw badRequest(
        'AUTH_RESET_TOKEN_INVALID',
        'Password reset token is invalid or has expired.',
      );
    }

    const user = await this.repository.findUserById(record.userId);

    if (!user) {
      throw badRequest(
        'AUTH_RESET_TOKEN_INVALID',
        'Password reset token is invalid or has expired.',
      );
    }

    const newHash = await argon2.hash(input.newPassword, ARGON2_OPTIONS);

    await this.repository.updatePasswordHash(user.id, newHash, new Date());
    await this.repository.revokeRefreshTokensForUser(user.id, new Date());

    await this.repository.createAuditEvent({
      action: 'auth.password.reset',
      actor: user.id,
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return { user };
  }

  async verifyEmail(input: VerifyEmailInput, context: RequestContext): Promise<VerifyEmailResult> {
    const record = await this.repository.consumeEmailVerificationToken(input.token);

    if (!record) {
      throw badRequest(
        'AUTH_EMAIL_VERIFICATION_INVALID',
        'Verification token is invalid or expired.',
      );
    }

    const user = await this.repository.markEmailVerified(record.userId, new Date());

    await this.repository.createAuditEvent({
      action: 'auth.email.verified',
      actor: user.id,
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return { user };
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    return this.repository.findUserById(id);
  }

  async startMfaEnrollment(
    user: AuthUser,
    deviceName: string | null,
    context: RequestContext,
  ): Promise<StartMfaEnrollmentResult> {
    const existing = await this.getActiveMfaConfiguration(user.id);
    if (existing) {
      throw conflict('AUTH_MFA_ALREADY_ENABLED', 'Multi-factor authentication is already enabled.');
    }

    const secret = createTotpSecret();
    const encryptedSecret = encryptSecret(secret.secret, this.env.MFA_ENCRYPTION_KEY);
    const expiresAt = new Date(Date.now() + this.env.MFA_CHALLENGE_TTL_SECONDS * 1000);

    const challenge = await this.repository.createMfaChallenge({
      userId: user.id,
      method: 'totp',
      type: 'setup',
      secretEncrypted: encryptedSecret,
      deviceName: this.normalizeOptionalString(deviceName),
      expiresAt,
    });

    const otpauthUrl = buildOtpauthUrl(secret.secret, user.email, this.env.MFA_TOTP_ISSUER);

    await this.repository.createAuditEvent({
      action: 'auth.mfa.setup.started',
      actor: user.id,
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        challengeId: challenge.id,
      },
    });

    return {
      challengeId: challenge.id,
      secret: secret.secret,
      otpauthUrl,
      qrCodeSvg: this.generateQrCodeSvg(otpauthUrl),
      expiresAt: challenge.expiresAt,
    };
  }

  async verifyMfaChallenge(
    input: VerifyMfaChallengeInput,
    context: RequestContext,
  ): Promise<VerifyMfaChallengeResult> {
    const challenge = await this.repository.findMfaChallengeById(input.challengeId);

    if (!challenge) {
      throw badRequest(
        'AUTH_MFA_CHALLENGE_INVALID',
        'The MFA challenge is invalid or has been revoked.',
      );
    }

    const now = new Date();

    if (challenge.expiresAt.getTime() < now.getTime()) {
      await this.repository.deleteMfaChallenge(challenge.id);
      throw gone('AUTH_MFA_CHALLENGE_EXPIRED', 'The MFA challenge has expired.');
    }

    if (challenge.consumedAt) {
      throw badRequest(
        'AUTH_MFA_CHALLENGE_INVALID',
        'The MFA challenge has already been completed.',
      );
    }

    if (challenge.type === 'setup') {
      return this.completeSetupChallenge(challenge, input.code, context);
    }

    if (challenge.type === 'login') {
      return this.completeLoginChallenge(
        input.challengeId,
        input.code,
        Boolean(input.rememberDevice),
        context,
      );
    }

    throw badRequest('AUTH_MFA_CHALLENGE_INVALID', 'Unsupported MFA challenge type.');
  }

  private async completeSetupChallenge(
    challenge: MfaChallengeRecord,
    code: string,
    context: RequestContext,
  ): Promise<VerifyMfaSetupResult> {
    if (!challenge.secretEncrypted) {
      throw badRequest('AUTH_MFA_CHALLENGE_INVALID', 'Challenge is missing secret payload.');
    }

    const secret = decryptSecret(challenge.secretEncrypted, this.env.MFA_ENCRYPTION_KEY);

    if (!isValidTotpToken(secret, code)) {
      await this.registerFailedMfaAttempt(challenge, context);
    }

    const activatedAt = new Date();

    const setting = await this.repository.upsertMfaSetting({
      userId: challenge.userId,
      method: 'totp',
      secretEncrypted: challenge.secretEncrypted,
      deviceName: challenge.deviceName ?? null,
      activatedAt,
    });

    const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT).map((codeValue) =>
      codeValue.toUpperCase(),
    );
    const hashedCodes = await Promise.all(
      backupCodes.map(async (value) => ({
        id: crypto.randomUUID(),
        codeHash: await argon2.hash(value, ARGON2_OPTIONS),
      })),
    );

    await this.repository.replaceMfaBackupCodes({
      userMfaId: setting.id,
      codes: hashedCodes,
    });

    await this.repository.consumeMfaChallenge(challenge.id, activatedAt);

    await this.repository.createAuditEvent({
      action: 'auth.mfa.setup.completed',
      actor: challenge.userId,
      userId: challenge.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    return {
      type: 'setup',
      backupCodes,
      activatedAt,
    };
  }

  private async completeLoginChallenge(
    challengeId: string,
    code: string,
    rememberDevice: boolean,
    context: RequestContext,
  ): Promise<VerifyMfaLoginResult> {
    const challenge = await this.repository.findMfaChallengeById(challengeId);

    if (!challenge) {
      throw badRequest(
        'AUTH_MFA_CHALLENGE_INVALID',
        'The MFA challenge is invalid or has been revoked.',
      );
    }

    const now = new Date();

    if (challenge.expiresAt.getTime() < now.getTime()) {
      await this.repository.deleteMfaChallenge(challenge.id);
      throw gone('AUTH_MFA_CHALLENGE_EXPIRED', 'The MFA challenge has expired.');
    }

    const setting = await this.getActiveMfaConfiguration(challenge.userId);

    if (!setting) {
      await this.repository.deleteMfaChallenge(challenge.id);
      throw badRequest('AUTH_MFA_CHALLENGE_INVALID', 'MFA configuration is no longer active.');
    }

    const secret = decryptSecret(setting.secretEncrypted, this.env.MFA_ENCRYPTION_KEY);

    const isTotp = /^[0-9]{6}$/.test(code);
    let usingBackupCode = false;

    if (isTotp) {
      if (!isValidTotpToken(secret, code)) {
        await this.registerFailedMfaAttempt(challenge, context);
      }
    } else if (BACKUP_CODE_PATTERN.test(code.toUpperCase())) {
      usingBackupCode = await this.consumeBackupCode(
        setting.id,
        challenge.userId,
        code.toUpperCase(),
        context,
      );
      if (!usingBackupCode) {
        await this.registerFailedMfaAttempt(challenge, context);
      }
    } else {
      await this.registerFailedMfaAttempt(challenge, context);
    }

    const consumed = await this.repository.consumeMfaChallenge(challenge.id, now);
    const rememberMe = Boolean(
      (consumed?.context as LoginChallengeContext | undefined)?.rememberMe,
    );

    const user = await this.repository.findUserById(challenge.userId);
    if (!user) {
      throw unauthorized('AUTH_INVALID_CREDENTIALS', 'Unable to locate user for challenge.');
    }

    const tokens = await this.issueSession(user, context, undefined, rememberMe);

    let rememberDeviceResult: { value: string; expiresAt: Date } | undefined;
    if (rememberDevice && !usingBackupCode) {
      rememberDeviceResult = await this.createRememberedDevice(setting.id, context);
    }

    await this.repository.updateLastLogin(user.id, now);
    await this.repository.createAuditEvent({
      action: 'auth.mfa.login.success',
      actor: user.id,
      userId: user.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        rememberMe,
        rememberDevice: Boolean(rememberDeviceResult),
        usedBackupCode: usingBackupCode,
      },
    });

    return {
      type: 'login',
      user,
      tokens,
      rememberDevice: rememberDeviceResult,
    };
  }

  private async consumeBackupCode(
    userMfaId: string,
    userId: string,
    code: string,
    context: RequestContext,
  ): Promise<boolean> {
    const codes = await this.repository.listMfaBackupCodes(userMfaId);

    for (const record of codes) {
      if (record.usedAt) {
        continue;
      }

      const valid = await argon2.verify(record.codeHash, code);
      if (valid) {
        await this.repository.markBackupCodeUsed(record.id, new Date());
        await this.repository.createAuditEvent({
          action: 'auth.mfa.backup-code.used',
          actor: userId,
          userId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: { userMfaId, backupCodeId: record.id },
        });
        return true;
      }
    }

    return false;
  }

  private async registerFailedMfaAttempt(
    challenge: MfaChallengeRecord,
    context: RequestContext,
  ): Promise<never> {
    const nextAttempts = challenge.attempts + 1;
    await this.repository.incrementMfaChallengeAttempts(challenge.id, nextAttempts);

    await this.repository.createAuditEvent({
      action: 'auth.mfa.challenge.failed',
      actor: challenge.userId,
      userId: challenge.userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        challengeId: challenge.id,
        attempts: nextAttempts,
        type: challenge.type,
      },
    });

    if (nextAttempts >= this.env.MFA_MAX_ATTEMPTS) {
      await this.repository.deleteMfaChallenge(challenge.id);
      throw tooManyRequests(
        'AUTH_MFA_CHALLENGE_LOCKED',
        'Too many incorrect verification attempts. Please restart the login process.',
      );
    }

    throw unauthorized('AUTH_MFA_CODE_INCORRECT', 'The verification code is incorrect.');
  }

  private async validateRememberedDevice(
    setting: MfaConfiguration,
    token: string | null,
    context: RequestContext,
  ) {
    if (!token) {
      return null;
    }

    const devices = await this.repository.listRememberedDevices(setting.id);
    const now = new Date();

    let matchedId: string | null = null;

    for (const device of devices) {
      if (device.expiresAt.getTime() < now.getTime()) {
        continue;
      }

      const valid = await argon2.verify(device.tokenHash, token).catch(() => false);
      if (valid) {
        matchedId = device.id;
        await this.repository.updateRememberedDevice({
          id: device.id,
          lastUsedAt: now,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        });
        break;
      }
    }

    await this.repository.deleteExpiredRememberedDevices(setting.id, now);

    return matchedId;
  }

  private async createRememberedDevice(
    userMfaId: string,
    context: RequestContext,
  ): Promise<{ value: string; expiresAt: Date }> {
    const value = crypto.randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(value, ARGON2_OPTIONS);
    const expiresAt = new Date(
      Date.now() + this.env.MFA_REMEMBER_DEVICE_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.repository.createRememberedDevice({
      userMfaId,
      tokenHash,
      expiresAt,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    return { value, expiresAt };
  }

  private async getActiveMfaConfiguration(userId: string) {
    const config = await this.repository.getMfaConfiguration(userId);
    if (!config?.activatedAt) {
      return null;
    }

    return config;
  }

  private normalizeEmail(value: string) {
    return value.trim().toLowerCase();
  }

  private normalizeOptionalString(value?: string | null) {
    if (!value) {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private stripPassword(record: AuthUserWithSecrets): AuthUser {
    const { passwordHash, ...rest } = record;
    return rest;
  }

  private generateEmailVerificationToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.env.EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000,
    );

    return { token, expiresAt };
  }

  private generatePasswordResetToken() {
    const token = crypto.randomBytes(40).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    return { token, expiresAt };
  }

  private parseCompositeToken(
    token: string,
    errorCode: string,
  ): {
    id: string;
    secret: string;
  };
  private parseCompositeToken(
    token: string,
    errorCode: string,
    tolerant: true,
  ): {
    id: string;
    secret: string;
  } | null;
  private parseCompositeToken(
    token: string,
    errorCode: string,
    tolerant?: boolean,
  ): {
    id: string;
    secret: string;
  } | null {
    const segments = token.split('.');

    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      if (tolerant) {
        return null;
      }

      throw unauthorized(errorCode, 'Token format is invalid.');
    }

    return { id: segments[0], secret: segments[1] };
  }

  private async issueSession(
    user: AuthUser,
    context: RequestContext,
    previousTokenId?: string,
    rememberMe?: boolean,
  ): Promise<AuthTokens> {
    const now = new Date();
    const accessTokenExpiresAt = new Date(now.getTime() + this.env.ACCESS_TOKEN_TTL_SECONDS * 1000);

    const defaultTtl = this.env.REFRESH_TOKEN_TTL_SECONDS;
    const refreshTtlSeconds = rememberMe ? defaultTtl : Math.min(defaultTtl, 7 * 24 * 60 * 60);

    const refreshTokenExpiresAt = new Date(now.getTime() + refreshTtlSeconds * 1000);

    const refreshTokenSecret = crypto.randomBytes(48).toString('base64url');
    const refreshTokenId = crypto.randomUUID();
    const refreshTokenValue = `${refreshTokenId}.${refreshTokenSecret}`;
    const refreshTokenHash = await argon2.hash(refreshTokenSecret, ARGON2_OPTIONS);

    await this.repository.saveRefreshToken({
      id: refreshTokenId,
      userId: user.id,
      tokenHash: refreshTokenHash,
      issuedAt: now,
      expiresAt: refreshTokenExpiresAt,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    if (previousTokenId) {
      await this.repository.revokeRefreshToken(previousTokenId, now, refreshTokenId);
    }

    const accessTokenPayload = {
      sub: user.id,
      email: user.email,
      planTier: user.planTier,
      emailVerified: Boolean(user.emailVerifiedAt),
      roles: user.roles,
    };

    const accessToken = jwt.sign(accessTokenPayload, this.env.JWT_ACCESS_SECRET, {
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
    });

    return {
      accessToken,
      accessTokenExpiresAt,
      refreshToken: refreshTokenValue,
      refreshTokenExpiresAt,
    };
  }

  private generateQrCodeSvg(data: string) {
    const escaped = data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="220" height="60" role="img" aria-label="Scan MFA setup URL"><rect width="220" height="60" fill="#f5f5f5" rx="8"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="10">Scan manually: ${escaped}</text></svg>`;
  }
}

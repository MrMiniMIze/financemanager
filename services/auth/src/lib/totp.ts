import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface CreateTotpSecretOptions {
  size?: number;
}

export interface TotpOptions {
  stepSeconds?: number;
  digits?: number;
  window?: number;
  timestamp?: number;
}

export function createTotpSecret(options: CreateTotpSecretOptions = {}) {
  const size = Math.max(10, options.size ?? 20);
  const buffer = crypto.randomBytes(size);
  const secret = base32Encode(buffer);
  return { secret, buffer };
}

export function buildOtpauthUrl(secret: string, email: string, issuer: string) {
  const encodedLabel = encodeURIComponent(`${issuer}:${email}`);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}`;
}

export function isValidTotpToken(secret: string, token: string, options: TotpOptions = {}) {
  const digits = options.digits ?? 6;
  const stepSeconds = options.stepSeconds ?? 30;
  const window = options.window ?? 1;
  const timestamp = options.timestamp ?? Date.now();

  if (!/^[0-9]{6}$/.test(token)) {
    return false;
  }

  const secretBuffer = base32Decode(secret);
  const counter = Math.floor(timestamp / (stepSeconds * 1000));

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = generateOtp(secretBuffer, counter + offset, digits);
    if (expected === token) {
      return true;
    }
  }

  return false;
}

export function generateTotp(secret: string, options: TotpOptions = {}) {
  const digits = options.digits ?? 6;
  const stepSeconds = options.stepSeconds ?? 30;
  const timestamp = options.timestamp ?? Date.now();
  const secretBuffer = base32Decode(secret);
  const counter = Math.floor(timestamp / (stepSeconds * 1000));
  return generateOtp(secretBuffer, counter, digits);
}

export function generateBackupCodes(count = 8) {
  const codes: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }

  return codes;
}

function generateOtp(secret: Buffer, counter: number, digits: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secret).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = (binary % 10 ** digits).toString().padStart(digits, '0');
  return otp;
}

function base32Encode(buffer: Buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      const index = (value >>> (bits - 5)) & 31;
      output += BASE32_ALPHABET[index];
      bits -= 5;
    }
  }

  if (bits > 0) {
    const index = (value << (5 - bits)) & 31;
    output += BASE32_ALPHABET[index];
  }

  return output;
}

function base32Decode(input: string) {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character');
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

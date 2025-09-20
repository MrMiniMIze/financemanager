import { config as loadEnv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
const candidatePath = path.resolve(__dirname, '..', envFile);

if (fs.existsSync(candidatePath)) {
  loadEnv({ path: candidatePath });
} else {
  loadEnv();
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4002),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
    RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(1),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('debug'),
  })
  .transform((value) => ({
    ...value,
    isProduction: value.NODE_ENV === 'production',
  }));

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

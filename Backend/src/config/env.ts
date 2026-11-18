import 'dotenv/config';
import { z } from 'zod';

/**
 * Validacao do ambiente no boot.
 *
 * O processo morre aqui, com mensagem legivel, em vez de estourar um erro
 * obscuro na primeira request. No Render isso aparece no log de deploy.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI e obrigatoria'),

  // 32 chars e o minimo razoavel para HS256. Os dois tem de ser diferentes:
  // se forem iguais, um refresh token passa como access token.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET precisa de ao menos 32 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET precisa de ao menos 32 caracteres'),

  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  /**
   * E-mail que vira admin no boot se o sistema nao tiver nenhum admin ativo.
   *
   * Sem isto, um deploy com banco vazio nasce travado: a conta de enfermagem
   * nasce 'pending', e nao existe ninguem para aprova-la. Promove um usuario
   * que JA se cadastrou - nao cria conta, para nao haver senha no ambiente.
   */
  BOOTSTRAP_ADMIN_EMAIL: z.string().trim().toLowerCase().max(254).optional(),

  CORS_ORIGINS: z.string().default('*'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const detalhes = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join('\n');

  console.error(`\nConfiguracao de ambiente invalida:\n${detalhes}\n\nVeja .env.example.\n`);
  process.exit(1);
}

if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
  console.error('\nJWT_ACCESS_SECRET e JWT_REFRESH_SECRET nao podem ser iguais.\n');
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Origens de CORS como lista, ou '*' para liberar tudo. */
export const corsOrigins: string[] | '*' =
  env.CORS_ORIGINS.trim() === '*'
    ? '*'
    : env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean);

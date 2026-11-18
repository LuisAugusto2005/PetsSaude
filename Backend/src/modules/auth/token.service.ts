import { createHash, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/AppError.js';
import type { UserRole } from '../../shared/types.js';
import { RefreshToken } from './refreshToken.model.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  roles: UserRole[];
  typ: 'access';
}

interface RefreshTokenPayload {
  sub: string;
  typ: 'refresh';
  /**
   * Identificador unico do token.
   *
   * Sem ele, dois refresh tokens emitidos para o mesmo usuario dentro do mesmo
   * segundo tem payload identico (sub, typ, iat, exp) e portanto sao a MESMA
   * string assinada, o que colide no indice unico de tokenHash. Acontece de
   * verdade: cadastrar e dar refresh em seguida, ou o app renovar em duas abas.
   */
  jti: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Segundos de vida do access token, para o cliente agendar o refresh. */
  expiresIn: number;
}

interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

/** Guardamos so o hash: um dump do banco nao entrega sessoes validas. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function signAccessToken(payload: Omit<AccessTokenPayload, 'typ'>): string {
  return jwt.sign(
    { ...payload, typ: 'access' } satisfies AccessTokenPayload,
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: env.ACCESS_TOKEN_TTL,
    } as SignOptions,
  );
}

function signRefreshToken(userId: string): string {
  return jwt.sign(
    { sub: userId, typ: 'refresh', jti: randomUUID() } satisfies RefreshTokenPayload,
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.REFRESH_TOKEN_TTL } as SignOptions,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Token expirado');
    }
    throw AppError.unauthorized('Token invalido');
  }

  const payload = decoded as Partial<AccessTokenPayload>;
  // Sem esta checagem, um refresh token assinado com o mesmo segredo passaria
  // como access token. Os segredos sao diferentes, mas a defesa e barata.
  if (payload.typ !== 'access' || !payload.sub || !Array.isArray(payload.roles)) {
    throw AppError.unauthorized('Token invalido');
  }
  return payload as AccessTokenPayload;
}

/** Emite o par e persiste o hash do refresh para permitir revogacao. */
export async function issueTokenPair(
  user: { id: string; email: string; roles: UserRole[] },
  meta: SessionMeta = {},
): Promise<TokenPair> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, roles: user.roles });
  const refreshToken = signRefreshToken(user.id);

  const decoded = jwt.decode(refreshToken) as { exp?: number } | null;
  if (!decoded?.exp) throw new Error('Refresh token emitido sem exp');

  await RefreshToken.create({
    userId: new Types.ObjectId(user.id),
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(decoded.exp * 1000),
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  const accessDecoded = jwt.decode(accessToken) as { exp?: number; iat?: number } | null;
  const expiresIn =
    accessDecoded?.exp && accessDecoded.iat ? accessDecoded.exp - accessDecoded.iat : 900;

  return { accessToken, refreshToken, expiresIn };
}

/**
 * Valida o refresh token, invalida o antigo e emite um par novo.
 *
 * Se o token apresentado ja foi usado, tratamos como roubo: toda a familia de
 * refresh tokens daquele usuario e revogada e ele precisa logar de novo.
 */
export async function rotateTokenPair(
  rawToken: string,
  meta: SessionMeta = {},
): Promise<{ pair: TokenPair; userId: string }> {
  let payload: RefreshTokenPayload;
  try {
    payload = jwt.verify(rawToken, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Sessao expirada, faca login novamente');
    }
    throw AppError.unauthorized('Refresh token invalido');
  }
  if (payload.typ !== 'refresh' || !payload.sub || !payload.jti) {
    throw AppError.unauthorized('Refresh token invalido');
  }

  const tokenHash = hashToken(rawToken);
  const stored = await RefreshToken.findOne({ tokenHash });

  if (!stored) {
    throw AppError.unauthorized('Refresh token invalido');
  }
  if (stored.revokedAt) {
    throw AppError.unauthorized('Sessao revogada, faca login novamente');
  }
  if (stored.usedAt) {
    // Reuso detectado. Queima tudo.
    await RefreshToken.updateMany(
      { userId: stored.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw AppError.unauthorized('Refresh token reutilizado, todas as sessoes foram encerradas');
  }

  // Import tardio para evitar ciclo entre token.service e user.model.
  const { User } = await import('../users/user.model.js');
  const user = await User.findById(stored.userId);
  // Aqui o 401 generico serve: o portador do refresh token ja provou que tinha
  // sessao, e a mensagem detalhada vem no proximo login.
  if (!user || user.status !== 'active') {
    throw AppError.unauthorized('Usuario inativo ou inexistente');
  }

  const pair = await issueTokenPair(
    { id: user.id as string, email: user.email, roles: user.roles },
    meta,
  );

  stored.usedAt = new Date();
  stored.replacedByHash = hashToken(pair.refreshToken);
  await stored.save();

  return { pair, userId: user.id as string };
}

/** Revoga um refresh token especifico (logout de um dispositivo). */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await RefreshToken.updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Revoga todas as sessoes do usuario (logout em todos os dispositivos). */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await RefreshToken.updateMany(
    { userId: new Types.ObjectId(userId), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

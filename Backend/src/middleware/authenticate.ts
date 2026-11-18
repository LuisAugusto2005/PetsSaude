import type { RequestHandler } from 'express';
import { AppError } from '../shared/AppError.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

/**
 * Le o Bearer token e popula req.user. Nao consulta o banco: o payload do JWT
 * basta para autorizacao de papel, e o custo de um findById por request nao se
 * justifica. A contrapartida e que desativar um usuario so faz efeito quando o
 * access token vence (15 min) ou quando ele tenta o refresh, que sim consulta.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Envie o header Authorization: Bearer <token>'));
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return next(AppError.unauthorized('Token ausente'));
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      roles: payload.roles,
    };
    next();
  } catch (err) {
    next(err);
  }
};

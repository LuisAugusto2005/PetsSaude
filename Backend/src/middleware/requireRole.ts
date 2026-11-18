import type { RequestHandler } from 'express';
import { AppError } from '../shared/AppError.js';
import type { UserRole } from '../shared/types.js';

/**
 * Exige ao menos um dos papeis informados.
 *
 * Papel responde "o QUE voce pode fazer". Nunca "para QUEM": isso e trabalho
 * do authorizePatient, que resolve o CareLink. Uma rota de paciente que use
 * apenas requireRole esta errada por construcao.
 */
export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      return next(AppError.unauthorized('Autentique-se primeiro'));
    }
    const temPapel = req.user.roles.some((r) => allowed.includes(r));
    if (!temPapel) {
      return next(AppError.forbidden(`Esta rota exige um destes papeis: ${allowed.join(', ')}`));
    }
    next();
  };
}

import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../shared/AppError.js';
import { asyncHandler } from '../shared/asyncHandler.js';
import { Device, type DeviceDoc } from '../modules/devices/device.model.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

/**
 * Prefixo do token de aparelho.
 *
 * Existe para que o servidor saiba qual credencial chegou SEM tentar validar
 * as duas: um JWT que falha o verify e indistinguivel de um token de aparelho
 * errado, e o erro sairia confuso ("jwt malformed") para quem esta depurando
 * firmware. O prefixo tambem faz o segredo ser reconhecivel num log ou num
 * repositorio, o que ajuda ferramenta de varredura a achar vazamento.
 */
export const PREFIXO_TOKEN_DE_APARELHO = 'vwd_';

export function hashDoTokenDeAparelho(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Preenchido quando quem chamou foi a propria pulseira, com token de aparelho. */
      device?: DeviceDoc;
    }
  }
}

/**
 * Autentica a ingestao, que tem DOIS tipos de chamador legitimo.
 *
 *   vwd_...   a pulseira falando por wifi. Resolve o Device pelo hash.
 *   JWT       o celular repassando o que recebeu por BLE. Resolve o usuario.
 *
 * E uma rota so porque o corpo e o mesmo: o transporte da pulseira ate aqui
 * ainda nao foi decidido (wifi direto ou BLE para o celular), e o servidor nao
 * deve ter opiniao sobre isso. Duas rotas com o mesmo corpo divergiriam.
 *
 * Aqui so se resolve QUEM chamou. A autorizacao - se este chamador pode
 * escrever na pulseira que o frame diz ser - fica no service, que e quem tem
 * o paciente atual do aparelho para decidir. Mesma divisao que
 * device.routes.ts ja usa para assign/release.
 */
export const authenticateIngest: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(AppError.unauthorized('Envie o header Authorization: Bearer <token>'));
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next(AppError.unauthorized('Token ausente'));
    return;
  }

  if (!token.startsWith(PREFIXO_TOKEN_DE_APARELHO)) {
    // Caminho do celular: mesmo access token das outras rotas.
    try {
      const payload = verifyAccessToken(token);
      req.user = { id: payload.sub, email: payload.email, roles: payload.roles };
      next();
    } catch (err) {
      next(err);
    }
    return;
  }

  // Caminho da pulseira. select explicito porque ingestTokenHash e select:false.
  const device = await Device.findOne({
    ingestTokenHash: hashDoTokenDeAparelho(token),
  }).select('+ingestTokenHash');

  // 401 e nao 404: um aparelho com token revogado nao deve conseguir
  // distinguir "token errado" de "aparelho apagado".
  if (!device) {
    next(AppError.unauthorized('Token de aparelho invalido ou revogado'));
    return;
  }

  // Aparelho fora de operacao nao escreve historico. 403 e proposital: o
  // token e valido, o aparelho e que nao deveria estar em campo - e e isso
  // que precisa aparecer no log para alguem ir buscar a pulseira.
  if (device.status === 'retired') {
    next(AppError.forbidden('Este aparelho esta baixado e nao pode enviar telemetria'));
    return;
  }

  req.device = device;
  next();
});

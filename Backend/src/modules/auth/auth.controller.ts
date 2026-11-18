import type { Request, Response } from 'express';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/AppError.js';
import * as authService from './auth.service.js';
import type { LoginInput, LogoutInput, RefreshInput, RegisterInput } from './auth.schemas.js';
import { revokeAllUserTokens, revokeRefreshToken, rotateTokenPair } from './token.service.js';

function sessionMeta(req: Request) {
  return {
    userAgent: req.headers['user-agent']?.slice(0, 300),
    ip: req.ip,
  };
}

export const registerHandler = asyncHandler(async (req: Request, res: Response) => {
  const { user, tokens } = await authService.register(req.body as RegisterInput, sessionMeta(req));

  // 202 Accepted: a conta foi criada, mas nao ha sessao a devolver enquanto um
  // admin nao aprovar. O app usa o status HTTP para escolher a tela.
  if (!tokens) {
    res.status(202).json({
      usuario: user.toJSON(),
      mensagem:
        'Cadastro recebido. A administracao precisa aprovar a conta antes do primeiro acesso.',
    });
    return;
  }
  res.status(201).json({ usuario: user.toJSON(), ...tokens });
});

export const loginHandler = asyncHandler(async (req: Request, res: Response) => {
  const { user, tokens } = await authService.login(req.body as LoginInput, sessionMeta(req));
  res.status(200).json({ usuario: user.toJSON(), ...tokens });
});

export const refreshHandler = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body as RefreshInput;
  const { pair } = await rotateTokenPair(refreshToken, sessionMeta(req));
  res.status(200).json(pair);
});

export const logoutHandler = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken, allDevices } = req.body as LogoutInput;
  if (!req.user) throw AppError.unauthorized();

  if (allDevices) {
    await revokeAllUserTokens(req.user.id);
  } else if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  } else {
    throw AppError.badRequest('Informe refreshToken ou allDevices: true');
  }
  res.status(204).send();
});

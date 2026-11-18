import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { loginHandler, logoutHandler, refreshHandler, registerHandler } from './auth.controller.js';
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from './auth.schemas.js';

/**
 * Login e cadastro sao as rotas que recebem forca bruta e enumeracao de
 * e-mail, por isso tem limite proprio e bem mais apertado que o global.
 * Desligado em teste para nao derrubar a suite.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: {
    erro: {
      codigo: 'TOO_MANY_REQUESTS',
      mensagem: 'Muitas tentativas. Tente novamente em alguns minutos.',
    },
  },
});

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate({ body: registerSchema }), registerHandler);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), loginHandler);
authRouter.post('/refresh', validate({ body: refreshSchema }), refreshHandler);
authRouter.post('/logout', authenticate, validate({ body: logoutSchema }), logoutHandler);

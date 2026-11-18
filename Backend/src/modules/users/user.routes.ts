import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../shared/validation.js';
import {
  approveUserHandler,
  disableUserHandler,
  getMeHandler,
  listUsersHandler,
  updateMeHandler,
} from './user.controller.js';
import { listUsersSchema, updateMeSchema } from './user.schemas.js';
import { exportSelfHandler } from '../exports/export.controller.js';
import { exportLimiter } from '../../middleware/limiters.js';

export const userRouter = Router();

userRouter.use(authenticate);
userRouter.get('/me', getMeHandler);
userRouter.patch('/me', validate({ body: updateMeSchema }), updateMeHandler);
// Portabilidade do art. 18 da LGPD: os proprios dados, em JSON.
userRouter.get('/me/export', exportLimiter, exportSelfHandler);

// Administracao de contas. Aqui o papel basta: nao ha paciente envolvido, e
// admin e o papel da instituicao.
userRouter.get('/', requireRole('admin'), validate({ query: listUsersSchema }), listUsersHandler);
userRouter.post(
  '/:id/approve',
  requireRole('admin'),
  validate({ params: idParamSchema }),
  approveUserHandler,
);
userRouter.post(
  '/:id/disable',
  requireRole('admin'),
  validate({ params: idParamSchema }),
  disableUserHandler,
);

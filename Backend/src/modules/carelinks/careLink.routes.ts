import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../shared/validation.js';
import { revokeCareLinkHandler, updateCareLinkHandler } from './careLink.controller.js';
import { updateCareLinkSchema } from './careLink.schemas.js';

/**
 * Rotas de um vinculo ja existente. A criacao e a listagem ficam sob
 * /api/patients/:id/carelinks, porque ali o authorizePatient ja resolveu o
 * acesso ao paciente.
 *
 * Aqui a autorizacao e feita no service, que carrega o vinculo para descobrir
 * de qual paciente ele e antes de decidir.
 */
export const careLinkRouter = Router();

careLinkRouter.use(authenticate);

careLinkRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateCareLinkSchema }),
  updateCareLinkHandler,
);
careLinkRouter.delete('/:id', validate({ params: idParamSchema }), revokeCareLinkHandler);

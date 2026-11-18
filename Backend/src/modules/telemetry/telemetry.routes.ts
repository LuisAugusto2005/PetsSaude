import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../shared/validation.js';
import { acknowledgeAlertHandler } from './telemetry.controller.js';

/**
 * Rotas de um alerta pelo proprio id. A listagem fica sob
 * /api/patients/:id/alerts, onde o authorizePatient ja resolveu o acesso.
 *
 * Aqui a autorizacao e no service, que carrega o alerta para descobrir de qual
 * paciente ele e antes de decidir.
 */
export const alertRouter = Router();

alertRouter.use(authenticate);
alertRouter.post('/:id/acknowledge', validate({ params: idParamSchema }), acknowledgeAlertHandler);

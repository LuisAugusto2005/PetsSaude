import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../shared/validation.js';
import {
  assignDeviceHandler,
  createDeviceHandler,
  getDeviceHandler,
  issueIngestTokenHandler,
  listAssignmentsHandler,
  listDevicesHandler,
  releaseDeviceHandler,
  revokeIngestTokenHandler,
  revokeResponsaveisHandler,
  updateDeviceHandler,
} from './device.controller.js';
import {
  assignDeviceSchema,
  createDeviceSchema,
  listDevicesSchema,
  releaseDeviceSchema,
  updateDeviceSchema,
} from './device.schemas.js';

export const deviceRouter = Router();

deviceRouter.use(authenticate);

// Cadastrar e dar baixa em aparelho e ato da instituicao, nao do cuidador.
deviceRouter.post(
  '/',
  requireRole('admin'),
  validate({ body: createDeviceSchema }),
  createDeviceHandler,
);
deviceRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParamSchema, body: updateDeviceSchema }),
  updateDeviceHandler,
);

deviceRouter.get('/', validate({ query: listDevicesSchema }), listDevicesHandler);
deviceRouter.get('/:id', validate({ params: idParamSchema }), getDeviceHandler);
deviceRouter.get('/:id/assignments', validate({ params: idParamSchema }), listAssignmentsHandler);

// Atribuir e liberar exige a permissao manageDevice no vinculo com o
// paciente; a checagem fica no service, que precisa do paciente para decidir.
deviceRouter.post(
  '/:id/assign',
  validate({ params: idParamSchema, body: assignDeviceSchema }),
  assignDeviceHandler,
);
deviceRouter.post(
  '/:id/release',
  validate({ params: idParamSchema, body: releaseDeviceSchema }),
  releaseDeviceHandler,
);

// Higiene de alta, rodada a mao na troca de paciente. requireRole aqui e o
// vinculo com manageDevice no service: os dois, nao um ou outro.
deviceRouter.post(
  '/:id/revoke-responsaveis',
  requireRole('enfermagem', 'admin'),
  validate({ params: idParamSchema }),
  revokeResponsaveisHandler,
);

/**
 * Credencial de ingestao do aparelho. So admin: e o que autoriza uma pulseira
 * a escrever no historico de saude de quem a estiver usando, e o ato de
 * colocar um aparelho em campo e da instituicao.
 */
deviceRouter.post(
  '/:id/ingest-token',
  requireRole('admin'),
  validate({ params: idParamSchema }),
  issueIngestTokenHandler,
);
deviceRouter.delete(
  '/:id/ingest-token',
  requireRole('admin'),
  validate({ params: idParamSchema }),
  revokeIngestTokenHandler,
);

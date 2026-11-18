import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizePatient } from '../../middleware/authorizePatient.js';
import { requireRole } from '../../middleware/requireRole.js';
import { validate } from '../../middleware/validate.js';
import { idParamSchema } from '../../shared/validation.js';
import { createCareLinkHandler, listCareLinksHandler } from '../carelinks/careLink.controller.js';
import { createCareLinkSchema, listCareLinksSchema } from '../carelinks/careLink.schemas.js';
import {
  createPatientHandler,
  getPatientHandler,
  listPatientsHandler,
  updatePatientHandler,
} from './patient.controller.js';
import { createPatientSchema, listPatientsSchema, updatePatientSchema } from './patient.schemas.js';
import { listAlertsHandler, listReadingsHandler } from '../telemetry/telemetry.controller.js';
import { listAlertsSchema, listReadingsSchema } from '../telemetry/telemetry.schemas.js';
import { accessLogHandler, patientHistoryHandler } from '../audit/audit.controller.js';
import { exportPatientHandler } from '../exports/export.controller.js';
import { exportPatientSchema } from '../exports/export.schemas.js';
import { paginationSchema } from '../../shared/validation.js';
import { exportLimiter } from '../../middleware/limiters.js';

export const patientRouter = Router();

patientRouter.use(authenticate);

// Cadastrar paciente e ato da equipe de saude: o responsavel entra depois,
// por convite de quem cadastrou.
patientRouter.post(
  '/',
  requireRole('enfermagem', 'admin'),
  validate({ body: createPatientSchema }),
  createPatientHandler,
);
patientRouter.get('/', validate({ query: listPatientsSchema }), listPatientsHandler);

// Toda rota abaixo passa por authorizePatient: o papel nao basta, o vinculo
// ativo com ESTE paciente e obrigatorio.
patientRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  authorizePatient(),
  getPatientHandler,
);
patientRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updatePatientSchema }),
  authorizePatient(),
  updatePatientHandler,
);

// Sem ownerOnly de proposito: um responsavel vinculado pode convidar outro
// responsavel para o MESMO paciente. Quem pode convidar quem e quais
// permissoes o convite recebe e decidido em careLink.service, que tem o
// vinculo do requisitante em maos.
patientRouter.post(
  '/:id/carelinks',
  validate({ params: idParamSchema, body: createCareLinkSchema }),
  authorizePatient(),
  createCareLinkHandler,
);
patientRouter.get(
  '/:id/carelinks',
  validate({ params: idParamSchema, query: listCareLinksSchema }),
  authorizePatient(),
  listCareLinksHandler,
);

// Telemetria do paciente. require: 'viewHistory' - a permissao existe para
// isto, e nao bastava checar o vinculo: ha cuidador que recebe alerta sem
// poder abrir o historico.
patientRouter.get(
  '/:id/readings',
  validate({ params: idParamSchema, query: listReadingsSchema }),
  authorizePatient({ require: 'viewHistory' }),
  listReadingsHandler,
);
patientRouter.get(
  '/:id/alerts',
  validate({ params: idParamSchema, query: listAlertsSchema }),
  authorizePatient({ require: 'viewHistory' }),
  listAlertsHandler,
);

// Linha do tempo do que foi FEITO com o paciente. Montada dos campos
// createdBy/revokedBy/assignedBy/acknowledgedBy que cada acao ja grava: nao
// existe colecao de eventos paralela para discordar deles.
patientRouter.get(
  '/:id/history',
  validate({ params: idParamSchema, query: paginationSchema }),
  authorizePatient({ require: 'viewHistory' }),
  patientHistoryHandler,
);

// Quem LEU os dados deste paciente. ownerOnly: a trilha de acesso diz onde
// cada cuidador andou, e isso nao e informacao para os outros cuidadores.
patientRouter.get(
  '/:id/access-log',
  validate({ params: idParamSchema, query: paginationSchema }),
  authorizePatient({ ownerOnly: true }),
  accessLogHandler,
);

// Export em stream. Limite proprio: e a rota mais cara do servico, e no plano
// free do Render um punhado de pedidos simultaneos ja ocupa a CPU inteira.
patientRouter.get(
  '/:id/export',
  exportLimiter,
  validate({ params: idParamSchema, query: exportPatientSchema }),
  authorizePatient({ require: 'viewHistory' }),
  exportPatientHandler,
);

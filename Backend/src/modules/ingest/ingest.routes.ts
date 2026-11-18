import { Router } from 'express';
import { authenticateIngest } from '../../middleware/authenticateIngest.js';
import { ingestLimiter } from '../../middleware/limiters.js';
import { validate } from '../../middleware/validate.js';
import { ingestTelemetryHandler } from './ingest.controller.js';
import { ingestBodySchema } from './ingest.schemas.js';

export const ingestRouter = Router();

/**
 * A unica rota de escrita de telemetria do servico.
 *
 * Uma rota, dois chamadores legitimos - a pulseira com token de aparelho, o
 * celular com o access token do cuidador - porque o transporte da pulseira
 * ate aqui ainda nao foi decidido (wifi direto ou BLE para o celular). O corpo
 * e o mesmo frame do firmware nos dois casos, e o indice unico de Reading faz
 * com que receber o mesmo frame pelos dois caminhos nao duplique nada.
 *
 * authenticateIngest antes do limite: o limite conta por APARELHO, nao por IP.
 * Varias pulseiras atras do mesmo NAT nao podem gastar a cota uma da outra.
 */
ingestRouter.post(
  '/telemetry',
  authenticateIngest,
  ingestLimiter,
  validate({ body: ingestBodySchema }),
  ingestTelemetryHandler,
);

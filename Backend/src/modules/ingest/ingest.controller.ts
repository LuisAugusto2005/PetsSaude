import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import * as ingestService from './ingest.service.js';
import type { IngestBody } from './ingest.schemas.js';

export const ingestTelemetryHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.device && !req.user) throw AppError.unauthorized();

  const resultado = await ingestService.ingestTelemetry(req.body as IngestBody, {
    device: req.device,
    user: req.user,
  });

  // 202 e nao 201: o servidor aceitou o lote, mas o que ele GUARDA nao e o que
  // chegou - a amostragem descarta frames de proposito, e a reentrega nao cria
  // recurso novo. O corpo diz exatamente o que aconteceu com cada frame, que e
  // o que o firmware precisa para decidir se pode limpar o buffer.
  res.status(202).json(resultado);
});

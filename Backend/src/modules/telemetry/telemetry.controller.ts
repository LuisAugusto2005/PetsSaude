import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { descreverIntervalo, registrarAcesso } from '../audit/audit.service.js';
import * as telemetryService from './telemetry.service.js';
import type { ListAlertsQuery, ListReadingsQuery } from './telemetry.schemas.js';

export const listReadingsHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const query = req.query as unknown as ListReadingsQuery;
  const result = await telemetryService.listReadings(req.patientAccess.patientId, query);

  // Abrir historico de dado de saude entra na trilha. GET /patients/:id nao
  // entra: ver o comentario de accessLog.model.
  await registrarAcesso(req, {
    action: 'read_readings',
    patientId: req.patientAccess.patientId,
    detail: descreverIntervalo(query.from, query.to),
    resultCount: result.itens.length,
  });

  res.json(result);
});

export const listAlertsHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const query = req.query as unknown as ListAlertsQuery;
  const result = await telemetryService.listAlerts(req.patientAccess.patientId, query);

  await registrarAcesso(req, {
    action: 'read_alerts',
    patientId: req.patientAccess.patientId,
    detail: descreverIntervalo(query.from, query.to),
    resultCount: result.itens.length,
  });

  res.json(result);
});

export const acknowledgeAlertHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const alerta = await telemetryService.acknowledgeAlert(req.params.id as string, req.user);
  res.json(telemetryService.alertaParaApi(alerta.toObject()));
});

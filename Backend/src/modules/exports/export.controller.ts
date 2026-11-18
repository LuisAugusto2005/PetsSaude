import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { descreverIntervalo, registrarAcesso } from '../audit/audit.service.js';
import * as exportService from './export.service.js';
import type { ExportPatientQuery } from './export.schemas.js';

export const exportPatientHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const query = req.query as unknown as ExportPatientQuery;

  const linhas = await exportService.streamPatientExport(res, req.patientAccess.patientId, query);

  // Depois do stream: a trilha registra quantas linhas de fato sairam, que e
  // a informacao que uma auditoria quer - "exportou" sem o volume nao diz
  // se foram dez linhas ou um mes inteiro de telemetria.
  await registrarAcesso(req, {
    action: 'export_patient',
    patientId: req.patientAccess.patientId,
    detail: `${query.format} ${query.type} ${descreverIntervalo(query.from, query.to)}`,
    resultCount: linhas,
  });
});

export const exportSelfHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const dados = await exportService.exportSelf(req.user.id);

  await registrarAcesso(req, { action: 'export_self', detail: 'portabilidade LGPD' });

  res.setHeader('Content-Disposition', 'attachment; filename="vitalwatch-meus-dados.json"');
  res.json(dados);
});

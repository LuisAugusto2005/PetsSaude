import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import type { Pagination } from '../../shared/validation.js';
import { listAccessLog, registrarAcesso } from './audit.service.js';
import { patientHistory } from './history.service.js';

export const patientHistoryHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const result = await patientHistory(
    req.patientAccess.patientId,
    req.query as unknown as Pagination,
  );
  res.json(result);
});

export const accessLogHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const result = await listAccessLog(
    req.patientAccess.patientId,
    req.query as unknown as Pagination,
  );

  // Quem audita tambem fica na trilha: sem isso, abrir a trilha dos outros
  // seria o unico acesso invisivel do sistema.
  await registrarAcesso(req, {
    action: 'read_access_log',
    patientId: req.patientAccess.patientId,
  });

  res.json(result);
});

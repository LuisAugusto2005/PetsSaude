import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import * as careLinkService from './careLink.service.js';
import type {
  CreateCareLinkInput,
  ListCareLinksQuery,
  UpdateCareLinkInput,
} from './careLink.schemas.js';

export const createCareLinkHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || !req.patientAccess) throw AppError.forbidden();
  const link = await careLinkService.createCareLink(
    req.user,
    req.patientAccess,
    req.body as CreateCareLinkInput,
  );
  res.status(201).json(link.toJSON());
});

export const listCareLinksHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const links = await careLinkService.listCareLinks(
    req.patientAccess.patientId,
    req.query as unknown as ListCareLinksQuery,
  );
  res.json({ itens: links });
});

export const updateCareLinkHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const link = await careLinkService.updateCareLink(
    req.params.id as string,
    req.user,
    req.body as UpdateCareLinkInput,
  );
  res.json(link.toJSON());
});

export const revokeCareLinkHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  await careLinkService.revokeCareLink(req.params.id as string, req.user);
  res.status(204).send();
});

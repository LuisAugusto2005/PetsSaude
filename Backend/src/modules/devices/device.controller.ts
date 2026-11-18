import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import * as deviceService from './device.service.js';
import type {
  AssignDeviceInput,
  CreateDeviceInput,
  ListDevicesQuery,
  ReleaseDeviceInput,
  UpdateDeviceInput,
} from './device.schemas.js';

export const createDeviceHandler = asyncHandler(async (req: Request, res: Response) => {
  const device = await deviceService.createDevice(req.body as CreateDeviceInput);
  res.status(201).json(device.toJSON());
});

export const listDevicesHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const result = await deviceService.listDevices(
    req.user,
    req.query as unknown as ListDevicesQuery,
  );
  res.json(result);
});

export const getDeviceHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const id = req.params.id as string;
  await deviceService.assertPodeVerDevice(id, req.user);
  const device = await deviceService.getDevice(id);
  res.json(device.toJSON());
});

export const updateDeviceHandler = asyncHandler(async (req: Request, res: Response) => {
  const device = await deviceService.updateDevice(
    req.params.id as string,
    req.body as UpdateDeviceInput,
  );
  res.json(device.toJSON());
});

export const assignDeviceHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const assignment = await deviceService.assignDevice(
    req.params.id as string,
    req.user,
    req.body as AssignDeviceInput,
  );
  res.status(201).json(assignment.toJSON());
});

export const releaseDeviceHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const { assignment, responsaveisRevogados } = await deviceService.releaseDevice(
    req.params.id as string,
    req.user,
    req.body as ReleaseDeviceInput,
  );
  res.json({ ...assignment.toJSON(), responsaveisRevogados });
});

export const revokeResponsaveisHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const { patientId, revogados } = await deviceService.revokeResponsaveisDoDevice(
    req.params.id as string,
    req.user,
  );
  res.json({ patientId: String(patientId), responsaveisRevogados: revogados });
});

export const issueIngestTokenHandler = asyncHandler(async (req: Request, res: Response) => {
  const { device, token } = await deviceService.issueIngestToken(req.params.id as string);
  // O token aparece AQUI e em nenhum outro lugar, nunca mais: o banco tem so
  // o hash. O aviso faz parte da resposta de proposito, porque quem provisiona
  // a pulseira precisa saber que nao da para consultar depois.
  res.status(201).json({
    bandNumber: device.bandNumber,
    deviceId: device.deviceId,
    ingestToken: token,
    criadoEm: device.ingestTokenCreatedAt,
    aviso:
      'Guarde este token agora: o servidor armazena apenas o hash e nao consegue mostra-lo de novo. Emitir outro invalida este.',
  });
});

export const revokeIngestTokenHandler = asyncHandler(async (req: Request, res: Response) => {
  const device = await deviceService.revokeIngestToken(req.params.id as string);
  res.json({ bandNumber: device.bandNumber, ingestToken: null });
});

export const listAssignmentsHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const id = req.params.id as string;
  await deviceService.assertPodeVerDevice(id, req.user);
  res.json({ itens: await deviceService.listAssignments(id) });
});

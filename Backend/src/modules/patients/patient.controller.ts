import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import * as patientService from './patient.service.js';
import type {
  CreatePatientInput,
  ListPatientsQuery,
  UpdatePatientInput,
} from './patient.schemas.js';

export const createPatientHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const { patient, relation } = await patientService.createPatient(
    req.user,
    req.body as CreatePatientInput,
  );
  res.status(201).json({ ...patient.toJSON(), meuVinculo: relation });
});

export const listPatientsHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const result = await patientService.listPatients(
    req.user,
    req.query as unknown as ListPatientsQuery,
  );
  res.json(result);
});

export const getPatientHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const patient = await patientService.getPatient(req.patientAccess.patientId);
  res.json({
    ...patient.toJSON(),
    meuVinculo: req.patientAccess.relation,
    minhasPermissoes: req.patientAccess.permissions,
  });
});

export const updatePatientHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.patientAccess) throw AppError.forbidden();
  const patient = await patientService.updatePatient(
    req.patientAccess.patientId,
    req.body as UpdatePatientInput,
  );
  res.json(patient.toJSON());
});

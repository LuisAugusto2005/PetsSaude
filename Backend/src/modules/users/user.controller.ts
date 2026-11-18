import type { Request, Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import * as userService from './user.service.js';
import type { ListUsersQuery, UpdateMeInput } from './user.schemas.js';

export const getMeHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const user = await userService.getMe(req.user.id);
  res.json(user.toJSON());
});

export const updateMeHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const user = await userService.updateMe(req.user.id, req.body as UpdateMeInput);
  res.json(user.toJSON());
});

export const listUsersHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await userService.listUsers(req.query as unknown as ListUsersQuery);
  res.json(result);
});

export const approveUserHandler = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.approveUser(req.params.id as string);
  res.json(user.toJSON());
});

export const disableUserHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw AppError.unauthorized();
  const user = await userService.disableUser(req.params.id as string, req.user);
  res.json(user.toJSON());
});

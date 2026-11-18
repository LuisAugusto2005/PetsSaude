import { z } from '../../shared/zod.js';
import { LINK_MODES } from '../../shared/types.js';
import { objectIdSchema, paginationSchema } from '../../shared/validation.js';

export const createDeviceSchema = z.object({
  bandNumber: z.coerce.number().int().min(1).max(9999),
  deviceId: z.string().trim().max(64).optional(),
  deviceName: z.string().trim().max(64).optional(),
  firmware: z.string().trim().max(32).optional(),
  linkMode: z.enum(LINK_MODES).default('espnow'),
  ownerOrg: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const updateDeviceSchema = z
  .object({
    deviceId: z.string().trim().max(64).optional(),
    deviceName: z.string().trim().max(64).optional(),
    firmware: z.string().trim().max(32).optional(),
    linkMode: z.enum(LINK_MODES).optional(),
    status: z.enum(['available', 'maintenance', 'retired']).optional(),
    ownerOrg: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Informe ao menos um campo');

export const listDevicesSchema = paginationSchema.extend({
  status: z.enum(['available', 'assigned', 'maintenance', 'retired']).optional(),
});

export const assignDeviceSchema = z.object({
  patientId: objectIdSchema,
  notes: z.string().trim().max(500).optional(),
});

export const releaseDeviceSchema = z.object({
  notes: z.string().trim().max(500).optional(),
  /**
   * Revoga de uma vez todos os responsaveis do paciente. Tirar a pulseira do
   * paciente E a alta na pratica: uma chamada em vez de duas.
   */
  revokeResponsaveis: z.boolean().default(false),
});

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesSchema>;
export type AssignDeviceInput = z.infer<typeof assignDeviceSchema>;
export type ReleaseDeviceInput = z.infer<typeof releaseDeviceSchema>;

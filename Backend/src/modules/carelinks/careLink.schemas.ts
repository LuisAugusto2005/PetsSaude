import { z } from '../../shared/zod.js';
import { objectIdSchema } from '../../shared/validation.js';
import { CARE_RELATIONS } from '../../shared/types.js';

const permissionsSchema = z.object({
  viewHistory: z.boolean().default(true),
  receiveAlerts: z.boolean().default(true),
  manageDevice: z.boolean().default(false),
  acknowledgeAlerts: z.boolean().default(false),
});

export const createCareLinkSchema = z
  .object({
    /** Identifica o cuidador por e-mail (pratico) ou por id (programatico). */
    caregiverEmail: z.string().trim().toLowerCase().max(254).optional(),
    caregiverId: objectIdSchema.optional(),
    relation: z.enum(CARE_RELATIONS),
    permissions: permissionsSchema.optional(),
  })
  .refine(
    (d) => Boolean(d.caregiverEmail) !== Boolean(d.caregiverId),
    'Informe caregiverEmail OU caregiverId, nao os dois',
  );

export const updateCareLinkSchema = z.object({
  permissions: permissionsSchema.partial(),
});

export const listCareLinksSchema = z.object({
  includeRevoked: z.coerce.boolean().default(false),
});

export type CreateCareLinkInput = z.infer<typeof createCareLinkSchema>;
export type UpdateCareLinkInput = z.infer<typeof updateCareLinkSchema>;
export type ListCareLinksQuery = z.infer<typeof listCareLinksSchema>;

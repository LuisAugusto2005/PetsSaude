import { z } from '../../shared/zod.js';
import { paginationSchema, phoneSchema } from '../../shared/validation.js';
import { USER_ROLES, USER_STATUSES } from '../../shared/types.js';

export const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: phoneSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Informe ao menos um campo para atualizar');

/** Fila de aprovacao e busca de usuarios. Rota de admin. */
export const listUsersSchema = paginationSchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  role: z.enum(USER_ROLES).optional(),
  /** Busca por nome ou e-mail. */
  q: z.string().trim().max(120).optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type ListUsersQuery = z.infer<typeof listUsersSchema>;

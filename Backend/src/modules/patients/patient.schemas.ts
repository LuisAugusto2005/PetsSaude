import { z } from '../../shared/zod.js';
import { objectIdSchema, paginationSchema } from '../../shared/validation.js';
import { CARE_RELATIONS } from '../../shared/types.js';

/**
 * Cadastrar paciente e UM campo: o nome.
 *
 * Idade, quarto e contato vem da pulseira em todo frame de telemetria, entao
 * pedi-los aqui seria digitar duas vezes o mesmo dado e manter duas versoes.
 */
export const createPatientSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do paciente').max(120),
  /** Liga um User existente ao paciente, para o caso de paciente autonomo. */
  userId: objectIdSchema.optional(),
});

export const updatePatientSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, 'Informe ao menos um campo');

export const listPatientsSchema = paginationSchema.extend({
  /** Busca por nome, case-insensitive. */
  q: z.string().trim().max(120).optional(),
  relation: z.enum(CARE_RELATIONS).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type ListPatientsQuery = z.infer<typeof listPatientsSchema>;

import { z } from '../../shared/zod.js';

/**
 * Parametros do export. `from`/`to` em hora de servidor.
 *
 * Nao ha teto de intervalo: a TTL de 30 dias das leituras ja limita o maximo
 * possivel, e o export e stream - intervalo grande custa tempo, nao memoria.
 */
export const exportPatientSchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  /**
   * 'all' so faz diferenca em JSON: um CSV comporta uma tabela, nao duas.
   * Em CSV, 'all' sai como as leituras.
   */
  type: z.enum(['readings', 'alerts', 'all']).default('all'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type ExportPatientQuery = z.infer<typeof exportPatientSchema>;

import { z } from '../../shared/zod.js';
import { MAX_FRAMES_POR_LOTE } from '../../shared/types.js';
import { firmwareTelemetrySchema } from '../telemetry/telemetry.schemas.js';

/**
 * Corpo da ingestao: um frame, ou um lote deles.
 *
 * O lote existe para o buffer: a pulseira (ou o celular) guarda o que coletou
 * enquanto esteve sem rede e entrega tudo na reconexao. Um frame por request
 * obrigaria centenas de requests em sequencia depois de cada queda de link.
 *
 * ORDEM IMPORTA no lote: os frames precisam vir em ordem cronologica. Sem
 * boot_id, e a unica pista que o servidor tem para saber que houve um reboot
 * no meio - o uptime voltar para tras entre dois frames vizinhos. Com
 * boot_id, a ordem deixa de ser critica para a deteccao, mas continua sendo
 * o que define o espacamento dos carimbos de chegada.
 *
 * O teto de MAX_FRAMES_POR_LOTE e o declarado; o teto REAL e o limite de
 * 256 kB do corpo em app.ts, que chega antes com frames completos.
 */
export const ingestBodySchema = z
  .union([
    z.array(firmwareTelemetrySchema).min(1).max(MAX_FRAMES_POR_LOTE),
    firmwareTelemetrySchema,
  ])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export type IngestBody = z.infer<typeof ingestBodySchema>;

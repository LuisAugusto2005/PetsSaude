import { z } from '../../shared/zod.js';
import { ALERT_KEYS, MOVEMENT_CLASSES, POSTURE_IDS } from '../../shared/types.js';
import { paginationSchema } from '../../shared/validation.js';

/**
 * Intervalo de consulta, em hora de SERVIDOR (receivedAt / firstSeenAt).
 *
 * Nunca em uptime: uptime zera no reboot da pulseira e nao localiza nada.
 */
const intervaloSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const listReadingsSchema = paginationSchema.extend(intervaloSchema.shape);

export const listAlertsSchema = paginationSchema.extend({
  ...intervaloSchema.shape,
  status: z.enum(['active', 'normalized', 'acknowledged']).optional(),
  alertKey: z.enum(ALERT_KEYS).optional(),
});

export type ListReadingsQuery = z.infer<typeof listReadingsSchema>;
export type ListAlertsQuery = z.infer<typeof listAlertsSchema>;

/**
 * O JSON que o gateway serve em /api/data e empurra pelo WebSocket, conforme
 * a secao 6 do VitalWatch_Comunicacao e o parse ja existente no app Kotlin
 * (AppKotlin/.../data/Telemetry.kt).
 *
 * E o corpo que POST /api/ingest/telemetry aceita, vindo do ESP32 por wifi ou
 * repassado pelo celular por BLE. O MESMO schema para os dois caminhos, de
 * proposito: o servidor nao precisa saber quem entregou, e um frame que vale
 * por um caminho vale pelo outro.
 *
 * Tudo que nao e essencial e opcional de proposito: a pulseira em modo wifi
 * nao manda o bloco 'gateway', e versoes de firmware diferentes omitem
 * campos. Rejeitar um frame inteiro por causa de um campo novo seria pior que
 * ignora-lo.
 */
export const firmwareTelemetrySchema = z.looseObject({
  /**
   * O NUMERO da pulseira, nao uma string.
   *
   * A secao 6 do VitalWatch_Comunicacao e explicita: `"device_id":12`, e a
   * tabela de campos diz "Numero da pulseira e nome (VitalWatch<N>)". O app
   * Kotlin le o campo com optInt (data/Telemetry.kt), o que confirma.
   *
   * Um numero aqui casa com Device.bandNumber; uma string casa com
   * Device.deviceId, que existe para um identificador alfanumerico futuro
   * (derivado do MAC, por exemplo - ver docs/contrato-firmware.md). Aceitar os
   * dois custa uma linha e evita que a primeira pulseira de verdade tome 400.
   */
  device_id: z.union([z.number().int().min(1).max(9999), z.string().max(64)]).optional(),
  device_name: z.string().max(64).optional(),
  firmware: z.string().max(32).optional(),
  mode: z.enum(['normal', 'setup', 'config']).optional(),

  /** Uptime da pulseira em ms, NAO hora. Zera no reboot. */
  timestamp_ms: z.number().int().min(0),
  uptime_s: z.number().int().min(0).optional(),

  /**
   * Contador de ligadas, incrementado na NVS a cada boot.
   *
   * OPCIONAL porque o firmware ainda nao manda: enquanto nao mandar, o
   * servidor infere o reboot vendo o uptime voltar para tras. A inferencia
   * funciona ao vivo e falha no lote bufferizado - frames de antes do reboot
   * entregues depois dele seriam atribuidos a ligada nova. Com boot_id a
   * chave {device_id, boot_id, uptime_ms} e exata.
   *
   * Ver docs/contrato-firmware.md.
   */
  boot_id: z.number().int().min(0).optional(),

  /**
   * Pior nivel de alerta ativo, como o firmware ja manda ('none' quando nao
   * ha). Aceito e documentado, mas NAO e a fonte de verdade: a amostragem
   * deriva o pior nivel do proprio array alerts[], para nao depender de um
   * campo que versoes antigas do firmware podem omitir.
   */
  alert_worst: z.string().max(20).optional(),

  patient: z
    .object({
      name: z.string().max(120).optional(),
      age: z.number().int().min(0).max(130).nullable().optional(),
      room: z.string().max(40).optional(),
      contact: z.string().max(40).optional(),
    })
    .optional(),

  posture: z
    .object({
      id: z.enum(POSTURE_IDS).optional(),
      label: z.string().max(40).optional(),
      inclination: z.number().optional(),
      stable: z.boolean().optional(),
    })
    .optional(),

  movement: z
    .object({
      class: z.enum(MOVEMENT_CLASSES).optional(),
      label: z.string().max(40).optional(),
      energy: z.number().optional(),
      tremor: z.boolean().optional(),
      tremor_freq: z.number().optional(),
      tremor_s: z.number().optional(),
      odd: z.boolean().optional(),
    })
    .optional(),

  fall: z
    .object({
      detected: z.boolean().optional(),
      simulated: z.boolean().optional(),
      /** Fase da deteccao de queda: 0 nenhuma, 3 confirmada. Numero, nao texto. */
      phase: z.number().int().min(0).optional(),
      count: z.number().int().min(0).optional(),
    })
    .optional(),

  panic: z
    .object({
      active: z.boolean().optional(),
      count: z.number().int().min(0).optional(),
      since_ms: z.number().int().min(0).optional(),
    })
    .optional(),

  alerts: z
    .array(
      z.object({
        id: z.enum(ALERT_KEYS),
        level: z.enum(['critical', 'warn', 'info']),
        title: z.string().max(120).optional(),
        detail: z.string().max(300).optional(),
        since_ms: z.number().int().min(0),
        active: z.boolean(),
      }),
    )
    .optional(),

  events: z
    .array(
      z.object({
        seq: z.number().int().min(0),
        t_ms: z.number().int().min(0),
        id: z.string().max(32),
        text: z.string().max(200).optional(),
      }),
    )
    .optional(),

  battery: z
    .object({
      percent: z.number().min(0).max(100).optional(),
      voltage: z.number().optional(),
      charging: z.boolean().optional(),
    })
    .optional(),

  network: z
    .object({
      link: z.enum(['espnow', 'wifi', 'ble', 'both']).optional(),
      mode: z.string().max(20).optional(),
      ssid: z.string().max(64).optional(),
      ip: z.string().max(45).optional(),
      rssi: z.number().optional(),
    })
    .optional(),

  /** Ausente quando a propria pulseira serve a API (modo wifi). */
  gateway: z
    .object({
      name: z.string().max(64).optional(),
      firmware: z.string().max(32).optional(),
      channel: z.number().int().optional(),
      rssi: z.number().optional(),
      lost: z.number().int().min(0).optional(),
      age_ms: z.number().int().min(0).optional(),
      bands_online: z.number().int().min(0).optional(),
    })
    .optional(),
});

export type FirmwareTelemetry = z.infer<typeof firmwareTelemetrySchema>;

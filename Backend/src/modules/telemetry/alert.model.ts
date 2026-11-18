import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';
import { ALERT_KEYS, ALERT_LEVELS } from '../../shared/types.js';

/**
 * Uma OCORRENCIA de alerta, nao um booleano de estado.
 *
 * O firmware tem tres situacoes distintas que um booleano nao representa:
 *
 *  - panic e fall sao 'critical' e ficam ACESOS ate alguem reconhecer
 *    (latched). Nao se apagam sozinhos.
 *  - tremor e odd_motion sao 'warn' e se limpam quando a condicao passa.
 *  - active:false e um tumulo: "acabou de normalizar, mostre esmaecido e sem
 *    som por alguns segundos", o que nao e a mesma coisa que resolvido.
 *
 * Dai o status como enum, com acknowledgedAt/acknowledgedBy: saber QUEM
 * atendeu e em QUANTO tempo e justamente a frente de trabalho "Resposta ao
 * alerta" dos documentos (quem recebe, em que tempo, quando chamar o SAMU).
 */
const alertSchema = new Schema(
  {
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    /** Hora do servidor em que a ligada atual da pulseira comecou. */
    bootAt: { type: Date, required: true },

    alertKey: { type: String, enum: ALERT_KEYS, required: true },
    level: { type: String, enum: ALERT_LEVELS, required: true },
    detail: { type: String, trim: true, maxlength: 300 },

    /** since_ms do firmware: uptime relativo, legivel junto com bootAt. */
    sinceUptimeMs: { type: Number, required: true, min: 0 },
    /** Hora do servidor da primeira e da ultima vez que o vimos ativo. */
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },

    status: {
      type: String,
      enum: ['active', 'normalized', 'acknowledged'],
      default: 'active',
    },
    /** true para panic e fall: nao se apaga sem ack. */
    isLatched: { type: Boolean, required: true },

    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Como a ocorrencia chegou ao servidor. Ver Reading.source. */
    source: { type: String, enum: ['gateway', 'direct', 'app', 'seed'], default: 'gateway' },
    /** Quem repassou, quando veio pelo celular. Ver Reading.deliveredBy. */
    deliveredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** Onde o ack foi dado: no app, no painel do gateway, ou na propria pulseira. */
    acknowledgedVia: {
      type: String,
      enum: ['app', 'gateway', 'device', null],
      default: null,
    },
  },
  { timestamps: true },
);

/**
 * Chave natural da ocorrencia. O app Kotlin ja identifica alerta pela tupla
 * "deviceId:alert.id:alert.sinceMs"; aqui entra o bootAt, que e o que faltava
 * para a tupla ser estavel entre reboots - since_ms e uptime e se repete
 * depois de religar a pulseira.
 */
alertSchema.index(
  { deviceId: 1, bootAt: 1, alertKey: 1, sinceUptimeMs: 1 },
  { unique: true, name: 'alerta_ocorrencia_unica' },
);
// "O que esta pegando fogo agora?" - a consulta da tela inicial.
alertSchema.index({ patientId: 1, status: 1, firstSeenAt: -1 });
alertSchema.index({ patientId: 1, firstSeenAt: -1 });
// Alert nao tem TTL de proposito: Reading expira, ocorrencia de alerta fica.

export type AlertDoc = HydratedDocument<InferSchemaType<typeof alertSchema>>;
/** Objeto cru, como volta de .lean() ou .toObject(). */
export type AlertPlano = InferSchemaType<typeof alertSchema> & { _id: Types.ObjectId };
export const Alert = model('Alert', alertSchema);

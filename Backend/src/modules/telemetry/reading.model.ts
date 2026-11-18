import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from 'mongoose';
import { MOVEMENT_CLASSES, POSTURE_IDS } from '../../shared/types.js';

/**
 * Uma amostra de telemetria da pulseira.
 *
 * Os blocos espelham o JSON do firmware (secao 6 do VitalWatch_Comunicacao),
 * o mesmo que o app Kotlin ja parseia em data/Telemetry.kt.
 *
 * NAO existe batimento cardiaco nem SpO2: o sensor foi testado e abandonado
 * ("no pulso a leitura e pouco confiavel, encarece a pulseira e gasta
 * bateria"). A pulseira hoje tem acelerometro, botao e MCU.
 */
const readingSchema = new Schema(
  {
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    /**
     * Desnormalizado do DeviceAssignment aberto no momento da ingestao.
     * Fica gravado na leitura de proposito: a pulseira troca de paciente, e
     * resolver o dono por join depois daria a resposta errada.
     */
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    /**
     * Hora do servidor em que esta LIGADA da pulseira comecou (Device.
     * currentBootAt no momento da ingestao). Desempata uptimes que se repetem
     * depois de um reboot.
     */
    bootAt: { type: Date, required: true },

    /** Hora do SERVIDOR. A unica hora confiavel no sistema. */
    receivedAt: { type: Date, required: true },
    /** timestamp_ms do firmware: uptime, nao hora. */
    uptimeMs: { type: Number, required: true, min: 0 },

    posture: {
      id: { type: String, enum: POSTURE_IDS, default: 'unknown' },
      inclination: { type: Number, default: null },
      stable: { type: Boolean, default: null },
    },
    movement: {
      class: { type: String, enum: MOVEMENT_CLASSES, default: 'unknown' },
      energy: { type: Number, default: null },
      tremor: { type: Boolean, default: null },
      tremorFreq: { type: Number, default: null },
      tremorS: { type: Number, default: null },
      odd: { type: Boolean, default: null },
    },
    fall: {
      detected: { type: Boolean, default: false },
      simulated: { type: Boolean, default: false },
      /** Fase da deteccao: 0 nenhuma, 3 confirmada. Ver secao 6 do documento. */
      phase: { type: Number, min: 0, default: null },
      count: { type: Number, default: 0 },
    },
    panic: {
      active: { type: Boolean, default: false },
      count: { type: Number, default: 0 },
    },

    batteryPct: { type: Number, min: 0, max: 100, default: null },
    rssi: { type: Number, default: null },
    /**
     * Quem ENTREGOU a leitura ao servidor:
     *
     *   direct    a propria pulseira, por wifi, com token de aparelho
     *   app       o celular, repassando o que recebeu por BLE
     *   gateway   o gateway na tomada (ESP-NOW -> HTTP), quando existir
     *   seed      dado de desenvolvimento
     *
     * Nao e a mesma coisa que Device.linkMode, que diz como a PULSEIRA fala.
     * O mesmo frame pode chegar pelos dois caminhos; o indice unico garante
     * que isso nao duplique, e o primeiro que chegar define o source.
     */
    source: { type: String, enum: ['gateway', 'direct', 'app', 'seed'], default: 'gateway' },
    /**
     * Usuario que REPASSOU esta leitura, quando o caminho foi o celular.
     *
     * Nulo quando a propria pulseira entregou (token de aparelho). Existe
     * porque o caminho BLE aceita qualquer cuidador com vinculo ativo, sem
     * exigir manageDevice - sem isso, dado injetado por um cuidador seria
     * indistinguivel de dado da pulseira. Nao impede a injecao; assina.
     */
    deliveredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: false },
);

// A consulta de historico: as leituras de um paciente num intervalo.
readingSchema.index({ patientId: 1, receivedAt: -1 });
readingSchema.index({ deviceId: 1, receivedAt: -1 });
// Uma leitura por device/ligada/uptime: reenvio do mesmo frame nao duplica,
// e o mesmo uptime em ligadas diferentes continua valido (uptime zera no boot).
readingSchema.index({ deviceId: 1, bootAt: 1, uptimeMs: 1 }, { unique: true });

/**
 * TTL de 30 dias. O firmware manda STATE a cada 2 s (1 s com alerta ativo),
 * o que da cerca de 1,3 milhao de documentos por mes POR PULSEIRA. Guardar
 * tudo para sempre estoura o M0 gratuito do Atlas em dias.
 *
 * Quando houver agregacao por hora, e ela que fica no longo prazo; a amostra
 * crua expira. Os Alert NAO expiram.
 */
readingSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export type ReadingDoc = HydratedDocument<InferSchemaType<typeof readingSchema>>;
/** Objeto cru, como volta de .lean() ou .toObject(). */
export type ReadingPlano = InferSchemaType<typeof readingSchema> & { _id: Types.ObjectId };
export const Reading = model('Reading', readingSchema);

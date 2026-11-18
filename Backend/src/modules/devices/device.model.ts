import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DEVICE_STATUSES, LINK_MODES } from '../../shared/types.js';

/**
 * A pulseira como entidade propria, independente de paciente.
 *
 * Os documentos do projeto deixam claro que a pulseira e do hospital e passa
 * de paciente para paciente (emprestimo, devolucao na alta, higienizacao).
 * Por isso NAO existe patientId aqui: o vinculo vive em DeviceAssignment,
 * com intervalo de validade. Guardar o paciente dentro do Device faria a
 * queda de um aparecer no historico do proximo.
 */
const deviceSchema = new Schema(
  {
    /**
     * O <N> de 1 a 9999 do firmware. E ele que gera a identidade toda:
     * AP "VitalWatch12", nome BLE "VitalWatch12", mDNS vitalwatch12.local.
     */
    bandNumber: { type: Number, required: true, unique: true, min: 1, max: 9999 },
    /** O device_id que vem na telemetria. */
    deviceId: { type: String, trim: true, maxlength: 64, default: null },
    deviceName: { type: String, trim: true, maxlength: 64 },
    firmware: { type: String, trim: true, maxlength: 32 },
    linkMode: { type: String, enum: LINK_MODES, default: 'espnow' },
    status: { type: String, enum: DEVICE_STATUSES, default: 'available' },

    /** Ultimo estado conhecido, atualizado pela ingestao (etapa futura). */
    batteryPct: { type: Number, min: 0, max: 100, default: null },
    rssi: { type: Number, default: null },
    /**
     * Carimbo do SERVIDOR. A pulseira nao tem relogio: os campos
     * timestamp_ms / since_ms / t_ms do firmware sao uptime e zeram no
     * reboot, logo nao servem como hora.
     */
    lastSeenAt: { type: Date, default: null },

    /**
     * Ultimo uptime recebido, e o inicio da ligada atual da pulseira.
     *
     * Substituem a colecao BootSession. A ingestao compara o uptimeMs que
     * chegou com lastUptimeMs: se veio MENOR, a pulseira rebootou, e
     * currentBootAt passa a ser a hora atual do servidor. Esse carimbo vai
     * para cada Reading e Alert gravado.
     *
     * Existe porque a pulseira nao tem relogio: timestamp_ms, since_ms e t_ms
     * sao uptime e zeram no reboot, e events[].seq reinicia em 0. Sem ancorar
     * esses numeros a uma ligada, duas quedas em ligadas diferentes podem ter
     * since_ms identico - e a segunda seria descartada como duplicata.
     *
     * E a mesma deteccao que o app ja faz em
     * VitalWatchViewModel.registrarEventos (maior < ultimo), agora no servidor.
     */
    lastUptimeMs: { type: Number, min: 0, default: null },
    currentBootAt: { type: Date, default: null },
    /**
     * boot_id da ligada atual, quando o firmware manda esse campo.
     *
     * Com ele a deteccao de reboot deixa de ser inferencia: boot_id diferente
     * do guardado e uma ligada nova, mesmo que o uptime tenha subido. E o que
     * faz um lote bufferizado entregue depois de um reboot cair na ligada
     * certa, em vez de ser misturado com a atual.
     */
    currentBootId: { type: Number, min: 0, default: null },

    /**
     * Resumo da ULTIMA leitura gravada, usado pela amostragem.
     *
     * Mora aqui, e nao numa consulta a colecao Reading, porque a decisao
     * acontece a cada frame (a cada 2 s por pulseira) e ja existe uma escrita
     * no Device nesse mesmo caminho - lastSeenAt, lastUptimeMs, bateria. Ler
     * a ultima leitura do banco a cada frame seria uma consulta a mais por
     * amostra descartada, que e justamente o caso comum.
     */
    lastSample: {
      at: { type: Date, default: null },
      /** Ligada a que a ultima amostra pertence. Ver devoGravar. */
      bootAt: { type: Date, default: null },
      postureId: { type: String, default: null },
      movementClass: { type: String, default: null },
      fallDetected: { type: Boolean, default: null },
      panicActive: { type: Boolean, default: null },
      alertWorst: { type: String, default: null },
    },

    /**
     * SHA-256 do token de ingestao do aparelho, nunca o token em si - mesma
     * logica da senha e do refresh token: se o banco vazar, o que vazou nao
     * abre nada.
     *
     * select: false para nao sair em nenhuma resposta por descuido: as rotas
     * de device devolvem o documento inteiro com toJSON.
     *
     * Nulo significa que a pulseira nao pode ingerir sozinha. Isso e o padrao:
     * o token e emitido por um admin quando o aparelho vai para campo.
     */
    ingestTokenHash: { type: String, default: null, select: false },
    ingestTokenCreatedAt: { type: Date, default: null },

    /** Instituicao dona do aparelho, para o cenario de emprestimo. */
    ownerOrg: { type: String, trim: true, maxlength: 120 },
    notes: { type: String, trim: true, maxlength: 1000 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

deviceSchema.index(
  { deviceId: 1 },
  { unique: true, partialFilterExpression: { deviceId: { $type: 'string' } } },
);
deviceSchema.index({ status: 1 });
// Busca do aparelho pelo token em cada frame ingerido: precisa ser por indice.
// Unico para que dois aparelhos nunca compartilhem credencial.
deviceSchema.index(
  { ingestTokenHash: 1 },
  { unique: true, partialFilterExpression: { ingestTokenHash: { $type: 'string' } } },
);

export type DeviceDoc = HydratedDocument<InferSchemaType<typeof deviceSchema>>;
export const Device = model('Device', deviceSchema);

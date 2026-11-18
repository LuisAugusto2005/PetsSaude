import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ACCESS_ACTIONS } from '../../shared/types.js';

/**
 * Trilha de acesso a dado de saude: quem leu o que, e quando.
 *
 * E o que a LGPD pede para dado sensivel, e o que `CareLink` revogado em vez
 * de apagado nao resolve: aquele diz quem TINHA acesso, este diz quem USOU.
 *
 * ESCOLHA CENTRAL: registra os acessos pesados, nao todo GET.
 *
 * Registrar cada leitura pareceria mais seguro e seria pior. Uma enfermeira
 * com o painel aberto gera milhares de linhas por turno, quase todas iguais,
 * e a colecao de auditoria passa a ser maior que a de telemetria - entao
 * ninguem consegue achar o acesso que importa no meio do ruido. Ficam de fora,
 * de proposito, GET /patients/:id (so o nome, e e o que a tela mais recarrega)
 * e GET /patients (lista do proprio vinculo).
 *
 * Ficam dentro: abrir historico de leituras, abrir lista de alertas, exportar,
 * e ler esta propria trilha.
 */
const accessLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Nulo em acesso que nao e sobre um paciente (export dos proprios dados). */
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', default: null },
    action: { type: String, enum: ACCESS_ACTIONS, required: true },
    /** O que exatamente foi lido: intervalo, formato, quantas linhas sairam. */
    detail: { type: String, trim: true, maxlength: 300 },
    /** Quantos registros o acesso devolveu. Zero e informacao: busca vazia. */
    resultCount: { type: Number, min: 0, default: null },
    ip: { type: String, trim: true, maxlength: 60 },
    userAgent: { type: String, trim: true, maxlength: 300 },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

// "Quem andou olhando os dados desta paciente?" - a pergunta da auditoria.
accessLogSchema.index({ patientId: 1, at: -1 });
// "O que esta pessoa acessou?" - a pergunta do RH e a do titular.
accessLogSchema.index({ userId: 1, at: -1 });

/**
 * Retencao de 2 anos.
 *
 * Nao e numero tecnico, e politica: a trilha tem de sobreviver as leituras que
 * ela descreve (que expiram em 30 dias) e durar o suficiente para uma
 * auditoria ou um pedido do titular. Dois anos e um palpite defensavel, nao um
 * requisito legal verificado - precisa passar por quem responde juridicamente
 * pelo servico.
 */
accessLogSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 });

export type AccessLogDoc = HydratedDocument<InferSchemaType<typeof accessLogSchema>>;
export const AccessLog = model('AccessLog', accessLogSchema);

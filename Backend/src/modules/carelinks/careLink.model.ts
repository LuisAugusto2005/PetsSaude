import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { CARE_RELATIONS } from '../../shared/types.js';

/**
 * A entidade central do backend: quem cuida de quem.
 *
 * Substitui o desenho original de tres colecoes de usuario. Com ela, "o
 * paciente acionar os outros usuarios" quando um alerta dispara e UMA
 * consulta, nao uma varredura por colecao:
 *
 *   CareLink.find({ patientId, status: 'active', 'permissions.receiveAlerts': true })
 *
 * E cobre as duas cardinalidades reais: um medico com trinta pacientes, e um
 * paciente com dois responsaveis mais um medico.
 */
const careLinkSchema = new Schema(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    caregiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    relation: { type: String, enum: CARE_RELATIONS, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    permissions: {
      /** Ver leituras e alertas passados. */
      viewHistory: { type: Boolean, default: true },
      /** Entrar no fan-out quando um alerta dispara. */
      receiveAlerts: { type: Boolean, default: true },
      /** Atribuir e liberar pulseira. */
      manageDevice: { type: Boolean, default: false },
      /** Reconhecer alerta. Enfermagem nasce com true; responsavel, com false. */
      acknowledgeAlerts: { type: Boolean, default: false },
    },
    /**
     * O vinculo de quem cadastrou o paciente. E quem pode adicionar e revogar
     * os demais vinculos, e nao pode ser revogado por outro cuidador.
     */
    isOwner: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revokedAt: { type: Date, default: null },
    /** Quem revogou. Na troca de paciente, e quem rodou a limpeza. */
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
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

// Um cuidador tem no maximo um vinculo ATIVO de cada tipo com cada paciente.
// Parcial: vinculos revogados podem repetir, e o historico fica preservado.
careLinkSchema.index(
  { patientId: 1, caregiverId: 1, relation: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'carelink_unico_ativo',
  },
);
// "Quais pacientes eu acompanho?"
careLinkSchema.index({ caregiverId: 1, status: 1 });
// "Quem avisar sobre este paciente?" - a consulta do fan-out de alerta.
careLinkSchema.index({ patientId: 1, status: 1, 'permissions.receiveAlerts': 1 });

export type CareLinkDoc = HydratedDocument<InferSchemaType<typeof careLinkSchema>>;
export const CareLink = model('CareLink', careLinkSchema);

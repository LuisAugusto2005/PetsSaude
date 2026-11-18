import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * O paciente e um REGISTRO CLINICO, nao um login.
 *
 * Quatro campos, e isso e de proposito. Esta ferramenta e APOIO a enfermagem,
 * nao substituto do prontuario do hospital: nao guardamos data de nascimento,
 * idade, quarto, telefone do paciente nem anotacoes clinicas.
 *
 * Nome, idade, quarto e contato sao configurados no portal cativo da pulseira,
 * ficam na NVS dela e chegam em TODO frame de telemetria. A pulseira e a fonte
 * da verdade desses dados; guardar copia aqui criaria duas versoes que divergem
 * na primeira correcao feita so num lado. Eles vao para Reading na ingestao.
 *
 * O que sobra e o unico dado que a pulseira nao pode fornecer: identidade
 * estavel que atravessa a troca de pulseira. Isso e o nome.
 */
const patientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Nulo na grande maioria dos casos: so quando o paciente tem login. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** false na alta: arquiva sem apagar o historico. */
    isActive: { type: Boolean, default: true },
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

patientSchema.index({ createdBy: 1 });
// Um User nao pode ser paciente duas vezes. Parcial porque userId e quase
// sempre null, e null repetido num indice unico comum travaria tudo.
patientSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } },
);

export type PatientDoc = HydratedDocument<InferSchemaType<typeof patientSchema>>;
export const Patient = model('Patient', patientSchema);

import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Historico de emprestimo da pulseira: qual paciente usou qual aparelho, e
 * durante qual intervalo.
 *
 * E o que permite responder "de quem era esta queda?" meses depois. Sem o
 * intervalo, reatribuir uma pulseira reescreveria o passado.
 */
const deviceAssignmentSchema = new Schema(
  {
    deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    assignedAt: { type: Date, required: true, default: () => new Date() },
    /** Nulo enquanto a pulseira esta com o paciente. */
    releasedAt: { type: Date, default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    releasedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, trim: true, maxlength: 500 },
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

// Uma pulseira esta em, no maximo, um paciente por vez. Garantido pelo banco,
// nao so pela regra no service: uma corrida entre dois pedidos de atribuicao
// nao pode criar dois vinculos abertos.
deviceAssignmentSchema.index(
  { deviceId: 1 },
  {
    unique: true,
    partialFilterExpression: { releasedAt: null },
    name: 'device_um_assignment_aberto',
  },
);
// E um paciente usa, no maximo, uma pulseira por vez.
deviceAssignmentSchema.index(
  { patientId: 1 },
  {
    unique: true,
    partialFilterExpression: { releasedAt: null },
    name: 'paciente_um_assignment_aberto',
  },
);
// Consulta de historico: "quem usava a pulseira X naquela data?"
deviceAssignmentSchema.index({ deviceId: 1, assignedAt: -1 });
deviceAssignmentSchema.index({ patientId: 1, assignedAt: -1 });

export type DeviceAssignmentDoc = HydratedDocument<InferSchemaType<typeof deviceAssignmentSchema>>;
export const DeviceAssignment = model('DeviceAssignment', deviceAssignmentSchema);

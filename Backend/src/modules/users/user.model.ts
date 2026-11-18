import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { USER_ROLES, USER_STATUSES } from '../../shared/types.js';

/**
 * Uma unica colecao de usuarios que fazem login. O papel fica em roles[],
 * nao em colecoes separadas: assim o login e uma consulta so, o e-mail e
 * unico no sistema inteiro, e a mesma pessoa pode ser responsavel de um
 * paciente e enfermagem de outro sem registro duplicado.
 *
 * O paciente NAO esta aqui: ele e um registro clinico (Patient), que pode
 * opcionalmente apontar para um User.
 *
 * Nao ha dado de CRM nem perfil profissional: esta ferramenta e apoio a
 * enfermagem, nao substituto do cadastro de profissionais do hospital. Como
 * nao validamos CRM contra o CFM, guarda-lo seria garantia falsa.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    // select: false para que nenhuma consulta traga o hash por acidente.
    // O login pede explicitamente com .select('+passwordHash').
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /**
     * Normalizado como +5585999990001. E o numero que o app disca quando um
     * alerta dispara, por isso tem formato validado na borda (phoneSchema).
     */
    phone: { type: String, trim: true, maxlength: 20 },
    roles: {
      type: [{ type: String, enum: USER_ROLES }],
      required: true,
      validate: {
        validator: (v: string[]) => v.length > 0 && new Set(v).size === v.length,
        message: 'roles precisa ter ao menos um papel, sem repeticoes',
      },
    },
    /**
     * pending | active | disabled. Ver ROLES_QUE_EXIGEM_APROVACAO: a conta de
     * enfermagem nasce pending, a de responsavel nasce active.
     */
    status: { type: String, enum: USER_STATUSES, default: 'active' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

// "Quem esta esperando aprovacao?" - a fila que o admin abre.
userSchema.index({ status: 1, roles: 1 });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model('User', userSchema);

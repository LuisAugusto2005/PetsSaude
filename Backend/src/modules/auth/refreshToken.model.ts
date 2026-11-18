import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Refresh tokens persistidos para permitir rotacao e revogacao.
 *
 * Guardamos o SHA-256 do token, nunca o token em si: se o banco vazar, os
 * tokens vazados nao servem para nada. Mesma logica da senha.
 *
 * Rotacao: a cada /auth/refresh o token usado e marcado como usado e um novo
 * par e emitido. Se um token ja usado reaparecer, e sinal de roubo e toda a
 * familia de tokens daquele usuario e revogada.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    /** Token que substituiu este, para auditar a cadeia de rotacao. */
    replacedByHash: { type: String, default: null },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);

// O Mongo apaga o documento sozinho depois do vencimento.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = HydratedDocument<InferSchemaType<typeof refreshTokenSchema>>;
export const RefreshToken = model('RefreshToken', refreshTokenSchema);

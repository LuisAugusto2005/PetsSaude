import { z } from '../../shared/zod.js';
import { phoneSchema } from '../../shared/validation.js';
import { SELF_SIGNUP_ROLES } from '../../shared/types.js';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'E-mail invalido');

/**
 * 10 caracteres sem exigir simbolo. Regras barrocas de complexidade levam a
 * senha anotada no papel; comprimento e o que de fato importa.
 */
export const passwordSchema = z
  .string()
  .min(10, 'A senha precisa de ao menos 10 caracteres')
  .max(128, 'A senha pode ter no maximo 128 caracteres');

/**
 * Cadastro: e-mail, senha, nome e papel. Nada mais.
 *
 * Nao pede CRM nem perfil profissional, de proposito. O objetivo e cadastro
 * com o minimo de atraso possivel, e um CRM que ninguem valida contra o CFM
 * seria cerimonia sem garantia.
 *
 * Pedir papel de enfermagem no cadastro nao abre brecha: papel nao da acesso
 * a paciente nenhum neste backend. Uma conta autodeclarada so alcanca dados
 * quando alguem cria o CareLink.
 */
export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(2, 'Informe o nome completo').max(120),
  phone: phoneSchema.optional(),
  // 'admin' fica de fora: admins nascem pelo seed ou sao promovidos.
  roles: z
    .array(z.enum(SELF_SIGNUP_ROLES))
    .min(1, 'Informe ao menos um papel')
    .max(2)
    .refine((v) => new Set(v).size === v.length, 'Papeis repetidos'),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Informe a senha'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Informe o refreshToken'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional(),
  /** true encerra a sessao em todos os dispositivos. */
  allDevices: z.boolean().optional().default(false),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;

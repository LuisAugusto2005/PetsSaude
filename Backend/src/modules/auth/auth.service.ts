import bcrypt from 'bcryptjs';
import { AppError } from '../../shared/AppError.js';
import { ROLES_QUE_EXIGEM_APROVACAO, type UserStatus } from '../../shared/types.js';
import { User, type UserDoc } from '../users/user.model.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { issueTokenPair, type TokenPair } from './token.service.js';

const BCRYPT_ROUNDS = 12;

interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

export interface AuthResult {
  user: UserDoc;
  /** Null quando a conta nasceu 'pending': nao ha sessao a entregar ainda. */
  tokens: TokenPair | null;
}

/**
 * Cadastro: um unico insert.
 *
 * Antes isto precisava de transacao, porque criava User e DoctorProfile
 * atomicamente. Com o CRM fora do escopo, nao ha segundo documento - e o
 * cadastro fica tao rapido quanto da para ser.
 *
 * Quem pede papel de enfermagem nasce 'pending' e NAO recebe token: a conta
 * existe, mas nao ha sessao a entregar antes de um admin aprovar. Responsavel
 * nasce 'active' e entra na hora.
 */
export async function register(input: RegisterInput, meta: SessionMeta): Promise<AuthResult> {
  const existing = await User.exists({ email: input.email });
  if (existing) {
    throw AppError.conflict('Este e-mail ja esta cadastrado');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const precisaAprovacao = input.roles.some((r) => ROLES_QUE_EXIGEM_APROVACAO.includes(r));
  const status: UserStatus = precisaAprovacao ? 'pending' : 'active';

  const user = await User.create({
    email: input.email,
    passwordHash,
    name: input.name,
    phone: input.phone,
    roles: input.roles,
    status,
  });

  if (status !== 'active') return { user, tokens: null };

  const tokens = await issueTokenPair(
    { id: user.id as string, email: user.email, roles: user.roles },
    meta,
  );
  return { user, tokens };
}

export async function login(input: LoginInput, meta: SessionMeta): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');

  // Mesmo erro e mesmo custo de tempo para e-mail inexistente e senha errada:
  // caso contrario a rota vira um verificador de quem tem conta.
  if (!user) {
    await bcrypt.compare(
      input.password,
      '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv',
    );
    throw AppError.unauthorized('E-mail ou senha incorretos');
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    throw AppError.unauthorized('E-mail ou senha incorretos');
  }
  // Depois da senha, de proposito: so quem acertou a senha fica sabendo em que
  // estado a conta esta.
  if (user.status === 'pending') throw AppError.accountPending();
  if (user.status === 'disabled') throw AppError.accountDisabled();

  const tokens = await issueTokenPair(
    { id: user.id as string, email: user.email, roles: user.roles },
    meta,
  );
  return { user, tokens };
}

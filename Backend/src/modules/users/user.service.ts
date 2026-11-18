import type mongoose from 'mongoose';
import { AppError } from '../../shared/AppError.js';
import { paginated } from '../../shared/validation.js';
import type { AuthenticatedUser } from '../../shared/types.js';
import { revokeAllUserTokens } from '../auth/token.service.js';
import { User, type UserDoc } from './user.model.js';
import type { ListUsersQuery, UpdateMeInput } from './user.schemas.js';

/** Escapa a entrada antes de virar regex: senao "(" derruba a busca com 500. */
function regexLiteral(texto: string): RegExp {
  return new RegExp(texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export async function getMe(userId: string): Promise<UserDoc> {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('Usuario nao encontrado');
  return user;
}

export async function updateMe(userId: string, input: UpdateMeInput): Promise<UserDoc> {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('Usuario nao encontrado');

  if (input.name !== undefined) user.name = input.name;
  if (input.phone !== undefined) user.phone = input.phone;
  await user.save();

  return user;
}

/**
 * Lista usuarios. Rota de admin.
 *
 * O caso principal e a fila de aprovacao: GET /api/users?status=pending.
 */
export async function listUsers(query: ListUsersQuery) {
  const filtro: mongoose.FilterQuery<unknown> = {};
  if (query.status) filtro.status = query.status;
  if (query.role) filtro.roles = query.role;
  if (query.q) {
    const busca = regexLiteral(query.q);
    filtro.$or = [{ name: busca }, { email: busca }];
  }

  const skip = (query.page - 1) * query.limit;
  const [users, total] = await Promise.all([
    // Mais antigo primeiro: quem esperou mais aparece no topo da fila.
    User.find(filtro).sort({ createdAt: 1 }).skip(skip).limit(query.limit),
    User.countDocuments(filtro),
  ]);

  return paginated(
    users.map((u) => u.toJSON()),
    total,
    query,
  );
}

/**
 * Libera a conta. Serve para aprovar quem estava 'pending' e para religar quem
 * foi desativado - e o unico caminho de volta, por isso aceita os dois.
 *
 * Idempotente: aprovar quem ja esta ativo responde 200 sem efeito.
 */
export async function approveUser(userId: string): Promise<UserDoc> {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('Usuario nao encontrado');

  user.status = 'active';
  await user.save();
  return user;
}

/**
 * Desativa a conta.
 *
 * Revoga os refresh tokens no mesmo passo, senao a sessao aberta se renovaria
 * indefinidamente. O access token ja emitido continua valido ate expirar (15
 * min): a alternativa seria consultar o banco a cada request, o que troca
 * latencia de todas as chamadas por um corte imediato que raramente importa.
 *
 * Nao apaga o usuario: ele aparece em CareLink.createdBy e em alertas
 * reconhecidos, e apagar a linha destruiria a trilha de auditoria.
 */
export async function disableUser(userId: string, actor: AuthenticatedUser): Promise<UserDoc> {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('Usuario nao encontrado');

  // Sem isto o admin se tranca fora do sistema com um clique.
  if (user.id === actor.id) {
    throw AppError.badRequest('Um admin nao pode desativar a propria conta');
  }

  if (user.roles.includes('admin')) {
    const outrosAdmins = await User.countDocuments({
      _id: { $ne: user._id },
      roles: 'admin',
      status: 'active',
    });
    if (outrosAdmins === 0) {
      throw AppError.badRequest(
        'Este e o unico admin ativo. Promova outro antes de desativa-lo, senao ninguem podera aprovar contas.',
      );
    }
  }

  user.status = 'disabled';
  await user.save();
  await revokeAllUserTokens(user.id as string);
  return user;
}

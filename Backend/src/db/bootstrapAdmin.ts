import { env } from '../config/env.js';
import { logger } from '../shared/logger.js';
import { User } from '../modules/users/user.model.js';

/**
 * Garante que exista um admin, no boot.
 *
 * O problema que isto resolve: a conta de enfermagem nasce 'pending' e so um
 * admin aprova. Em producao com banco vazio nao ha admin nenhum - e o seed nao
 * roda em producao, de proposito. O sistema nasceria travado, sem ninguem para
 * aprovar ninguem.
 *
 * O desenho promove um usuario EXISTENTE em vez de criar um: senha de admin em
 * variavel de ambiente ficaria no painel do Render, nos logs de deploy e no
 * historico do shell de quem configurou.
 *
 * Fluxo de primeiro deploy:
 *   1. subir sem BOOTSTRAP_ADMIN_EMAIL
 *   2. POST /api/auth/register com roles: ['responsavel'] (nasce ativo, entra na hora)
 *   3. definir BOOTSTRAP_ADMIN_EMAIL com esse e-mail - o Render reinicia sozinho
 *   4. no boot, a conta e promovida; depois disso a variavel pode sair
 *
 * Idempotente de duas formas: nao faz nada se ja existe admin ativo, e nao
 * duplica o papel se rodar de novo.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  if (!email) return;

  const jaTemAdmin = await User.exists({ roles: 'admin', status: 'active' });
  if (jaTemAdmin) {
    logger.debug('BOOTSTRAP_ADMIN_EMAIL ignorado: ja existe admin ativo');
    return;
  }

  const user = await User.findOne({ email });
  if (!user) {
    logger.warn(
      { email },
      'BOOTSTRAP_ADMIN_EMAIL aponta para um e-mail sem conta. Cadastre-se primeiro por POST /api/auth/register e reinicie.',
    );
    return;
  }

  user.roles = [...new Set([...user.roles, 'admin' as const])];
  user.status = 'active';
  await user.save();

  // warn e nao info: promocao de admin e evento que alguem deve notar no log.
  logger.warn({ email }, 'Usuario promovido a admin por BOOTSTRAP_ADMIN_EMAIL');
}

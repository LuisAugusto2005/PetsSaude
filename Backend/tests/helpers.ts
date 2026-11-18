import request from 'supertest';
import type { Express } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../src/modules/users/user.model.js';
import type { UserRole } from '../src/shared/types.js';

export const SENHA_PADRAO = 'senha-de-teste-123';

export interface Ator {
  id: string;
  email: string;
  token: string;
  auth: string;
}

/**
 * Cria o usuario direto no banco e faz login pela API. Direto no banco porque
 * /auth/register nao permite criar admin, de proposito.
 */
export async function criarAtor(
  app: Express,
  opts: { email: string; roles: UserRole[]; name?: string; phone?: string },
): Promise<Ator> {
  const passwordHash = await bcrypt.hash(SENHA_PADRAO, 4); // 4 rounds: teste
  const user = await User.create({
    email: opts.email,
    passwordHash,
    name: opts.name ?? opts.email.split('@')[0],
    phone: opts.phone,
    roles: opts.roles,
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: opts.email, password: SENHA_PADRAO });

  if (res.status !== 200) {
    throw new Error(`Login falhou no helper: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    id: String(user._id),
    email: opts.email,
    token: res.body.accessToken as string,
    auth: `Bearer ${res.body.accessToken as string}`,
  };
}

/** Cria um paciente pela API, como o ator informado. */
export async function criarPaciente(
  app: Express,
  ator: Ator,
  dados: Record<string, unknown> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await request(app)
    .post('/api/patients')
    .set('Authorization', ator.auth)
    .send({ name: 'Paciente de Teste', ...dados });

  if (res.status !== 201) {
    throw new Error(`Criacao de paciente falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id as string, body: res.body as Record<string, unknown> };
}

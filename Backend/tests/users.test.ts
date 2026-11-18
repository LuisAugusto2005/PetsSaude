import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ensureBootstrapAdmin } from '../src/db/bootstrapAdmin.js';
import { env } from '../src/config/env.js';
import { RefreshToken } from '../src/modules/auth/refreshToken.model.js';
import { User } from '../src/modules/users/user.model.js';
import { criarAtor, SENHA_PADRAO, type Ator } from './helpers.js';

const app = createApp();

let admin: Ator;
let carla: Ator;

/** Cadastra pela API, para a conta nascer com o status que a regra decide. */
async function cadastrar(email: string, roles: string[]) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: SENHA_PADRAO, name: 'Pessoa de Teste', roles });
  return res;
}

beforeEach(async () => {
  admin = await criarAtor(app, { email: 'admin@exemplo.com', roles: ['admin'], name: 'Admin' });
  carla = await criarAtor(app, {
    email: 'carla@exemplo.com',
    roles: ['enfermagem'],
    name: 'Carla',
  });
});

describe('GET /api/users', () => {
  it('a fila de aprovacao mostra so quem esta pendente', async () => {
    await cadastrar('denise@exemplo.com', ['enfermagem']);
    await cadastrar('ana@exemplo.com', ['responsavel']);

    const res = await request(app)
      .get('/api/users?status=pending')
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(1);
    expect(res.body.itens[0].email).toBe('denise@exemplo.com');
  });

  it('nao devolve o hash da senha de ninguem', async () => {
    const res = await request(app).get('/api/users').set('Authorization', admin.auth);

    expect(JSON.stringify(res.body)).not.toContain('$2');
    for (const item of res.body.itens as Record<string, unknown>[]) {
      expect(item.passwordHash).toBeUndefined();
    }
  });

  it('filtra por papel e busca por nome ou e-mail', async () => {
    await cadastrar('denise@exemplo.com', ['enfermagem']);

    const porPapel = await request(app)
      .get('/api/users?role=enfermagem')
      .set('Authorization', admin.auth);
    expect(porPapel.body.itens).toHaveLength(2); // carla + denise

    const porBusca = await request(app).get('/api/users?q=denise').set('Authorization', admin.auth);
    expect(porBusca.body.itens).toHaveLength(1);
  });

  it('nao quebra com caractere de regex na busca', async () => {
    // Sem escapar a entrada, um "(" vira regex invalida e derruba a rota.
    const res = await request(app).get('/api/users?q=(').set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(0);
  });

  it('nao e rota de enfermagem nem de familiar', async () => {
    const res = await request(app).get('/api/users').set('Authorization', carla.auth);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/users/:id/approve', () => {
  it('a conta aprovada passa a fazer login', async () => {
    await cadastrar('denise@exemplo.com', ['enfermagem']);
    const antes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'denise@exemplo.com', password: SENHA_PADRAO });
    expect(antes.status).toBe(403);

    const denise = await User.findOne({ email: 'denise@exemplo.com' });
    const aprovacao = await request(app)
      .post(`/api/users/${String(denise?._id)}/approve`)
      .set('Authorization', admin.auth);

    expect(aprovacao.status).toBe(200);
    expect(aprovacao.body.status).toBe('active');

    const depois = await request(app)
      .post('/api/auth/login')
      .send({ email: 'denise@exemplo.com', password: SENHA_PADRAO });
    expect(depois.status).toBe(200);
    expect(depois.body.accessToken).toBeTypeOf('string');
  });

  it('religa quem foi desativado: e o unico caminho de volta', async () => {
    await cadastrar('ana@exemplo.com', ['responsavel']);
    const ana = await User.findOne({ email: 'ana@exemplo.com' });
    const id = String(ana?._id);

    await request(app).post(`/api/users/${id}/disable`).set('Authorization', admin.auth);
    const res = await request(app)
      .post(`/api/users/${id}/approve`)
      .set('Authorization', admin.auth);

    expect(res.body.status).toBe('active');
  });

  it('e idempotente', async () => {
    await cadastrar('denise@exemplo.com', ['enfermagem']);
    const denise = await User.findOne({ email: 'denise@exemplo.com' });
    const id = String(denise?._id);

    await request(app).post(`/api/users/${id}/approve`).set('Authorization', admin.auth);
    const res = await request(app)
      .post(`/api/users/${id}/approve`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('enfermagem nao aprova a si mesma nem a colega', async () => {
    await cadastrar('denise@exemplo.com', ['enfermagem']);
    const denise = await User.findOne({ email: 'denise@exemplo.com' });

    const res = await request(app)
      .post(`/api/users/${String(denise?._id)}/approve`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(403);
    expect((await User.findById(denise?._id))?.status).toBe('pending');
  });

  it('responde 404 para id inexistente', async () => {
    const res = await request(app)
      .post('/api/users/507f1f77bcf86cd799439011/approve')
      .set('Authorization', admin.auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/users/:id/disable', () => {
  it('desativa, encerra as sessoes e preserva o registro', async () => {
    const criado = await cadastrar('ana@exemplo.com', ['responsavel']);
    const refreshToken = criado.body.refreshToken as string;
    const ana = await User.findOne({ email: 'ana@exemplo.com' });

    const res = await request(app)
      .post(`/api/users/${String(ana?._id)}/disable`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');

    // O usuario continua existindo: ele aparece em CareLink.createdBy e em
    // alertas reconhecidos, e apagar a linha destruiria a trilha.
    expect(await User.findById(ana?._id)).not.toBeNull();

    // A sessao aberta nao se renova mais.
    const renovacao = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(renovacao.status).toBe(401);
    const tokens = await RefreshToken.find({ userId: ana?._id, revokedAt: null });
    expect(tokens).toHaveLength(0);
  });

  it('o admin nao se desativa: seria se trancar fora do sistema', async () => {
    const res = await request(app)
      .post(`/api/users/${admin.id}/disable`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('propria conta');
  });

  it('nao deixa o sistema sem nenhum admin ativo', async () => {
    const outro = await criarAtor(app, { email: 'admin2@exemplo.com', roles: ['admin'] });

    // Com dois admins ativos, desativar um e legitimo.
    const primeiro = await request(app)
      .post(`/api/users/${admin.id}/disable`)
      .set('Authorization', outro.auth);
    expect(primeiro.status).toBe(200);

    // Agora o cenario real que a guarda existe para cobrir: a conta do admin
    // acabou de ser desativada, mas o access token dele continua valido por
    // ate 15 min - e com ele ele derrubaria o ultimo admin ativo, deixando o
    // sistema sem ninguem para aprovar conta de enfermagem.
    const res = await request(app)
      .post(`/api/users/${outro.id}/disable`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('unico admin ativo');
    expect((await User.findById(outro.id))?.status).toBe('active');
  });

  it('familiar nao desativa ninguem', async () => {
    const ana = await criarAtor(app, { email: 'ana@exemplo.com', roles: ['responsavel'] });
    const res = await request(app)
      .post(`/api/users/${carla.id}/disable`)
      .set('Authorization', ana.auth);

    expect(res.status).toBe(403);
  });
});

describe('ensureBootstrapAdmin', () => {
  afterEach(() => {
    env.BOOTSTRAP_ADMIN_EMAIL = undefined;
  });

  it('promove o e-mail configurado quando nao ha admin ativo', async () => {
    await User.deleteMany({ roles: 'admin' });
    await cadastrar('chefe@exemplo.com', ['responsavel']);

    env.BOOTSTRAP_ADMIN_EMAIL = 'chefe@exemplo.com';
    await ensureBootstrapAdmin();

    const chefe = await User.findOne({ email: 'chefe@exemplo.com' });
    expect(chefe?.roles).toContain('admin');
    expect(chefe?.roles).toContain('responsavel');
    expect(chefe?.status).toBe('active');
  });

  it('nao faz nada quando ja existe admin ativo', async () => {
    await cadastrar('chefe@exemplo.com', ['responsavel']);

    env.BOOTSTRAP_ADMIN_EMAIL = 'chefe@exemplo.com';
    await ensureBootstrapAdmin();

    // Com admin no sistema, a variavel nao promove mais ninguem: deixa-la no
    // ambiente depois do primeiro uso nao e porta aberta.
    const chefe = await User.findOne({ email: 'chefe@exemplo.com' });
    expect(chefe?.roles).not.toContain('admin');
  });

  it('promove uma conta pendente de enfermagem, que e o caso real', async () => {
    await User.deleteMany({ roles: 'admin' });
    await cadastrar('chefia@exemplo.com', ['enfermagem']);

    env.BOOTSTRAP_ADMIN_EMAIL = 'chefia@exemplo.com';
    await ensureBootstrapAdmin();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'chefia@exemplo.com', password: SENHA_PADRAO });
    expect(res.status).toBe(200);
  });

  it('e idempotente: rodar duas vezes nao duplica o papel', async () => {
    await User.deleteMany({ roles: 'admin' });
    await cadastrar('chefe@exemplo.com', ['responsavel']);

    env.BOOTSTRAP_ADMIN_EMAIL = 'chefe@exemplo.com';
    await ensureBootstrapAdmin();
    await ensureBootstrapAdmin();

    const chefe = await User.findOne({ email: 'chefe@exemplo.com' });
    expect(chefe?.roles.filter((r) => r === 'admin')).toHaveLength(1);
  });

  it('nao cria conta quando o e-mail nao existe: nao ha senha no ambiente', async () => {
    await User.deleteMany({ roles: 'admin' });

    env.BOOTSTRAP_ADMIN_EMAIL = 'ninguem@exemplo.com';
    await ensureBootstrapAdmin();

    expect(await User.findOne({ email: 'ninguem@exemplo.com' })).toBeNull();
  });
});

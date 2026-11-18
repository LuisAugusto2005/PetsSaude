import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { User } from '../src/modules/users/user.model.js';

const app = createApp();

const responsavel = {
  email: 'ana@exemplo.com',
  password: 'senha-de-teste-123',
  name: 'Ana Souza',
  roles: ['responsavel'],
};

describe('POST /api/auth/register', () => {
  it('cadastra um responsavel e devolve o par de tokens', async () => {
    const res = await request(app).post('/api/auth/register').send(responsavel);

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.body.usuario.email).toBe('ana@exemplo.com');
  });

  it('nunca devolve o hash da senha', async () => {
    const res = await request(app).post('/api/auth/register').send(responsavel);
    expect(res.body.usuario.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('$2');
  });

  it('guarda a senha com bcrypt, nunca em texto', async () => {
    await request(app).post('/api/auth/register').send(responsavel);
    const user = await User.findOne({ email: responsavel.email }).select('+passwordHash');
    expect(user?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user?.passwordHash).not.toContain(responsavel.password);
  });

  it('responde 409 no e-mail repetido, nao 500', async () => {
    await request(app).post('/api/auth/register').send(responsavel);
    const res = await request(app).post('/api/auth/register').send(responsavel);

    expect(res.status).toBe(409);
    expect(res.body.erro.codigo).toBe('CONFLICT');
  });

  it('recusa senha curta', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, password: '123' });

    expect(res.status).toBe(400);
    expect(res.body.erro.detalhes[0].campo).toBe('password');
  });

  it('cadastra enfermagem sem pedir CRM nem qualquer dado profissional', async () => {
    // A ferramenta e apoio a enfermagem, nao cadastro de profissionais. Como
    // nao validamos CRM contra o CFM, pedi-lo seria cerimonia sem garantia.
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'carla@exemplo.com', roles: ['enfermagem'] });

    expect(res.status).toBe(202);
    expect(res.body.usuario.roles).toEqual(['enfermagem']);
  });

  it('enfermagem nasce pendente e NAO recebe token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'carla@exemplo.com', roles: ['enfermagem'] });

    // 202 e nao 201: a conta existe, mas nao ha sessao a entregar antes de um
    // admin aprovar. O app usa o status HTTP para escolher a tela.
    expect(res.status).toBe(202);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.usuario.status).toBe('pending');
    expect(res.body.mensagem).toContain('aprovar');
  });

  it('responsavel nasce ativo e entra na hora', async () => {
    const res = await request(app).post('/api/auth/register').send(responsavel);

    // Responsavel nao cria nada sozinho: so ve o paciente ao qual alguem o
    // vinculou. Nao ha o que aprovar.
    expect(res.status).toBe(201);
    expect(res.body.usuario.status).toBe('active');
    expect(res.body.accessToken).toBeTypeOf('string');
  });

  it('quem pede os dois papeis cai no mais restritivo', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'dupla@exemplo.com', roles: ['responsavel', 'enfermagem'] });

    expect(res.status).toBe(202);
    expect(res.body.usuario.status).toBe('pending');
  });

  it('recusa o papel medico, que nao existe mais', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'm@exemplo.com', roles: ['medico'] });

    expect(res.status).toBe(400);
  });

  it('normaliza o telefone, que e o numero que o app disca no alerta', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'tel@exemplo.com', phone: '+55 (85) 99999-0001' });

    expect(res.status).toBe(201);
    expect(res.body.usuario.phone).toBe('+5585999990001');
  });

  it('assume +55 quando o telefone vem sem codigo de pais', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'tel55@exemplo.com', phone: '(85) 97777-6666' });

    // So atendemos o Brasil: a enfermagem digita o numero local com pressa e
    // o app ainda consegue discar de qualquer DDD.
    expect(res.status).toBe(201);
    expect(res.body.usuario.phone).toBe('+5585977776666');
  });

  it('nao confunde fixo do DDD 55 com codigo de pais', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'tel44@exemplo.com', phone: '5533334444' });

    // 10 digitos e DDD + numero, nao pais + numero.
    expect(res.body.usuario.phone).toBe('+555533334444');
  });

  it('descarta o zero de operadora', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'tel0@exemplo.com', phone: '085999990001' });

    expect(res.body.usuario.phone).toBe('+5585999990001');
  });

  it('recusa telefone curto demais para discar', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'tel2@exemplo.com', phone: '1234' });

    expect(res.status).toBe(400);
  });

  it('nao permite se cadastrar como admin', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, roles: ['admin'] });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('autentica com a senha correta', async () => {
    await request(app).post('/api/auth/register').send(responsavel);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: responsavel.email, password: responsavel.password });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
  });

  it('da a mesma resposta para senha errada e para e-mail inexistente', async () => {
    await request(app).post('/api/auth/register').send(responsavel);

    const senhaErrada = await request(app)
      .post('/api/auth/login')
      .send({ email: responsavel.email, password: 'senha-errada-mas-longa' });
    const naoExiste = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ninguem@exemplo.com', password: 'senha-errada-mas-longa' });

    expect(senhaErrada.status).toBe(401);
    expect(naoExiste.status).toBe(401);
    // Mesma mensagem: a rota nao pode servir de verificador de quem tem conta.
    expect(senhaErrada.body.erro.mensagem).toBe(naoExiste.body.erro.mensagem);
  });
});

describe('GET /api/users/me', () => {
  it('exige o header Authorization', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('recusa token adulterado', async () => {
    const res = await request(app).get('/api/users/me').set('Authorization', 'Bearer nao.e.um.jwt');
    expect(res.status).toBe(401);
  });

  it('devolve o perfil sem o hash da senha', async () => {
    const registro = await request(app).post('/api/auth/register').send(responsavel);
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${registro.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(responsavel.email);
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('recusa um refresh token usado como access token', async () => {
    const registro = await request(app).post('/api/auth/register').send(responsavel);
    const res = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${registro.body.refreshToken}`);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('troca o refresh por um par novo', async () => {
    const registro = await request(app).post('/api/auth/register').send(responsavel);
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: registro.body.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(registro.body.refreshToken);
  });

  it('revoga tudo quando um refresh token e reutilizado', async () => {
    const registro = await request(app).post('/api/auth/register').send(responsavel);
    const primeiro = registro.body.refreshToken as string;

    const rotacao = await request(app).post('/api/auth/refresh').send({ refreshToken: primeiro });
    expect(rotacao.status).toBe(200);

    // Reapresentar o token antigo e sinal de roubo.
    const reuso = await request(app).post('/api/auth/refresh').send({ refreshToken: primeiro });
    expect(reuso.status).toBe(401);

    // E o token novo, emitido na rotacao, tambem morre.
    const novoDepoisDoReuso = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rotacao.body.refreshToken });
    expect(novoDepoisDoReuso.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('invalida o refresh token informado', async () => {
    const registro = await request(app).post('/api/auth/register').send(responsavel);

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${registro.body.accessToken}`)
      .send({ refreshToken: registro.body.refreshToken });
    expect(logout.status).toBe(204);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: registro.body.refreshToken });
    expect(res.status).toBe(401);
  });
});

describe('GET /health', () => {
  it('responde 200 com o banco conectado', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.banco).toBe('conectado');
  });
});

describe('estado da conta no login', () => {
  async function cadastrarEnfermagem() {
    await request(app)
      .post('/api/auth/register')
      .send({ ...responsavel, email: 'carla@exemplo.com', roles: ['enfermagem'] });
  }

  it('conta pendente recebe 403 ACCOUNT_PENDING, nao "senha incorreta"', async () => {
    await cadastrarEnfermagem();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'carla@exemplo.com', password: responsavel.password });

    // Com um booleano isActive isto virava 401 generico, o app escrevia "senha
    // incorreta" e quem acabou de se cadastrar ligava para o suporte.
    expect(res.status).toBe(403);
    expect(res.body.erro.codigo).toBe('ACCOUNT_PENDING');
  });

  it('conta desativada recebe 403 ACCOUNT_DISABLED', async () => {
    await request(app).post('/api/auth/register').send(responsavel);
    await User.updateOne({ email: responsavel.email }, { $set: { status: 'disabled' } });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: responsavel.email, password: responsavel.password });

    expect(res.status).toBe(403);
    expect(res.body.erro.codigo).toBe('ACCOUNT_DISABLED');
  });

  it('senha errada em conta pendente continua 401, sem revelar o estado', async () => {
    await cadastrarEnfermagem();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'carla@exemplo.com', password: 'senha-errada-mesmo' });

    // A checagem de estado vem DEPOIS da senha: so quem acertou a senha fica
    // sabendo em que estado a conta esta.
    expect(res.status).toBe(401);
    expect(res.body.erro.codigo).toBe('UNAUTHORIZED');
  });

  it('a sessao de quem foi desativado nao se renova', async () => {
    const criado = await request(app).post('/api/auth/register').send(responsavel);
    const refreshToken = criado.body.refreshToken as string;

    await User.updateOne({ email: responsavel.email }, { $set: { status: 'disabled' } });

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});

describe('corpo malformado', () => {
  it('virgula sobrando no JSON da 400, nao 500', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":"a@a.com","password":"senha123456",}');

    // Erro de digitacao do cliente nao e erro interno do servidor. Antes isto
    // respondia 500 com o stack trace - status errado, e caminho de arquivo
    // do servidor na resposta fora de producao.
    expect(res.status).toBe(400);
    expect(res.body.erro.codigo).toBe('JSON_INVALIDO');
    expect(res.body.erro.mensagem).toContain('virgula sobrando');
  });

  it('a resposta de JSON invalido nao vaza stack trace', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{nao sou json}');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('node_modules');
    expect(JSON.stringify(res.body)).not.toContain('SyntaxError');
  });

  it('corpo acima do limite da 413', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@a.com', password: 'x'.repeat(300_000) }));

    expect(res.status).toBe(413);
    expect(res.body.erro.codigo).toBe('PAYLOAD_TOO_LARGE');
  });
});

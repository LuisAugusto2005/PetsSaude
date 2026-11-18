import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CareLink } from '../src/modules/carelinks/careLink.model.js';
import { criarAtor, criarPaciente, type Ator } from './helpers.js';

const app = createApp();

// carla e joana sao enfermagem; ana e um familiar.
let carla: Ator;
let joana: Ator;
let ana: Ator;
let admin: Ator;

beforeEach(async () => {
  carla = await criarAtor(app, {
    email: 'carla@exemplo.com',
    roles: ['enfermagem'],
    name: 'Carla',
  });
  joana = await criarAtor(app, {
    email: 'joana@exemplo.com',
    roles: ['enfermagem'],
    name: 'Joana',
  });
  ana = await criarAtor(app, { email: 'ana@exemplo.com', roles: ['responsavel'], name: 'Ana' });
  admin = await criarAtor(app, { email: 'admin@exemplo.com', roles: ['admin'], name: 'Admin' });
});

describe('POST /api/patients', () => {
  it('cria o paciente e o vinculo dono no mesmo passo', async () => {
    const res = await request(app)
      .post('/api/patients')
      .set('Authorization', carla.auth)
      .send({ name: 'Dona Terezinha' });

    expect(res.status).toBe(201);
    expect(res.body.meuVinculo).toBe('enfermagem');

    // Sem o vinculo dono o paciente seria invisivel para quem o cadastrou.
    const link = await CareLink.findOne({ patientId: res.body.id, caregiverId: carla.id });
    expect(link?.isOwner).toBe(true);
    // Enfermagem nasce com manageDevice: e quem poe a pulseira no paciente.
    expect(link?.permissions?.manageDevice).toBe(true);
  });

  it('guarda apenas o nome: idade, quarto e contato vem da pulseira', async () => {
    const res = await request(app).post('/api/patients').set('Authorization', carla.auth).send({
      name: 'Dona Terezinha',
      // Campos do prontuario, enviados de proposito: devem ser ignorados.
      birthDate: '1941-03-12',
      room: '102',
      contactPhone: '+5585999990001',
      notes: 'Historico de quedas',
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Dona Terezinha');
    for (const campo of ['age', 'birthDate', 'room', 'contactPhone', 'notes']) {
      expect(res.body[campo]).toBeUndefined();
    }
  });

  it('responsavel nao cadastra paciente: isso e ato da equipe de saude', async () => {
    const res = await request(app)
      .post('/api/patients')
      .set('Authorization', ana.auth)
      .send({ name: 'Alguem' });

    expect(res.status).toBe(403);
  });

  it('exige autenticacao', async () => {
    const res = await request(app).post('/api/patients').send({ name: 'Alguem' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/patients', () => {
  it('lista apenas os pacientes com vinculo ativo', async () => {
    await criarPaciente(app, carla, { name: 'Paciente da Carla' });
    await criarPaciente(app, joana, { name: 'Paciente da Joana' });

    const res = await request(app).get('/api/patients').set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(1);
    expect(res.body.itens[0].name).toBe('Paciente da Carla');
    expect(res.body.paginacao.total).toBe(1);
  });

  it('devolve lista vazia para quem nao tem nenhum vinculo', async () => {
    await criarPaciente(app, carla);
    const res = await request(app).get('/api/patients').set('Authorization', ana.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(0);
  });

  it('admin ve todos os pacientes', async () => {
    await criarPaciente(app, carla, { name: 'Paciente A' });
    await criarPaciente(app, joana, { name: 'Paciente B' });

    const res = await request(app).get('/api/patients').set('Authorization', admin.auth);
    expect(res.body.itens).toHaveLength(2);
  });

  it('filtra por nome', async () => {
    await criarPaciente(app, carla, { name: 'Terezinha Alves' });
    await criarPaciente(app, carla, { name: 'Maria Pinto' });

    const res = await request(app).get('/api/patients?q=tereza').set('Authorization', carla.auth);
    expect(res.body.itens).toHaveLength(0);

    const res2 = await request(app).get('/api/patients?q=terez').set('Authorization', carla.auth);
    expect(res2.body.itens).toHaveLength(1);
  });

  it('pagina o resultado', async () => {
    for (let i = 0; i < 5; i++) {
      await criarPaciente(app, carla, { name: `Paciente ${i}` });
    }
    const res = await request(app)
      .get('/api/patients?page=2&limit=2')
      .set('Authorization', carla.auth);

    expect(res.body.itens).toHaveLength(2);
    expect(res.body.paginacao).toMatchObject({
      pagina: 2,
      porPagina: 2,
      total: 5,
      totalPaginas: 3,
    });
  });
});

describe('isolamento entre usuarios', () => {
  it('responde 404 para paciente de outra enfermeira', async () => {
    const paciente = await criarPaciente(app, carla, { name: 'Paciente da Carla' });

    const res = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', joana.auth);

    // 404 e nao 403 de proposito: um 403 confirmaria que aquele id existe, o
    // que permitiria varrer a base de pacientes.
    expect(res.status).toBe(404);
  });

  it('nao permite editar paciente de outra enfermeira', async () => {
    const paciente = await criarPaciente(app, carla);

    const res = await request(app)
      .patch(`/api/patients/${paciente.id}`)
      .set('Authorization', joana.auth)
      .send({ name: 'Nome Trocado' });

    expect(res.status).toBe(404);
  });

  it('ter papel de enfermagem nao da acesso a paciente de outra enfermeira', async () => {
    const terceira = await criarAtor(app, {
      email: 'denise@exemplo.com',
      roles: ['enfermagem'],
    });
    const paciente = await criarPaciente(app, carla, { name: 'Paciente da Carla' });

    // Papel diz o QUE se pode fazer; vinculo diz PARA QUEM.
    const res = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', terceira.auth);

    expect(res.status).toBe(404);
  });

  it('o dono acessa o proprio paciente', async () => {
    const paciente = await criarPaciente(app, carla, { name: 'Dona Terezinha' });

    const res = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Dona Terezinha');
    expect(res.body.meuVinculo).toBe('enfermagem');
    expect(res.body.minhasPermissoes.manageDevice).toBe(true);
  });

  it('admin acessa sem precisar de vinculo', async () => {
    const paciente = await criarPaciente(app, carla);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.meuVinculo).toBeNull();
  });

  it('recusa id malformado antes de consultar o banco', async () => {
    const res = await request(app)
      .get('/api/patients/nao-e-objectid')
      .set('Authorization', ana.auth);
    expect(res.status).toBe(400);
  });

  it('responde 404 para paciente inexistente', async () => {
    const res = await request(app)
      .get('/api/patients/507f1f77bcf86cd799439011')
      .set('Authorization', carla.auth);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/patients/:id', () => {
  it('atualiza os campos informados', async () => {
    const paciente = await criarPaciente(app, carla, { name: 'Nome Antigo' });

    const res = await request(app)
      .patch(`/api/patients/${paciente.id}`)
      .set('Authorization', carla.auth)
      .send({ name: 'Nome Corrigido' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nome Corrigido');
    expect(res.body.isActive).toBe(true);
  });

  it('recusa corpo vazio', async () => {
    const paciente = await criarPaciente(app, carla);
    const res = await request(app)
      .patch(`/api/patients/${paciente.id}`)
      .set('Authorization', carla.auth)
      .send({});
    expect(res.status).toBe(400);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CareLink } from '../src/modules/carelinks/careLink.model.js';
import { criarAtor, criarPaciente, type Ator } from './helpers.js';

const app = createApp();

// carla cadastra o paciente (enfermagem, dona do vinculo); joana e outra
// enfermeira sem vinculo; ana e bruno sao familiares.
let carla: Ator;
let joana: Ator;
let ana: Ator;
let bruno: Ator;
let paciente: { id: string };

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
  ana = await criarAtor(app, {
    email: 'ana@exemplo.com',
    roles: ['responsavel'],
    name: 'Ana',
    phone: '+5585999990001',
  });
  bruno = await criarAtor(app, {
    email: 'bruno@exemplo.com',
    roles: ['responsavel'],
    name: 'Bruno',
  });
  paciente = await criarPaciente(app, carla, { name: 'Dona Terezinha' });
});

/** A enfermagem dona convida a familiar. Atalho do caso mais comum. */
async function convidarFamiliar() {
  return request(app)
    .post(`/api/patients/${paciente.id}/carelinks`)
    .set('Authorization', carla.auth)
    .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });
}

describe('POST /api/patients/:id/carelinks', () => {
  it('a enfermagem dona vincula o familiar pelo e-mail', async () => {
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    expect(res.status).toBe(201);
    expect(res.body.relation).toBe('responsavel');
    expect(res.body.isOwner).toBe(false);
  });

  it('o familiar vinculado passa a ver o paciente', async () => {
    const antes = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', ana.auth);
    expect(antes.status).toBe(404);

    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    const depois = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', ana.auth);
    expect(depois.status).toBe(200);
    expect(depois.body.meuVinculo).toBe('responsavel');
  });

  it('responsavel nao recebe manageDevice; enfermagem recebe', async () => {
    const familiar = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    expect(familiar.body.permissions.manageDevice).toBe(false);
    expect(familiar.body.permissions.receiveAlerts).toBe(true);

    const colega = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'joana@exemplo.com', relation: 'enfermagem' });

    // Quem poe a pulseira no paciente e a enfermagem.
    expect(colega.body.permissions.manageDevice).toBe(true);
  });

  it('recusa vincular como enfermagem quem nao tem o papel', async () => {
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'enfermagem' });

    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('enfermagem');
  });

  it('recusa a relacao medico, que nao existe mais', async () => {
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'medico' });

    expect(res.status).toBe(400);
  });

  it('recusa vinculo duplicado com 409', async () => {
    const corpo = { caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' };
    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send(corpo);

    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send(corpo);

    expect(res.status).toBe(409);
  });

  it('enfermagem sem ser dona nao vincula terceiros', async () => {
    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'joana@exemplo.com', relation: 'enfermagem' });

    // joana tem vinculo ativo, mas nao e dona.
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', joana.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    expect(res.status).toBe(403);
  });

  it('estranho nao consegue vincular ninguem', async () => {
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', joana.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    expect(res.status).toBe(404);
  });

  it('recusa vincular conta que ainda nao foi aprovada', async () => {
    // Cadastro pela API para a conta nascer pendente de verdade.
    await request(app)
      .post('/api/auth/register')
      .send({
        email: 'denise@exemplo.com',
        password: 'senha-de-teste-123',
        name: 'Denise Carvalho',
        roles: ['enfermagem'],
      });

    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'denise@exemplo.com', relation: 'enfermagem' });

    // Vincular quem nao consegue logar criaria um vinculo que parece acesso e
    // nao e - e a enfermeira acharia que avisou alguem.
    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('aprovada');
  });

  it('recusa cuidador inexistente', async () => {
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ninguem@exemplo.com', relation: 'responsavel' });

    expect(res.status).toBe(404);
  });

  it('recusa e-mail e id ao mesmo tempo', async () => {
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', caregiverId: ana.id, relation: 'responsavel' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/patients/:id/carelinks', () => {
  it('lista os cuidadores, com o dono primeiro', async () => {
    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(2);
    expect(res.body.itens[0].isOwner).toBe(true);
    expect(res.body.itens[0].cuidador.email).toBe('carla@exemplo.com');
    expect(res.body.itens[1].cuidador.nome).toBe('Ana');
  });

  it('devolve o telefone do familiar, que e o numero a discar no alerta', async () => {
    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth);

    const itens = res.body.itens as { relation: string; cuidador: { telefone: string } }[];
    const familiar = itens.find((i) => i.relation === 'responsavel');
    expect(familiar?.cuidador.telefone).toBe('+5585999990001');
  });

  it('e a consulta do fan-out de alerta', async () => {
    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    // O que a etapa de notificacao vai usar para saber quem avisar quando a
    // pulseira dispara: uma consulta, nao uma varredura por colecao de usuario.
    const aAvisar = await CareLink.find({
      patientId: paciente.id,
      status: 'active',
      'permissions.receiveAlerts': true,
    });

    expect(aAvisar).toHaveLength(2);
  });
});

describe('DELETE /api/carelinks/:id', () => {
  it('revoga em vez de apagar, preservando a trilha', async () => {
    const criado = await convidarFamiliar();

    const res = await request(app)
      .delete(`/api/carelinks/${criado.body.id}`)
      .set('Authorization', carla.auth);
    expect(res.status).toBe(204);

    // O documento continua existindo: quem teve acesso a dado de saude e
    // justamente o que uma auditoria pede.
    const link = await CareLink.findById(criado.body.id);
    expect(link).not.toBeNull();
    expect(link?.status).toBe('revoked');
    expect(link?.revokedAt).toBeInstanceOf(Date);
  });

  it('o acesso cai imediatamente apos a revogacao', async () => {
    const criado = await convidarFamiliar();

    await request(app).delete(`/api/carelinks/${criado.body.id}`).set('Authorization', carla.auth);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', ana.auth);
    expect(res.status).toBe(404);
  });

  it('nao permite revogar o vinculo dono', async () => {
    const links = await CareLink.find({ patientId: paciente.id, isOwner: true });
    const dono = links[0];

    const res = await request(app)
      .delete(`/api/carelinks/${String(dono?._id)}`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('nao pode ser revogado');
  });

  it('o familiar pode sair do acompanhamento por conta propria', async () => {
    const criado = await convidarFamiliar();

    const res = await request(app)
      .delete(`/api/carelinks/${criado.body.id}`)
      .set('Authorization', ana.auth);

    expect(res.status).toBe(204);
  });

  it('estranho nao consegue revogar vinculo alheio', async () => {
    const criado = await convidarFamiliar();

    const res = await request(app)
      .delete(`/api/carelinks/${criado.body.id}`)
      .set('Authorization', bruno.auth);

    expect(res.status).toBe(404);
  });

  it('permite revincular depois de revogar', async () => {
    const criado = await convidarFamiliar();
    await request(app).delete(`/api/carelinks/${criado.body.id}`).set('Authorization', carla.auth);

    // O indice unico e parcial (so vale para status 'active'), entao o
    // vinculo revogado nao atrapalha a recriacao.
    const res = await convidarFamiliar();

    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/carelinks/:id', () => {
  it('o dono altera as permissoes do vinculo', async () => {
    const criado = await convidarFamiliar();

    const res = await request(app)
      .patch(`/api/carelinks/${criado.body.id}`)
      .set('Authorization', carla.auth)
      .send({ permissions: { manageDevice: true } });

    expect(res.status).toBe(200);
    expect(res.body.permissions.manageDevice).toBe(true);
    expect(res.body.permissions.viewHistory).toBe(true);
  });

  it('ninguem se promove a manageDevice no proprio vinculo', async () => {
    const criado = await convidarFamiliar();

    // Escalada de privilegio: sem isto, qualquer cuidador se daria
    // manageDevice e passaria a reatribuir a pulseira do paciente.
    const res = await request(app)
      .patch(`/api/carelinks/${criado.body.id}`)
      .set('Authorization', ana.auth)
      .send({ permissions: { manageDevice: true } });

    expect(res.status).toBe(403);
  });

  it('mas continua podendo sair do acompanhamento', async () => {
    const criado = await convidarFamiliar();

    const res = await request(app)
      .delete(`/api/carelinks/${criado.body.id}`)
      .set('Authorization', ana.auth);

    expect(res.status).toBe(204);
  });
});

describe('responsavel convida responsavel', () => {
  /** Vincula ana (familiar) ao paciente, como a enfermagem dona. */
  async function vincularAna() {
    const res = await convidarFamiliar();
    if (res.status !== 201) throw new Error(`setup falhou: ${res.status}`);
    return res;
  }

  it('o familiar vinculado convida outro familiar para o mesmo paciente', async () => {
    await vincularAna();

    // A familia se organiza sozinha: quem acompanhou a internacao chama a
    // irma sem depender de a enfermeira que cadastrou estar de plantao.
    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', ana.auth)
      .send({ caregiverEmail: 'bruno@exemplo.com', relation: 'responsavel' });

    expect(res.status).toBe(201);
    expect(res.body.relation).toBe('responsavel');
    expect(res.body.isOwner).toBe(false);

    // A cadeia fica auditavel: foi ana quem trouxe bruno.
    const link = await CareLink.findById(res.body.id);
    expect(String(link?.createdBy)).toBe(ana.id);
  });

  it('o convite de um familiar IGNORA as permissoes pedidas', async () => {
    await vincularAna();

    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', ana.auth)
      .send({
        caregiverEmail: 'bruno@exemplo.com',
        relation: 'responsavel',
        permissions: { viewHistory: true, receiveAlerts: true, manageDevice: true },
      });

    // Escalada indireta: sem isto, ana daria manageDevice a um segundo e-mail
    // dela propria e passaria a operar a pulseira do paciente.
    expect(res.status).toBe(201);
    expect(res.body.permissions.manageDevice).toBe(false);
  });

  it('um familiar nao convida alguem como enfermagem', async () => {
    await vincularAna();

    const res = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', ana.auth)
      .send({ caregiverEmail: 'joana@exemplo.com', relation: 'enfermagem' });

    expect(res.status).toBe(403);
  });

  it('um familiar nao convida para paciente com quem nao tem vinculo', async () => {
    const outro = await criarPaciente(app, carla, { name: 'Outro Paciente' });

    const res = await request(app)
      .post(`/api/patients/${outro.id}/carelinks`)
      .set('Authorization', ana.auth)
      .send({ caregiverEmail: 'bruno@exemplo.com', relation: 'responsavel' });

    // 404 e nao 403: um 403 confirmaria que aquele id de paciente existe.
    expect(res.status).toBe(404);
  });

  it('para no sexto responsavel ativo', async () => {
    await vincularAna();

    // ana e o 1o; mais quatro fecham o teto de 5.
    for (let i = 2; i <= 5; i++) {
      await criarAtor(app, { email: `fam${i}@exemplo.com`, roles: ['responsavel'] });
      const res = await request(app)
        .post(`/api/patients/${paciente.id}/carelinks`)
        .set('Authorization', carla.auth)
        .send({ caregiverEmail: `fam${i}@exemplo.com`, relation: 'responsavel' });
      expect(res.status).toBe(201);
    }

    const sexto = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'bruno@exemplo.com', relation: 'responsavel' });

    // O teto limita o fan-out de alerta, nao quem convida: vale tambem para a
    // enfermagem dona e para o admin.
    expect(sexto.status).toBe(409);
    expect(sexto.body.erro.mensagem).toContain('5 responsaveis');
  });

  it('o teto nao conta vinculos revogados nem a enfermagem', async () => {
    const criado = await vincularAna();
    await request(app).delete(`/api/carelinks/${criado.body.id}`).set('Authorization', carla.auth);

    await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'joana@exemplo.com', relation: 'enfermagem' });

    const ativos = await CareLink.countDocuments({
      patientId: paciente.id,
      relation: 'responsavel',
      status: 'active',
    });
    expect(ativos).toBe(0);
  });

  it('quem convidou sair nao derruba quem foi convidado', async () => {
    const vinculoDaAna = await vincularAna();
    const vinculoDoBruno = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', ana.auth)
      .send({ caregiverEmail: 'bruno@exemplo.com', relation: 'responsavel' });

    await request(app)
      .delete(`/api/carelinks/${vinculoDaAna.body.id}`)
      .set('Authorization', ana.auth);

    // O vinculo de bruno e de bruno, nao emprestado de ana.
    const res = await request(app)
      .get(`/api/patients/${paciente.id}`)
      .set('Authorization', bruno.auth);
    expect(res.status).toBe(200);
    expect((await CareLink.findById(vinculoDoBruno.body.id))?.status).toBe('active');
  });

  it('um familiar nao altera permissao de vinculo alheio', async () => {
    await vincularAna();
    const doBruno = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', ana.auth)
      .send({ caregiverEmail: 'bruno@exemplo.com', relation: 'responsavel' });

    // Convidar nao e ser dono: ana nao manda no vinculo que ela criou.
    const res = await request(app)
      .patch(`/api/carelinks/${doBruno.body.id}`)
      .set('Authorization', ana.auth)
      .send({ permissions: { manageDevice: true } });

    expect(res.status).toBe(403);
  });
});

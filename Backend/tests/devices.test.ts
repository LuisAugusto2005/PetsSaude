import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Device } from '../src/modules/devices/device.model.js';
import { DeviceAssignment } from '../src/modules/devices/deviceAssignment.model.js';
import { CareLink } from '../src/modules/carelinks/careLink.model.js';
import { criarAtor, criarPaciente, type Ator } from './helpers.js';

const app = createApp();

let admin: Ator;
let carla: Ator;
let joana: Ator;
let pacienteA: { id: string };
let pacienteB: { id: string };
let pulseiraId: string;

async function cadastrarPulseira(bandNumber: number): Promise<string> {
  const res = await request(app)
    .post('/api/devices')
    .set('Authorization', admin.auth)
    .send({ bandNumber, deviceId: `vitalwatch-${String(bandNumber).padStart(4, '0')}` });
  if (res.status !== 201) {
    throw new Error(`Cadastro de pulseira falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

beforeEach(async () => {
  admin = await criarAtor(app, { email: 'admin@exemplo.com', roles: ['admin'], name: 'Admin' });
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
  pacienteA = await criarPaciente(app, carla, { name: 'Dona Terezinha' });
  pacienteB = await criarPaciente(app, carla, { name: 'Maria das Gracas' });
  pulseiraId = await cadastrarPulseira(1);
});

describe('POST /api/devices', () => {
  it('apenas admin cadastra pulseira', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', carla.auth)
      .send({ bandNumber: 9 });

    expect(res.status).toBe(403);
  });

  it('recusa numero de banda repetido com 409', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', admin.auth)
      .send({ bandNumber: 1 });

    expect(res.status).toBe(409);
  });

  it('recusa numero fora de 1..9999', async () => {
    // O <N> do firmware vai de 1 a 9999: e ele que gera vitalwatch<N>.local.
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', admin.auth)
      .send({ bandNumber: 10000 });

    expect(res.status).toBe(400);
  });

  it('nasce como available e em modo espnow', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', admin.auth)
      .send({ bandNumber: 42 });

    expect(res.body.status).toBe('available');
    expect(res.body.linkMode).toBe('espnow');
  });
});

describe('POST /api/devices/:id/assign', () => {
  it('atribui a pulseira e marca como assigned', async () => {
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    expect(res.status).toBe(201);
    expect(res.body.releasedAt).toBeNull();

    const device = await Device.findById(pulseiraId);
    expect(device?.status).toBe('assigned');
  });

  it('fecha o periodo anterior ao trocar de paciente, sem sobreposicao', async () => {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteB.id });
    expect(res.status).toBe(201);

    const periodos = await DeviceAssignment.find({ deviceId: pulseiraId }).sort({ assignedAt: 1 });
    expect(periodos).toHaveLength(2);

    // Este e o ponto do modelo: a pulseira e do hospital e passa de paciente
    // para paciente. Sem o fechamento, a queda de um apareceria no historico
    // do proximo.
    expect(periodos[0]?.releasedAt).toBeInstanceOf(Date);
    expect(periodos[1]?.releasedAt).toBeNull();
    expect(periodos[0]?.releasedAt!.getTime()).toBeLessThanOrEqual(
      periodos[1]!.assignedAt.getTime(),
    );
  });

  it('o banco garante no maximo um periodo aberto por pulseira', async () => {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    // Tentativa de criar um segundo periodo aberto por baixo da API: tem de
    // bater no indice unico parcial, nao so na regra do service.
    await expect(
      DeviceAssignment.create({
        deviceId: pulseiraId,
        patientId: pacienteB.id,
        assignedAt: new Date(),
        releasedAt: null,
        assignedBy: carla.id,
      }),
    ).rejects.toThrow();
  });

  it('e idempotente ao reatribuir ao mesmo paciente', async () => {
    const primeiro = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    const segundo = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    expect(segundo.body.id).toBe(primeiro.body.id);
    expect(await DeviceAssignment.countDocuments({ deviceId: pulseiraId })).toBe(1);
  });

  it('libera a pulseira antiga do paciente ao dar-lhe outra', async () => {
    const outra = await cadastrarPulseira(2);

    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });
    await request(app)
      .post(`/api/devices/${outra}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    // O indice unico por paciente barraria dois periodos abertos, e a antiga
    // precisa voltar ao estoque em vez de ficar presa em 'assigned'.
    expect((await Device.findById(pulseiraId))?.status).toBe('available');
    expect((await Device.findById(outra))?.status).toBe('assigned');
    expect(
      await DeviceAssignment.countDocuments({ patientId: pacienteA.id, releasedAt: null }),
    ).toBe(1);
  });

  it('exige a permissao manageDevice no vinculo', async () => {
    const ana = await criarAtor(app, { email: 'ana@exemplo.com', roles: ['responsavel'] });
    await request(app)
      .post(`/api/patients/${pacienteA.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });

    // O familiar ve o paciente e recebe alerta, mas nao opera a pulseira:
    // quem poe a pulseira no paciente e a enfermagem.
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', ana.auth)
      .send({ patientId: pacienteA.id });

    expect(res.status).toBe(403);
    expect(res.body.erro.mensagem).toContain('manageDevice');
  });

  it('estranho nao atribui pulseira a paciente alheio', async () => {
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', joana.auth)
      .send({ patientId: pacienteA.id });

    expect(res.status).toBe(404);
  });

  it('recusa pulseira em manutencao', async () => {
    await request(app)
      .patch(`/api/devices/${pulseiraId}`)
      .set('Authorization', admin.auth)
      .send({ status: 'maintenance' });

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/devices/:id/release', () => {
  it('fecha o periodo e devolve a pulseira ao estoque', async () => {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({ notes: 'Alta hospitalar' });

    expect(res.status).toBe(200);
    expect(res.body.releasedAt).not.toBeNull();
    expect((await Device.findById(pulseiraId))?.status).toBe('available');
  });

  it('responde 409 se nao havia ninguem com a pulseira', async () => {
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', admin.auth)
      .send({});

    expect(res.status).toBe(409);
  });

  it('permite reatribuir depois de liberar', async () => {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });
    await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({});

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteB.id });

    expect(res.status).toBe(201);
  });
});

describe('GET /api/devices', () => {
  it('admin ve o parque inteiro', async () => {
    await cadastrarPulseira(2);
    const res = await request(app).get('/api/devices').set('Authorization', admin.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(2);
  });

  it('a enfermeira ve apenas as pulseiras dos seus pacientes', async () => {
    await cadastrarPulseira(2);
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    const daCarla = await request(app).get('/api/devices').set('Authorization', carla.auth);
    expect(daCarla.body.itens).toHaveLength(1);
    expect(daCarla.body.itens[0].pacienteAtual.nome).toBe('Dona Terezinha');
    expect(daCarla.body.itens[0].pacienteAtual.quarto).toBeUndefined();

    const daJoana = await request(app).get('/api/devices').set('Authorization', joana.auth);
    expect(daJoana.body.itens).toHaveLength(0);
  });
});

describe('GET /api/devices/:id/assignments', () => {
  it('mostra os periodos sem sobreposicao, do mais recente ao mais antigo', async () => {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteB.id });

    const res = await request(app)
      .get(`/api/devices/${pulseiraId}/assignments`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(2);
    expect(res.body.itens[0].emUso).toBe(true);
    expect(res.body.itens[0].paciente.nome).toBe('Maria das Gracas');
    expect(res.body.itens[1].emUso).toBe(false);
    expect(res.body.itens[1].paciente.nome).toBe('Dona Terezinha');
  });

  it('nega o historico a quem nunca teve vinculo com a pulseira', async () => {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    const res = await request(app)
      .get(`/api/devices/${pulseiraId}/assignments`)
      .set('Authorization', joana.auth);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/devices/:id/revoke-responsaveis', () => {
  /** Poe a pulseira na pacienteA e vincula dois familiares a ela. */
  async function internar() {
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteA.id });

    for (const email of ['ana@exemplo.com', 'bruno@exemplo.com']) {
      await criarAtor(app, { email, roles: ['responsavel'] });
      const res = await request(app)
        .post(`/api/patients/${pacienteA.id}/carelinks`)
        .set('Authorization', carla.auth)
        .send({ caregiverEmail: email, relation: 'responsavel' });
      if (res.status !== 201) throw new Error(`setup falhou: ${res.status}`);
    }
    // joana entra como colega de enfermagem, para provar que nao e tocada.
    await request(app)
      .post(`/api/patients/${pacienteA.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: 'joana@exemplo.com', relation: 'enfermagem' });
  }

  const ativos = (relation: string) =>
    CareLink.countDocuments({ patientId: pacienteA.id, relation, status: 'active' });

  it('revoga os responsaveis e preserva a enfermagem', async () => {
    await internar();
    expect(await ativos('responsavel')).toBe(2);

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.responsaveisRevogados).toBe(2);
    expect(await ativos('responsavel')).toBe(0);
    // A equipe mantem o historico do que cuidou.
    expect(await ativos('enfermagem')).toBe(2);
  });

  it('revoga em vez de apagar, e registra quem limpou', async () => {
    await internar();
    await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', carla.auth);

    const links = await CareLink.find({ patientId: pacienteA.id, relation: 'responsavel' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.status).toBe('revoked');
      expect(link.revokedAt).toBeInstanceOf(Date);
      expect(String(link.revokedBy)).toBe(carla.id);
    }
  });

  it('nao toca em patient.isActive: dar alta e outra decisao', async () => {
    await internar();
    await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', carla.auth);

    const res = await request(app)
      .get(`/api/patients/${pacienteA.id}`)
      .set('Authorization', carla.auth);
    expect(res.body.isActive).toBe(true);
  });

  it('funciona depois de a pulseira ja ter sido liberada', async () => {
    await internar();
    await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({});

    // Usa o ULTIMO periodo, nao so o aberto: na pratica o enfermeiro tira a
    // pulseira primeiro e lembra da limpeza depois.
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.responsaveisRevogados).toBe(2);
  });

  it('nao afeta os responsaveis do paciente seguinte', async () => {
    await internar();
    await request(app)
      .post(`/api/devices/${pulseiraId}/assign`)
      .set('Authorization', carla.auth)
      .send({ patientId: pacienteB.id });

    // Agora a pulseira e da pacienteB; a limpeza resolve o ULTIMO periodo.
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', carla.auth);

    expect(res.body.responsaveisRevogados).toBe(0);
    expect(await ativos('responsavel')).toBe(2);
  });

  it('responde 409 para pulseira que nunca foi atribuida', async () => {
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', admin.auth);

    expect(res.status).toBe(409);
  });

  it('familiar nao limpa os outros familiares', async () => {
    await internar();
    const ana = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ana@exemplo.com', password: 'senha-de-teste-123' });

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', `Bearer ${ana.body.accessToken as string}`);

    // Papel diz O QUE: limpar responsaveis e ato da equipe de saude. Sem isto,
    // um familiar derrubaria o acesso dos demais.
    expect(res.status).toBe(403);
    expect(await ativos('responsavel')).toBe(2);
  });

  it('enfermeira sem vinculo com o paciente recebe 404', async () => {
    await internar();
    const denise = await criarAtor(app, { email: 'denise@exemplo.com', roles: ['enfermagem'] });

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/revoke-responsaveis`)
      .set('Authorization', denise.auth);

    // Papel diz O QUE; vinculo diz PARA QUEM. Os dois sao exigidos.
    expect(res.status).toBe(404);
    expect(await ativos('responsavel')).toBe(2);
  });

  it('familiar com manageDevice nao usa a flag no release', async () => {
    await internar();
    const anaLink = await CareLink.findOne({
      patientId: pacienteA.id,
      relation: 'responsavel',
    }).sort({ createdAt: 1 });
    // A dona concede manageDevice a ana: legitimo, ela passa a operar a pulseira.
    await request(app)
      .patch(`/api/carelinks/${String(anaLink?._id)}`)
      .set('Authorization', carla.auth)
      .send({ permissions: { manageDevice: true } });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ana@exemplo.com', password: 'senha-de-teste-123' });
    const auth = `Bearer ${login.body.accessToken as string}`;

    // Liberar a pulseira: pode. Limpar os outros familiares junto: nao.
    const comFlag = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', auth)
      .send({ revokeResponsaveis: true });
    expect(comFlag.status).toBe(403);

    // E o 403 veio ANTES de liberar: nada foi feito pela metade.
    expect((await Device.findById(pulseiraId))?.status).toBe('assigned');
    expect(await ativos('responsavel')).toBe(2);

    const semFlag = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', auth)
      .send({});
    expect(semFlag.status).toBe(200);
  });

  it('a flag no release faz alta e limpeza numa chamada', async () => {
    await internar();

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({ notes: 'Alta hospitalar', revokeResponsaveis: true });

    expect(res.status).toBe(200);
    expect(res.body.releasedAt).not.toBeNull();
    expect(res.body.responsaveisRevogados).toBe(2);
    expect(await ativos('responsavel')).toBe(0);
    expect((await Device.findById(pulseiraId))?.status).toBe('available');
  });

  it('release sem a flag nao mexe em vinculo nenhum', async () => {
    await internar();

    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({});

    expect(res.body.responsaveisRevogados).toBeNull();
    expect(await ativos('responsavel')).toBe(2);
  });
});

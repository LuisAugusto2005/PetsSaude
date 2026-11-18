import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { AccessLog } from '../src/modules/audit/accessLog.model.js';
import { CareLink } from '../src/modules/carelinks/careLink.model.js';
import { Alert } from '../src/modules/telemetry/alert.model.js';
import { Reading } from '../src/modules/telemetry/reading.model.js';
import { criarAtor, criarPaciente, type Ator } from './helpers.js';

const app = createApp();

let admin: Ator;
let carla: Ator;
let joana: Ator;
let ana: Ator;
let joana2: Ator;
let paciente: { id: string };
let pulseiraId: string;

const BOOT = new Date('2026-03-01T08:00:00.000Z');

/** Gera leituras de minuto em minuto a partir de uma hora conhecida. */
async function gerarLeituras(quantas: number, inicio = new Date('2026-03-01T09:00:00.000Z')) {
  const docs = [];
  for (let i = 0; i < quantas; i++) {
    docs.push({
      deviceId: new Types.ObjectId(pulseiraId),
      patientId: new Types.ObjectId(paciente.id),
      bootAt: BOOT,
      receivedAt: new Date(inicio.getTime() + i * 60_000),
      uptimeMs: 3_600_000 + i * 60_000,
      posture: { id: 'lying', inclination: 12.5, stable: true },
      movement: { class: 'rest', energy: 0.1, tremor: false, odd: false },
      fall: { detected: false, count: 0 },
      panic: { active: false, count: 0 },
      batteryPct: 80 - i,
      rssi: -62,
      source: 'seed' as const,
    });
  }
  await Reading.insertMany(docs);
}

async function gerarAlerta(alertKey: 'fall' | 'tremor', sinceUptimeMs = 3_700_000) {
  return Alert.create({
    deviceId: new Types.ObjectId(pulseiraId),
    patientId: new Types.ObjectId(paciente.id),
    bootAt: BOOT,
    alertKey,
    level: alertKey === 'fall' ? 'critical' : 'warn',
    detail: 'Queda detectada, com virgula, para testar o CSV',
    sinceUptimeMs,
    firstSeenAt: new Date('2026-03-01T09:30:00.000Z'),
    lastSeenAt: new Date('2026-03-01T09:31:00.000Z'),
    status: 'active',
    isLatched: alertKey === 'fall',
  });
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
  ana = await criarAtor(app, { email: 'ana@exemplo.com', roles: ['responsavel'], name: 'Ana' });
  joana2 = await criarAtor(app, {
    email: 'joana2@exemplo.com',
    roles: ['enfermagem'],
    name: 'Joana Dois',
  });

  paciente = await criarPaciente(app, carla, { name: 'Dona Terezinha' });

  const device = await request(app)
    .post('/api/devices')
    .set('Authorization', admin.auth)
    .send({ bandNumber: 1 });
  pulseiraId = device.body.id as string;

  await request(app)
    .post(`/api/devices/${pulseiraId}/assign`)
    .set('Authorization', carla.auth)
    .send({ patientId: paciente.id });

  await request(app)
    .post(`/api/patients/${paciente.id}/carelinks`)
    .set('Authorization', carla.auth)
    .send({ caregiverEmail: 'ana@exemplo.com', relation: 'responsavel' });
  await request(app)
    .post(`/api/patients/${paciente.id}/carelinks`)
    .set('Authorization', carla.auth)
    .send({ caregiverEmail: 'joana2@exemplo.com', relation: 'enfermagem' });
});

describe('GET /api/patients/:id/readings', () => {
  it('devolve o historico do mais recente para o mais antigo', async () => {
    await gerarLeituras(5);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/readings`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(5);
    expect(res.body.paginacao.total).toBe(5);
    const datas = (res.body.itens as { receivedAt: string }[]).map((i) => i.receivedAt);
    expect([...datas].sort().reverse()).toEqual(datas);
  });

  it('filtra por intervalo de hora de servidor', async () => {
    await gerarLeituras(10);

    const res = await request(app)
      .get(
        `/api/patients/${paciente.id}/readings?from=2026-03-01T09:00:00Z&to=2026-03-01T09:04:00Z`,
      )
      .set('Authorization', carla.auth);

    // 09:00 a 09:04 inclusive: cinco amostras de minuto em minuto.
    expect(res.body.itens).toHaveLength(5);
  });

  it('nao devolve leitura de paciente alheio', async () => {
    await gerarLeituras(3);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/readings`)
      .set('Authorization', joana.auth);

    expect(res.status).toBe(404);
  });

  it('exige a permissao viewHistory no vinculo', async () => {
    const link = await CareLink.findOne({ patientId: paciente.id, caregiverId: ana.id });
    await request(app)
      .patch(`/api/carelinks/${String(link?._id)}`)
      .set('Authorization', carla.auth)
      .send({ permissions: { viewHistory: false } });

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/readings`)
      .set('Authorization', ana.auth);

    expect(res.status).toBe(403);
    expect(res.body.erro.mensagem).toContain('viewHistory');
  });
});

describe('GET /api/patients/:id/alerts', () => {
  it('lista e filtra por status', async () => {
    await gerarAlerta('fall');
    await gerarAlerta('tremor', 3_800_000);

    const todos = await request(app)
      .get(`/api/patients/${paciente.id}/alerts`)
      .set('Authorization', carla.auth);
    expect(todos.body.itens).toHaveLength(2);

    const porChave = await request(app)
      .get(`/api/patients/${paciente.id}/alerts?alertKey=fall`)
      .set('Authorization', carla.auth);
    expect(porChave.body.itens).toHaveLength(1);
    expect(porChave.body.itens[0].isLatched).toBe(true);
  });
});

describe('POST /api/alerts/:id/acknowledge', () => {
  it('a enfermagem reconhece, e o alerta sai da lista de ativos', async () => {
    const alerta = await gerarAlerta('fall');

    const res = await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('acknowledged');
    expect(res.body.acknowledgedBy).toBe(carla.id);
    expect(res.body.acknowledgedVia).toBe('app');

    // Sem isto a lista de ativos nunca encolhe e a tela fica inutil.
    const ativos = await request(app)
      .get(`/api/patients/${paciente.id}/alerts?status=active`)
      .set('Authorization', carla.auth);
    expect(ativos.body.itens).toHaveLength(0);
  });

  it('o familiar NAO reconhece por padrao', async () => {
    const alerta = await gerarAlerta('fall');

    const res = await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', ana.auth);

    // Se um familiar apaga o alerta de queda, a enfermagem deixa de ve-lo sem
    // ninguem ter ido ate a paciente.
    expect(res.status).toBe(403);
    expect(res.body.erro.mensagem).toContain('acknowledgeAlerts');
    expect((await Alert.findById(alerta._id))?.status).toBe('active');
  });

  it('mas o vinculo dono pode liberar isso para ele', async () => {
    const alerta = await gerarAlerta('fall');
    const link = await CareLink.findOne({ patientId: paciente.id, caregiverId: ana.id });

    await request(app)
      .patch(`/api/carelinks/${String(link?._id)}`)
      .set('Authorization', carla.auth)
      .send({ permissions: { acknowledgeAlerts: true } });

    const res = await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', ana.auth);

    expect(res.status).toBe(200);
    expect(res.body.acknowledgedBy).toBe(ana.id);
  });

  it('ninguem se concede acknowledgeAlerts no proprio vinculo', async () => {
    const link = await CareLink.findOne({ patientId: paciente.id, caregiverId: ana.id });

    const res = await request(app)
      .patch(`/api/carelinks/${String(link?._id)}`)
      .set('Authorization', ana.auth)
      .send({ permissions: { acknowledgeAlerts: true } });

    expect(res.status).toBe(403);
  });

  it('e idempotente: nao reescreve quem atendeu primeiro', async () => {
    const alerta = await gerarAlerta('fall');
    const primeiro = await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', carla.auth);

    const segundo = await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', joana2.auth);

    // joana2 tambem tem vinculo, mas quem atendeu foi a carla: o segundo ack
    // nao pode roubar a assinatura do primeiro.
    expect(segundo.status).toBe(200);
    expect(segundo.body.acknowledgedBy).toBe(carla.id);
    expect(segundo.body.acknowledgedAt).toBe(primeiro.body.acknowledgedAt);
  });

  it('estranho nao reconhece alerta alheio', async () => {
    const alerta = await gerarAlerta('fall');

    const res = await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', joana.auth);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/patients/:id/export', () => {
  it('CSV sai com cabecalho, BOM e uma linha por leitura', async () => {
    await gerarLeituras(3);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/export?format=csv&type=readings`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('dona-terezinha');

    const texto = res.text;
    expect(texto.charCodeAt(0)).toBe(0xfeff); // BOM, para o Excel no Windows
    const linhas = texto.replace('﻿', '').trim().split('\n');
    expect(linhas[0]).toContain('receivedAt,banda,bootAt');
    expect(linhas).toHaveLength(4); // cabecalho + 3

    // A banda e essencial: sem ela a linha nao diz de qual pulseira veio, e o
    // mesmo paciente pode ter usado duas no intervalo.
    expect(linhas[1]).toContain(',1,');
  });

  it('CSV cita o campo que tem virgula, sem quebrar a tabela', async () => {
    const res = await request(app)
      .get(`/api/patients/${paciente.id}/export?format=csv&type=alerts`)
      .set('Authorization', carla.auth);
    expect(res.status).toBe(200);

    await gerarAlerta('fall');
    const comAlerta = await request(app)
      .get(`/api/patients/${paciente.id}/export?format=csv&type=alerts`)
      .set('Authorization', carla.auth);

    const linhas = comAlerta.text.replace('﻿', '').trim().split('\n');
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toContain('"Queda detectada, com virgula, para testar o CSV"');
  });

  it('JSON traz meta, periodos de uso, alertas e leituras', async () => {
    await gerarLeituras(2);
    await gerarAlerta('fall');

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/export?format=json&type=all`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    const corpo = JSON.parse(res.text) as {
      meta: { paciente: { nome: string }; periodosDeUso: { banda: number }[] };
      alertas: unknown[];
      leituras: unknown[];
      totalDeLeituras: number;
    };

    // O meta e o que da sentido as linhas: sem o periodo de uso, uma leitura
    // crua nao diz de quem era a pulseira.
    expect(corpo.meta.paciente.nome).toBe('Dona Terezinha');
    expect(corpo.meta.periodosDeUso[0]?.banda).toBe(1);
    expect(corpo.alertas).toHaveLength(1);
    expect(corpo.leituras).toHaveLength(2);
    expect(corpo.totalDeLeituras).toBe(2);
  });

  it('JSON continua valido quando nao ha leitura nenhuma', async () => {
    const res = await request(app)
      .get(`/api/patients/${paciente.id}/export?format=json`)
      .set('Authorization', carla.auth);

    // Array vazio montado a mao e o lugar classico de sobrar uma virgula.
    expect(() => {
      JSON.parse(res.text);
    }).not.toThrow();
    expect((JSON.parse(res.text) as { totalDeLeituras: number }).totalDeLeituras).toBe(0);
  });

  it('respeita o intervalo pedido', async () => {
    await gerarLeituras(10);

    const res = await request(app)
      .get(
        `/api/patients/${paciente.id}/export?format=json&type=readings&from=2026-03-01T09:00:00Z&to=2026-03-01T09:02:00Z`,
      )
      .set('Authorization', carla.auth);

    expect((JSON.parse(res.text) as { totalDeLeituras: number }).totalDeLeituras).toBe(3);
  });

  it('erro de autorizacao vem como JSON, nao como CSV truncado', async () => {
    const res = await request(app)
      .get(`/api/patients/${paciente.id}/export?format=csv`)
      .set('Authorization', joana.auth);

    // Tudo que pode falhar falha ANTES do primeiro write: depois do cabecalho
    // enviado nao ha como devolver erro.
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('trilha de acesso', () => {
  it('registra quem abriu o historico, com intervalo e volume', async () => {
    await gerarLeituras(4);

    await request(app)
      .get(`/api/patients/${paciente.id}/readings?from=2026-03-01T09:00:00Z`)
      .set('Authorization', ana.auth);

    const linhas = await AccessLog.find({ patientId: paciente.id });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.action).toBe('read_readings');
    expect(String(linhas[0]?.userId)).toBe(ana.id);
    expect(linhas[0]?.resultCount).toBe(4);
    expect(linhas[0]?.detail).toContain('2026-03-01T09:00:00');
  });

  it('registra o export com formato e quantas linhas sairam', async () => {
    await gerarLeituras(3);

    await request(app)
      .get(`/api/patients/${paciente.id}/export?format=csv&type=readings`)
      .set('Authorization', carla.auth);

    const linha = await AccessLog.findOne({ action: 'export_patient' });
    expect(linha?.resultCount).toBe(3);
    expect(linha?.detail).toContain('csv');
  });

  it('NAO registra abrir o cadastro do paciente', async () => {
    await request(app).get(`/api/patients/${paciente.id}`).set('Authorization', carla.auth);
    await request(app).get('/api/patients').set('Authorization', carla.auth);

    // E a tela que mais recarrega, e so tem o nome. Registrar afogaria a
    // trilha em ruido e o acesso que importa ficaria impossivel de achar.
    expect(await AccessLog.countDocuments({})).toBe(0);
  });

  it('a enfermeira dona ve quem andou olhando os dados', async () => {
    await gerarLeituras(2);
    await request(app).get(`/api/patients/${paciente.id}/readings`).set('Authorization', ana.auth);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/access-log`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens[0].quem.nome).toBe('Ana');
    expect(res.body.itens[0].action).toBe('read_readings');
  });

  it('quem audita tambem entra na trilha', async () => {
    await request(app)
      .get(`/api/patients/${paciente.id}/access-log`)
      .set('Authorization', carla.auth);

    expect(await AccessLog.countDocuments({ action: 'read_access_log' })).toBe(1);
  });

  it('a trilha nao e visivel para cuidador que nao e dono', async () => {
    const res = await request(app)
      .get(`/api/patients/${paciente.id}/access-log`)
      .set('Authorization', ana.auth);

    // Onde cada cuidador andou nao e informacao para os outros cuidadores.
    expect(res.status).toBe(403);
  });
});

describe('GET /api/patients/:id/history', () => {
  it('monta a linha do tempo do que foi feito, do mais recente ao mais antigo', async () => {
    const alerta = await gerarAlerta('fall');
    await request(app)
      .post(`/api/alerts/${String(alerta._id)}/acknowledge`)
      .set('Authorization', carla.auth);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/history`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    const tipos = (res.body.itens as { tipo: string }[]).map((i) => i.tipo);

    // Tudo isto sai de campos que cada acao ja gravava: nao existe colecao de
    // eventos paralela.
    expect(tipos).toContain('paciente_cadastrado');
    expect(tipos).toContain('cuidador_vinculado');
    expect(tipos).toContain('pulseira_atribuida');
    expect(tipos).toContain('alerta_reconhecido');

    const datas = (res.body.itens as { at: string }[]).map((i) => i.at);
    expect([...datas].sort().reverse()).toEqual(datas);
  });

  it('diz quem fez cada coisa', async () => {
    const res = await request(app)
      .get(`/api/patients/${paciente.id}/history`)
      .set('Authorization', carla.auth);

    const atribuicao = (res.body.itens as { tipo: string; por: { nome: string } | null }[]).find(
      (i) => i.tipo === 'pulseira_atribuida',
    );
    expect(atribuicao?.por?.nome).toBe('Carla');
  });

  it('registra a revogacao de vinculo', async () => {
    const link = await CareLink.findOne({ patientId: paciente.id, caregiverId: ana.id });
    await request(app)
      .delete(`/api/carelinks/${String(link?._id)}`)
      .set('Authorization', carla.auth);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/history`)
      .set('Authorization', carla.auth);

    const revogacao = (res.body.itens as { tipo: string; por: { nome: string } | null }[]).find(
      (i) => i.tipo === 'cuidador_revogado',
    );
    expect(revogacao?.por?.nome).toBe('Carla');
  });
});

describe('GET /api/users/me/export', () => {
  it('devolve os proprios dados, sem hash de senha', async () => {
    const res = await request(app).get('/api/users/me/export').set('Authorization', ana.auth);

    expect(res.status).toBe(200);
    expect(res.body.usuario.email).toBe('ana@exemplo.com');
    expect(res.body.vinculos[0].paciente).toBe('Dona Terezinha');
    expect(JSON.stringify(res.body)).not.toContain('$2');
    expect(res.body.usuario.passwordHash).toBeUndefined();
    expect(res.body.aviso).toContain('hash bcrypt');
  });

  it('inclui a propria trilha de acesso', async () => {
    await gerarLeituras(1);
    await request(app).get(`/api/patients/${paciente.id}/readings`).set('Authorization', ana.auth);

    const res = await request(app).get('/api/users/me/export').set('Authorization', ana.auth);

    expect(res.body.meusAcessos.length).toBeGreaterThanOrEqual(1);
    expect(res.body.meusAcessos[0].action).toBe('read_readings');
  });

  it('nao traz telemetria: os dados da pulseira sao do paciente', async () => {
    await gerarLeituras(5);
    const res = await request(app).get('/api/users/me/export').set('Authorization', ana.auth);

    expect(res.body.leituras).toBeUndefined();
    expect(res.body.aviso).toContain('telemetria');
  });

  it('exige autenticacao', async () => {
    const res = await request(app).get('/api/users/me/export');
    expect(res.status).toBe(401);
  });
});

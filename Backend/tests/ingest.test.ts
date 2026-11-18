import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Device } from '../src/modules/devices/device.model.js';
import { Alert } from '../src/modules/telemetry/alert.model.js';
import { Reading } from '../src/modules/telemetry/reading.model.js';
import { criarAtor, criarPaciente, type Ator } from './helpers.js';

const app = createApp();

/**
 * device_id do firmware e o NUMERO da banda, nao uma string: secao 6 do
 * VitalWatch_Comunicacao traz `"device_id":12`, e o app Kotlin le com optInt.
 */
const BANDA = 1;
const DEVICE_ID_TEXTO = 'vitalwatch-0001';

let admin: Ator;
let carla: Ator;
let joana: Ator;
let familiar: Ator;
let paciente: { id: string };
let pulseiraId: string;
let tokenDoAparelho: string;

/**
 * Um frame do firmware, com o minimo obrigatorio e tudo mais sobrescritivel.
 * Espelha o JSON da secao 6 do VitalWatch_Comunicacao.
 */
function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device: 'VitalWatch Band',
    device_id: BANDA,
    device_name: `VitalWatch${String(BANDA)}`,
    firmware: '0.3.0',
    mode: 'normal',
    timestamp_ms: 60_000,
    uptime_s: 60,
    posture: { id: 'lying', label: 'deitado', inclination: 85, stable: true },
    movement: { class: 'rest', label: 'parado', energy: 0.012, tremor: false, odd: false },
    // phase e numero: 0 nenhuma, 3 confirmada.
    fall: { detected: false, simulated: false, phase: 0, count: 0 },
    panic: { active: false, count: 0 },
    battery: { percent: 88 },
    network: { link: 'wifi', mode: 'STA', ip: '192.168.0.13' },
    gateway: { name: 'vitalwatchgateway', channel: 10, rssi: -58, lost: 3, age_ms: 420 },
    ...over,
  };
}

type Corpo = Record<string, unknown> | Record<string, unknown>[];

function enviar(body: Corpo, auth: string) {
  return request(app).post('/api/ingest/telemetry').set('Authorization', auth).send(body);
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
  familiar = await criarAtor(app, {
    email: 'familiar@exemplo.com',
    roles: ['responsavel'],
    name: 'Filho da Terezinha',
  });

  paciente = await criarPaciente(app, carla, { name: 'Dona Terezinha' });

  const criada = await request(app)
    .post('/api/devices')
    .set('Authorization', admin.auth)
    .send({ bandNumber: BANDA, deviceId: DEVICE_ID_TEXTO });
  pulseiraId = criada.body.id as string;

  await request(app)
    .post(`/api/devices/${pulseiraId}/assign`)
    .set('Authorization', carla.auth)
    .send({ patientId: paciente.id });

  const token = await request(app)
    .post(`/api/devices/${pulseiraId}/ingest-token`)
    .set('Authorization', admin.auth)
    .send();
  tokenDoAparelho = `Bearer ${token.body.ingestToken as string}`;
});

describe('token de ingestao', () => {
  it('apenas admin emite', async () => {
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/ingest-token`)
      .set('Authorization', carla.auth)
      .send();

    expect(res.status).toBe(403);
  });

  it('devolve o segredo uma vez e guarda apenas o hash', async () => {
    const res = await request(app)
      .post(`/api/devices/${pulseiraId}/ingest-token`)
      .set('Authorization', admin.auth)
      .send();

    expect(res.status).toBe(201);
    const emitido = res.body.ingestToken as string;
    expect(emitido.startsWith('vwd_')).toBe(true);

    // O token em claro nao esta em lugar nenhum do banco.
    const guardado = await Device.findById(pulseiraId).select('+ingestTokenHash');
    expect(guardado?.ingestTokenHash).not.toBe(emitido);
    expect(guardado?.ingestTokenHash).toHaveLength(64);

    // E nao sai em GET: o campo e select:false.
    const lido = await request(app)
      .get(`/api/devices/${pulseiraId}`)
      .set('Authorization', admin.auth);
    expect(lido.body.ingestTokenHash).toBeUndefined();
  });

  it('emitir de novo invalida o anterior', async () => {
    const antigo = tokenDoAparelho;
    await request(app)
      .post(`/api/devices/${pulseiraId}/ingest-token`)
      .set('Authorization', admin.auth)
      .send();

    expect((await enviar(frame(), antigo)).status).toBe(401);
  });

  it('revogar derruba o envio', async () => {
    await request(app)
      .delete(`/api/devices/${pulseiraId}/ingest-token`)
      .set('Authorization', admin.auth)
      .send();

    const res = await enviar(frame(), tokenDoAparelho);
    expect(res.status).toBe(401);
    expect(res.body.erro.codigo).toBe('UNAUTHORIZED');
  });

  it('token inexistente nao vaza se o aparelho existe', async () => {
    const res = await enviar(frame(), 'Bearer vwd_naoexiste');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/ingest/telemetry pela pulseira', () => {
  it('grava a leitura com source direct e o paciente da atribuicao', async () => {
    const res = await enviar(frame(), tokenDoAparelho);

    expect(res.status).toBe(202);
    expect(res.body.gravadas).toBe(1);
    expect(res.body.duplicadas).toBe(0);
    expect(res.body.source).toBe('direct');
    expect(res.body.patientId).toBe(paciente.id);

    const leitura = await Reading.findOne({});
    expect(leitura?.source).toBe('direct');
    expect(String(leitura?.patientId)).toBe(paciente.id);
    expect(leitura?.posture?.id).toBe('lying');
    expect(leitura?.batteryPct).toBe(88);
    // Entregue pela propria pulseira: nao ha usuario a quem atribuir.
    expect(leitura?.deliveredBy).toBeNull();
  });

  it('o MESMO frame duas vezes nao gera duas leituras', async () => {
    const primeira = await enviar(frame(), tokenDoAparelho);
    const segunda = await enviar(frame(), tokenDoAparelho);

    expect(primeira.body.gravadas).toBe(1);
    expect(segunda.body.gravadas).toBe(0);
    // A amostragem pega a reentrega antes do indice unico, por estar parada no
    // mesmo estado dentro do minuto. Os dois caminhos levam ao mesmo lugar, e
    // e o lugar que importa: uma leitura.
    expect(await Reading.countDocuments({})).toBe(1);
  });

  it('com boot_id, reentregar um lote inteiro sai como duplicada', async () => {
    // Postura diferente entre os frames para que a amostragem guarde os dois,
    // e a reentrega chegue de fato ao indice unico.
    const lote = [
      frame({ timestamp_ms: 10_000, boot_id: 3, posture: { id: 'lying' } }),
      frame({ timestamp_ms: 12_000, boot_id: 3, posture: { id: 'standing' } }),
    ];

    const primeira = await enviar(lote, tokenDoAparelho);
    const segunda = await enviar(lote, tokenDoAparelho);

    expect(primeira.body.gravadas).toBe(2);
    expect(segunda.body.gravadas).toBe(0);
    expect(segunda.body.duplicadas).toBe(2);
    expect(await Reading.countDocuments({})).toBe(2);
  });

  it('SEM boot_id, reentregar um lote antigo e indistinguivel de um reboot', async () => {
    // Este teste documenta um limite conhecido, nao um comportamento desejado.
    //
    // Sem boot_id, a unica pista de reboot e o uptime voltar para tras - e um
    // lote reentregue comeca justamente com uptime menor que o ultimo visto.
    // O servidor abre uma ligada nova e as leituras entram de novo, agora com
    // outro bootAt, fora do alcance do indice unico. E o argumento concreto
    // para pedir boot_id ao firmware: ver docs/contrato-firmware.md.
    const lote = [
      frame({ timestamp_ms: 10_000, posture: { id: 'lying' } }),
      frame({ timestamp_ms: 12_000, posture: { id: 'standing' } }),
    ];

    await enviar(lote, tokenDoAparelho);
    const segunda = await enviar(lote, tokenDoAparelho);

    expect(segunda.body.gravadas).toBe(2);
    expect(await Reading.countDocuments({})).toBe(4);
  });

  it('atualiza o estado do aparelho', async () => {
    await enviar(frame({ timestamp_ms: 120_000 }), tokenDoAparelho);

    const device = await Device.findById(pulseiraId);
    expect(device?.lastUptimeMs).toBe(120_000);
    expect(device?.firmware).toBe('0.3.0');
    expect(device?.linkMode).toBe('wifi');
    expect(device?.batteryPct).toBe(88);
    expect(device?.lastSeenAt).not.toBeNull();
  });

  it('recusa frame de outra banda com 409', async () => {
    const res = await enviar(frame({ device_id: 77 }), tokenDoAparelho);

    expect(res.status).toBe(409);
    expect(res.body.erro.mensagem).toContain('banda 77');
  });

  it('recusa lote com aparelhos misturados', async () => {
    const res = await enviar(
      [frame(), frame({ device_id: 77, timestamp_ms: 62_000 })],
      tokenDoAparelho,
    );

    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('mesmo aparelho');
  });

  it('aparelho baixado nao envia', async () => {
    // Nao se baixa pulseira em uso: o release vem primeiro, por regra propria.
    await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({});
    await request(app)
      .patch(`/api/devices/${pulseiraId}`)
      .set('Authorization', admin.auth)
      .send({ status: 'retired' });

    const res = await enviar(frame(), tokenDoAparelho);
    expect(res.status).toBe(403);
  });
});

describe('ligadas da pulseira', () => {
  it('uptime menor que o anterior abre ligada nova', async () => {
    await enviar(frame({ timestamp_ms: 600_000 }), tokenDoAparelho);
    const primeiroBoot = (await Device.findById(pulseiraId))?.currentBootAt;

    // Religou: o uptime voltou para o comeco.
    await enviar(frame({ timestamp_ms: 4_000 }), tokenDoAparelho);
    const segundoBoot = (await Device.findById(pulseiraId))?.currentBootAt;

    expect(segundoBoot?.getTime()).toBeGreaterThan(primeiroBoot?.getTime() ?? 0);
    expect(await Reading.countDocuments({})).toBe(2);
  });

  it('o mesmo uptime em ligadas diferentes nao e tratado como duplicata', async () => {
    await enviar(frame({ timestamp_ms: 5_000, posture: { id: 'lying' } }), tokenDoAparelho);
    // Religou: o uptime voltou para o comeco.
    await enviar(frame({ timestamp_ms: 1_000, posture: { id: 'sitting' } }), tokenDoAparelho);
    // E voltou a passar pelo mesmo uptime 5_000 da ligada anterior.
    const res = await enviar(
      frame({ timestamp_ms: 5_000, posture: { id: 'standing' } }),
      tokenDoAparelho,
    );

    expect(res.body.duplicadas).toBe(0);
    expect(res.body.gravadas).toBe(1);
    expect(await Reading.countDocuments({})).toBe(3);
  });

  it('boot_id explicito vence a inferencia por uptime', async () => {
    await enviar(frame({ timestamp_ms: 10_000, boot_id: 7 }), tokenDoAparelho);
    const antes = await Device.findById(pulseiraId);
    expect(antes?.currentBootId).toBe(7);

    // Uptime SUBIU, o que a inferencia leria como a mesma ligada. O boot_id
    // diz que nao e: a pulseira reiniciou e ja passou desse uptime.
    await enviar(frame({ timestamp_ms: 20_000, boot_id: 8 }), tokenDoAparelho);
    const depois = await Device.findById(pulseiraId);

    expect(depois?.currentBootId).toBe(8);
    expect(depois?.currentBootAt?.getTime()).toBeGreaterThan(antes?.currentBootAt?.getTime() ?? 0);
  });

  it('lote bufferizado espaca as leituras pelo uptime, nao pelo instante da entrega', async () => {
    const res = await enviar(
      [
        frame({ timestamp_ms: 0 }),
        frame({ timestamp_ms: 120_000, posture: { id: 'sitting' } }),
        frame({ timestamp_ms: 240_000, posture: { id: 'standing' } }),
      ],
      tokenDoAparelho,
    );

    expect(res.body.gravadas).toBe(3);
    const leituras = await Reading.find({}).sort({ receivedAt: 1 });
    const t0 = leituras[0]?.receivedAt.getTime() ?? 0;
    const t2 = leituras[2]?.receivedAt.getTime() ?? 0;
    // Quatro minutos de coleta continuam quatro minutos no historico.
    expect(t2 - t0).toBe(240_000);
  });
});

describe('amostragem', () => {
  it('frames parados dentro do minuto viram uma leitura', async () => {
    // 30 frames a cada 2 s = 58 s de pulso parado.
    const lote = Array.from({ length: 30 }, (_, i) => frame({ timestamp_ms: i * 2_000 }));
    const res = await enviar(lote, tokenDoAparelho);

    expect(res.body.recebidos).toBe(30);
    expect(res.body.gravadas).toBe(1);
    expect(res.body.amostradas).toBe(29);
  });

  it('mudanca de postura forca gravar na hora', async () => {
    const lote = [
      frame({ timestamp_ms: 0 }),
      frame({ timestamp_ms: 2_000 }),
      frame({ timestamp_ms: 4_000, posture: { id: 'standing' } }),
      frame({ timestamp_ms: 6_000, posture: { id: 'standing' } }),
    ];
    const res = await enviar(lote, tokenDoAparelho);

    expect(res.body.gravadas).toBe(2);
    expect(res.body.amostradas).toBe(2);
  });

  it('passado um minuto, grava mesmo sem mudanca', async () => {
    const lote = [frame({ timestamp_ms: 0 }), frame({ timestamp_ms: 60_000 })];
    const res = await enviar(lote, tokenDoAparelho);

    expect(res.body.gravadas).toBe(2);
  });

  it('alerta NUNCA e amostrado, mesmo no frame descartado', async () => {
    const lote = [
      frame({ timestamp_ms: 0 }),
      // Dois segundos depois, parado em tudo que a amostragem observa, exceto
      // o alerta. A leitura e descartada; a ocorrencia de queda nao pode ser.
      frame({
        timestamp_ms: 2_000,
        fall: { detected: false, count: 1 },
        alerts: [
          { id: 'tremor', level: 'warn', since_ms: 1_900, active: true, detail: 'tremor 4,8 Hz' },
        ],
      }),
    ];
    const res = await enviar(lote, tokenDoAparelho);

    // A segunda leitura foi gravada porque alertWorst mudou - e justamente
    // essa a regra. O que importa aqui e o alerta nao ter se perdido.
    expect(res.body.alertas.criados).toBe(1);
    expect(await Alert.countDocuments({})).toBe(1);
  });
});

describe('alertas na ingestao', () => {
  function comAlerta(over: Record<string, unknown> = {}) {
    return frame({
      alerts: [{ id: 'fall', level: 'critical', since_ms: 30_000, active: true }],
      ...over,
    });
  }

  it('cria a ocorrencia com latched e o paciente certo', async () => {
    const res = await enviar(comAlerta(), tokenDoAparelho);

    expect(res.body.alertas.criados).toBe(1);
    const alerta = await Alert.findOne({});
    expect(alerta?.alertKey).toBe('fall');
    expect(alerta?.isLatched).toBe(true);
    expect(alerta?.status).toBe('active');
    expect(String(alerta?.patientId)).toBe(paciente.id);
    expect(alerta?.source).toBe('direct');
  });

  it('o mesmo alerta reenviado atualiza lastSeenAt, nao duplica', async () => {
    await enviar(comAlerta(), tokenDoAparelho);
    const primeiro = await Alert.findOne({});

    const res = await enviar(comAlerta({ timestamp_ms: 62_000 }), tokenDoAparelho);

    expect(res.body.alertas.criados).toBe(0);
    expect(res.body.alertas.atualizados).toBe(1);
    expect(await Alert.countDocuments({})).toBe(1);
    const depois = await Alert.findOne({});
    expect(depois?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      primeiro?.lastSeenAt.getTime() ?? 0,
    );
    expect(depois?.firstSeenAt.getTime()).toBe(primeiro?.firstSeenAt.getTime());
  });

  it('active:false normaliza', async () => {
    await enviar(comAlerta(), tokenDoAparelho);
    await enviar(
      frame({
        timestamp_ms: 62_000,
        alerts: [{ id: 'fall', level: 'critical', since_ms: 30_000, active: false }],
      }),
      tokenDoAparelho,
    );

    expect((await Alert.findOne({}))?.status).toBe('normalized');
  });

  it('active:false NAO desfaz um reconhecimento', async () => {
    await enviar(comAlerta(), tokenDoAparelho);
    const alerta = await Alert.findOne({});

    await request(app)
      .post(`/api/alerts/${String(alerta?._id)}/acknowledge`)
      .set('Authorization', carla.auth)
      .send();

    await enviar(
      frame({
        timestamp_ms: 62_000,
        alerts: [{ id: 'fall', level: 'critical', since_ms: 30_000, active: false }],
      }),
      tokenDoAparelho,
    );

    const depois = await Alert.findOne({});
    expect(depois?.status).toBe('acknowledged');
    expect(String(depois?.acknowledgedBy)).toBe(carla.id);
  });

  it('ocorrencia que comecou e terminou offline nasce normalizada', async () => {
    const res = await enviar(
      frame({
        alerts: [{ id: 'tremor', level: 'warn', since_ms: 10_000, active: false }],
      }),
      tokenDoAparelho,
    );

    expect(res.body.alertas.criados).toBe(1);
    expect((await Alert.findOne({}))?.status).toBe('normalized');
  });
});

describe('POST /api/ingest/telemetry pelo celular', () => {
  it('cuidador com vinculo ativo repassa, e fica assinado', async () => {
    const res = await enviar(frame(), carla.auth);

    expect(res.status).toBe(202);
    expect(res.body.source).toBe('app');
    expect(res.body.gravadas).toBe(1);

    const leitura = await Reading.findOne({});
    expect(leitura?.source).toBe('app');
    expect(String(leitura?.deliveredBy)).toBe(carla.id);
  });

  it('familiar sem manageDevice tambem repassa: e o caso principal do BLE', async () => {
    const convite = await request(app)
      .post(`/api/patients/${paciente.id}/carelinks`)
      .set('Authorization', carla.auth)
      .send({ caregiverEmail: familiar.email, relation: 'responsavel' });
    expect(convite.status).toBe(201);
    // O padrao do vinculo de responsavel: ve historico, recebe alerta, NAO
    // opera aparelho. E exatamente quem precisa poder repassar por BLE.
    expect(convite.body.permissions.manageDevice).toBe(false);

    const res = await enviar(frame(), familiar.auth);
    expect(res.status).toBe(202);
    expect(res.body.source).toBe('app');
  });

  it('usuario SEM vinculo com o paciente recebe 404', async () => {
    const res = await enviar(frame(), joana.auth);

    expect(res.status).toBe(404);
    expect(await Reading.countDocuments({})).toBe(0);
  });

  it('sem device_id no frame nao da para saber de qual pulseira e', async () => {
    const semId = frame();
    delete semId.device_id;

    const res = await enviar(semId, carla.auth);
    expect(res.status).toBe(400);
    expect(res.body.erro.mensagem).toContain('device_id');
  });

  it('banda desconhecida da 404', async () => {
    const res = await enviar(frame({ device_id: 4321 }), carla.auth);
    expect(res.status).toBe(404);
    expect(res.body.erro.mensagem).toContain('banda 4321');
  });

  it('device_id em texto tambem resolve, pelo campo deviceId', async () => {
    const res = await enviar(frame({ device_id: DEVICE_ID_TEXTO }), carla.auth);
    expect(res.status).toBe(202);
    expect(res.body.bandNumber).toBe(BANDA);
  });

  it('o mesmo frame pelo ESP e pelo celular converge no mesmo documento', async () => {
    const pelaPulseira = await enviar(frame(), tokenDoAparelho);
    const peloCelular = await enviar(frame(), carla.auth);

    expect(pelaPulseira.body.gravadas).toBe(1);
    expect(peloCelular.body.gravadas).toBe(0);
    expect(await Reading.countDocuments({})).toBe(1);

    // Quem chegou primeiro fica: reentrega nao reescreve historico.
    const leitura = await Reading.findOne({});
    expect(leitura?.source).toBe('direct');
    expect(leitura?.deliveredBy).toBeNull();
  });
});

describe('pulseira sem paciente', () => {
  beforeEach(async () => {
    const rel = await request(app)
      .post(`/api/devices/${pulseiraId}/release`)
      .set('Authorization', carla.auth)
      .send({});
    expect(rel.status).toBe(200);
  });

  it('aceita e guarda com patientId nulo', async () => {
    const res = await enviar(frame(), tokenDoAparelho);

    expect(res.status).toBe(202);
    expect(res.body.patientId).toBeNull();
    expect(res.body.gravadas).toBe(1);
    expect((await Reading.findOne({}))?.patientId).toBeNull();
  });

  it('e ninguem alcanca essa leitura pela rota do paciente', async () => {
    await enviar(frame(), tokenDoAparelho);

    const res = await request(app)
      .get(`/api/patients/${paciente.id}/readings`)
      .set('Authorization', carla.auth);

    expect(res.status).toBe(200);
    expect(res.body.itens).toHaveLength(0);
  });

  it('o celular de um cuidador nao consegue escrever nela', async () => {
    const res = await enviar(frame(), carla.auth);
    expect(res.status).toBe(404);
  });
});

describe('fidelidade ao frame do firmware', () => {
  it('aceita o frame de exemplo da secao 6, com os tipos reais', async () => {
    // Copiado da secao 6 do VitalWatch_Comunicacao: device_id numerico,
    // fall.phase numerico, inclination em graus inteiros, e os blocos que o
    // backend nao usa (motion, sensors, free_heap, samples, buzzer).
    const doDocumento = {
      device: 'VitalWatch Band',
      firmware: '0.3.0',
      device_id: BANDA,
      device_name: `VitalWatch${String(BANDA)}`,
      mode: 'normal',
      buzzer: false,
      timestamp_ms: 512_400,
      uptime_s: 512,
      free_heap: 152_000,
      samples: 51_240,
      patient: { name: 'Maria Souza', age: 82, room: '204', contact: '(11) 99999-0000' },
      panic: { active: true, count: 1, since_ms: 509_800 },
      posture: { id: 'lying', label: 'deitado', inclination: 85, stable: true },
      fall: { detected: false, simulated: false, phase: 0, count: 0 },
      movement: {
        class: 'rest',
        label: 'parado',
        energy: 0.012,
        dom_freq: 0.0,
        dom_ratio: 0.1,
        tremor: false,
        tremor_freq: 0.0,
        tremor_s: 0,
        odd: false,
        odd_score: 0.4,
      },
      alerts: [
        {
          id: 'panic',
          level: 'critical',
          title: 'Pedido de ajuda (botao)',
          detail: 'o paciente apertou o botao da pulseira',
          since_ms: 509_800,
          active: true,
        },
      ],
      alert_worst: 'critical',
      events: [{ seq: 7, t_ms: 509_800, id: 'panic', text: 'botao pressionado' }],
      motion: { ax: 0.01, ay: 0.02, az: 0.998, magnitude: 0.999, moving: false },
      sensors: { mpu6050: 'ok' },
      network: { link: 'espnow', mode: 'STA', ssid: 'CasaWiFi', ip: '192.168.0.13', clients: 1 },
      gateway: {
        name: 'vitalwatchgateway',
        firmware: '0.1.0',
        channel: 10,
        rssi: -58,
        bands_online: 1,
        lost: 3,
        age_ms: 420,
      },
    };

    const res = await enviar(doDocumento, tokenDoAparelho);

    expect(res.status).toBe(202);
    expect(res.body.gravadas).toBe(1);
    expect(res.body.alertas.criados).toBe(1);

    const leitura = await Reading.findOne({});
    expect(leitura?.posture?.inclination).toBe(85);
    expect(leitura?.fall?.phase).toBe(0);
    expect(leitura?.panic?.active).toBe(true);
    // rssi vem do bloco gateway, nao do network: e o link ESP-NOW que importa.
    expect(leitura?.rssi).toBe(-58);

    const alerta = await Alert.findOne({});
    expect(alerta?.alertKey).toBe('panic');
    expect(alerta?.isLatched).toBe(true);
    expect(alerta?.sinceUptimeMs).toBe(509_800);
  });

  it('fall.phase confirmada entra como numero', async () => {
    await enviar(
      frame({ fall: { detected: true, simulated: false, phase: 3, count: 1 } }),
      tokenDoAparelho,
    );
    expect((await Reading.findOne({}))?.fall?.phase).toBe(3);
  });
});

describe('autenticacao da ingestao', () => {
  it('sem header, 401', async () => {
    const res = await request(app).post('/api/ingest/telemetry').send(frame());
    expect(res.status).toBe(401);
  });

  it('frame sem timestamp_ms e invalido', async () => {
    const semUptime = frame();
    delete semUptime.timestamp_ms;

    const res = await enviar(semUptime, tokenDoAparelho);
    expect(res.status).toBe(400);
  });

  it('campo desconhecido do firmware nao derruba o frame', async () => {
    const res = await enviar(frame({ sensor_novo: { valor: 42 } }), tokenDoAparelho);
    expect(res.status).toBe(202);
    expect(res.body.gravadas).toBe(1);
  });
});

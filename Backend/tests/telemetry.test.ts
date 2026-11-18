import { describe, expect, it } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { Alert } from '../src/modules/telemetry/alert.model.js';
import { Reading } from '../src/modules/telemetry/reading.model.js';
import { firmwareTelemetrySchema } from '../src/modules/telemetry/telemetry.schemas.js';
import { ALERT_KEYS, LATCHED_ALERTS } from '../src/shared/types.js';

/**
 * Esta versao nao tem rota de ingestao: o transporte ainda nao foi decidido.
 * O que se testa aqui sao as invariantes dos modelos e o contrato do frame do
 * firmware, para que a ingestao futura seja so plugar.
 */

const deviceId = new Types.ObjectId();
const patientId = new Types.ObjectId();

/**
 * Carimbo do inicio de uma ligada da pulseira. Substituiu a colecao
 * BootSession: a ingestao detecta o reboot vendo o uptime voltar para tras e
 * grava Device.currentBootAt em cada leitura e alerta.
 */
let proximoBoot = Date.now();
function boot(): Date {
  proximoBoot += 60_000;
  return new Date(proximoBoot);
}

describe('modelo Reading', () => {
  it('nao aceita duas leituras com o mesmo uptime na mesma ligada', async () => {
    const base = {
      deviceId,
      patientId,
      bootAt: boot(),
      receivedAt: new Date(),
      uptimeMs: 120_000,
    };
    await Reading.create(base);

    // Reenvio do mesmo frame nao pode duplicar a amostra.
    await expect(Reading.create(base)).rejects.toThrow();
  });

  it('o mesmo uptime em ligadas diferentes e valido', async () => {
    // Depois de um reboot o uptime volta a zero, entao a colisao e esperada e
    // legitima: e por isso que a chave inclui o bootAt.
    await Reading.create({ deviceId, bootAt: boot(), receivedAt: new Date(), uptimeMs: 0 });
    await expect(
      Reading.create({ deviceId, bootAt: boot(), receivedAt: new Date(), uptimeMs: 0 }),
    ).resolves.toBeDefined();
  });

  it('nao tem campo de batimento cardiaco nem SpO2', () => {
    // O sensor foi testado e abandonado: "no pulso a leitura e pouco
    // confiavel, encarece a pulseira e gasta bateria".
    const caminhos = Object.keys(Reading.schema.paths);
    for (const proibido of ['heartRate', 'bpm', 'spo2', 'vitals', 'oxygen']) {
      expect(caminhos.some((c) => c.toLowerCase().includes(proibido.toLowerCase()))).toBe(false);
    }
  });

  it('tem TTL em receivedAt', async () => {
    // STATE a cada 2 s da ~1,3 milhao de documentos por mes por pulseira:
    // sem expiracao o M0 gratuito do Atlas estoura em dias.
    const indices = await Reading.collection.indexes();
    const ttl = indices.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl?.expireAfterSeconds).toBe(60 * 60 * 24 * 30);
  });

  it('recusa postura fora do vocabulario do firmware', async () => {
    await expect(
      Reading.create({
        deviceId,
        bootAt: boot(),
        receivedAt: new Date(),
        uptimeMs: 1,
        posture: { id: 'flutuando' },
      }),
    ).rejects.toThrow(mongoose.Error.ValidationError);
  });
});

describe('modelo Alert', () => {
  const ocorrencia = (bootAt: Date) => ({
    deviceId,
    patientId,
    bootAt,
    alertKey: 'fall' as const,
    level: 'critical' as const,
    sinceUptimeMs: 3_600_000,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    isLatched: true,
  });

  it('a mesma ocorrencia nao entra duas vezes', async () => {
    const b = boot();
    await Alert.create(ocorrencia(b));

    // Chave natural: deviceId + bootAt + alertKey + sinceUptimeMs. O app Kotlin
    // ja identifica alerta por "deviceId:id:sinceMs"; o bootAt e o que faltava
    // para a tupla ser estavel entre reboots.
    await expect(Alert.create(ocorrencia(b))).rejects.toThrow();
  });

  it('a mesma queda em ligadas diferentes conta como duas ocorrencias', async () => {
    // O caso que motiva o bootAt: a pulseira cai, reboota por falta de
    // bateria, e cai de novo com since_ms identico. Sem o bootAt a segunda
    // queda seria descartada como duplicata, e um alerta critico desapareceria.
    await Alert.create(ocorrencia(boot()));
    await expect(Alert.create(ocorrencia(boot()))).resolves.toBeDefined();
  });

  it('nasce ativo e sem reconhecimento', async () => {
    const alerta = await Alert.create(ocorrencia(boot()));

    expect(alerta.status).toBe('active');
    expect(alerta.acknowledgedAt).toBeNull();
    expect(alerta.acknowledgedBy).toBeNull();
  });

  it('aceita os tres estados e nao um booleano', async () => {
    const alerta = await Alert.create(ocorrencia(boot()));

    // active:false do firmware e um tumulo ("acabou de normalizar, mostre
    // esmaecido"), nao a mesma coisa que resolvido, nem que reconhecido.
    for (const status of ['normalized', 'acknowledged', 'active'] as const) {
      alerta.status = status;
      await expect(alerta.save()).resolves.toBeDefined();
    }
  });

  it('nao tem TTL: a ocorrencia fica mesmo depois de a leitura expirar', async () => {
    const indices = await Alert.collection.indexes();
    expect(indices.find((i) => i.expireAfterSeconds !== undefined)).toBeUndefined();
  });

  it('aceita exatamente os quatro alertas do firmware', async () => {
    expect([...ALERT_KEYS]).toEqual(['panic', 'fall', 'tremor', 'odd_motion']);
    // panic e fall ficam acesos ate alguem reconhecer; os outros se limpam.
    expect([...LATCHED_ALERTS]).toEqual(['panic', 'fall']);

    await expect(
      Alert.create({ ...ocorrencia(boot()), alertKey: 'batimento_alto' as never }),
    ).rejects.toThrow(mongoose.Error.ValidationError);
  });
});

describe('contrato do frame do firmware', () => {
  const frame = {
    device_id: 'vitalwatch-0001',
    device_name: 'VitalWatch1',
    firmware: '2.0.0',
    mode: 'normal',
    timestamp_ms: 21_600_000,
    uptime_s: 21_600,
    patient: { name: 'Terezinha', age: 84, room: '102', contact: '+5585999990001' },
    posture: { id: 'lying', label: 'Deitado', inclination: 82, stable: true },
    movement: { class: 'rest', energy: 0.04, tremor: false, tremor_freq: 0, odd: false },
    fall: { detected: false, simulated: false, count: 0 },
    panic: { active: false, count: 0 },
    alerts: [
      {
        id: 'fall',
        level: 'critical',
        title: 'Queda',
        detail: 'Queda detectada',
        since_ms: 1000,
        active: true,
      },
    ],
    events: [{ seq: 12, t_ms: 1000, id: 'fall', text: 'queda' }],
    battery: { percent: 68, voltage: 3.8, charging: false },
    network: { link: 'espnow', rssi: -54 },
    gateway: { name: 'VitalWatchGateway', channel: 6, rssi: -54, lost: 0, age_ms: 320 },
  };

  it('aceita o frame completo da secao 6 do documento', () => {
    expect(firmwareTelemetrySchema.safeParse(frame).success).toBe(true);
  });

  it('aceita o frame de uma pulseira em modo wifi, sem bloco gateway', () => {
    const { gateway, ...semGateway } = frame;
    expect(firmwareTelemetrySchema.safeParse(semGateway).success).toBe(true);
  });

  it('ignora campos novos em vez de rejeitar o frame', () => {
    // Uma versao de firmware que acrescente um campo nao pode derrubar a
    // ingestao inteira.
    const r = firmwareTelemetrySchema.safeParse({ ...frame, campo_que_nao_existe_ainda: 42 });
    expect(r.success).toBe(true);
  });

  it('exige o timestamp_ms, que e a ancora de uptime', () => {
    const { timestamp_ms, ...sem } = frame;
    expect(firmwareTelemetrySchema.safeParse(sem).success).toBe(false);
  });

  it('recusa um alerta fora dos quatro conhecidos', () => {
    const r = firmwareTelemetrySchema.safeParse({
      ...frame,
      alerts: [{ id: 'heart_rate_high', level: 'critical', since_ms: 0, active: true }],
    });
    expect(r.success).toBe(false);
  });
});

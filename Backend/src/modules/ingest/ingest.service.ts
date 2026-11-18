import { Types } from 'mongoose';
import { AppError } from '../../shared/AppError.js';
import {
  INTERVALO_DE_AMOSTRAGEM_MS,
  LATCHED_ALERTS,
  type AuthenticatedUser,
} from '../../shared/types.js';
import { CareLink } from '../carelinks/careLink.model.js';
import { Device, type DeviceDoc } from '../devices/device.model.js';
import { DeviceAssignment } from '../devices/deviceAssignment.model.js';
import { Alert } from '../telemetry/alert.model.js';
import { Reading } from '../telemetry/reading.model.js';
import type { FirmwareTelemetry } from '../telemetry/telemetry.schemas.js';

/** Quem entregou o frame. Exatamente um dos dois vem preenchido. */
export interface Entregador {
  /** A propria pulseira, autenticada com token de aparelho. */
  device?: DeviceDoc;
  /** O celular, repassando por BLE com o access token do cuidador. */
  user?: AuthenticatedUser;
}

export interface ResultadoDaIngestao {
  deviceId: string;
  bandNumber: number;
  patientId: string | null;
  ligadaAt: Date;
  source: 'direct' | 'app';
  recebidos: number;
  /** Leituras novas gravadas. */
  gravadas: number;
  /** Frames que o servidor ja tinha: entrega dupla, nao erro. */
  duplicadas: number;
  /** Frames aceitos e nao gravados por politica de amostragem. */
  amostradas: number;
  alertas: { criados: number; atualizados: number };
}

const ORDEM_DOS_NIVEIS: Record<string, number> = { info: 1, warn: 2, critical: 3 };

/**
 * Pior nivel entre os alertas ATIVOS do frame.
 *
 * Derivado do array alerts[], nao do campo alert_worst: o campo e conveniencia
 * do firmware e versoes antigas o omitem. Derivar nunca discorda do array.
 */
export function piorNivelAtivo(frame: FirmwareTelemetry): string | null {
  let pior: string | null = null;
  for (const a of frame.alerts ?? []) {
    if (!a.active) continue;
    if (pior === null || (ORDEM_DOS_NIVEIS[a.level] ?? 0) > (ORDEM_DOS_NIVEIS[pior] ?? 0)) {
      pior = a.level;
    }
  }
  return pior;
}

/** O que a amostragem observa. Tudo que nao esta aqui nao decide nada. */
export interface ResumoDaAmostra {
  at: Date | null;
  /** Ligada da pulseira a que esta amostra pertence. */
  bootAt: Date | null;
  postureId: string | null;
  movementClass: string | null;
  fallDetected: boolean | null;
  panicActive: boolean | null;
  alertWorst: string | null;
}

export function resumirFrame(
  frame: FirmwareTelemetry,
  receivedAt: Date,
  bootAt: Date,
): ResumoDaAmostra {
  return {
    at: receivedAt,
    bootAt,
    postureId: frame.posture?.id ?? null,
    movementClass: frame.movement?.class ?? null,
    fallDetected: frame.fall?.detected ?? null,
    panicActive: frame.panic?.active ?? null,
    alertWorst: piorNivelAtivo(frame),
  };
}

/**
 * A politica de amostragem: uma leitura por minuto, mais toda mudanca.
 *
 * Pura e exportada para ser testavel sem banco, porque e a regra que decide o
 * que o sistema LEMBRA. Errar para o lado de gravar menos perde a resolucao de
 * um minuto parado; errar para o lado de gravar tudo estoura o Atlas em dias
 * (1.412 MB/mes para oito pulseiras, contra 512 MB do M0).
 *
 * O teste do intervalo usa valor absoluto de proposito: num lote bufferizado,
 * os carimbos de chegada podem cair ANTES da ultima amostra ja gravada, e um
 * salto grande no tempo em qualquer direcao merece uma amostra.
 */
export function devoGravar(anterior: ResumoDaAmostra | null, atual: ResumoDaAmostra): boolean {
  if (!anterior?.at || !atual.at) return true;

  // Ligada nova sempre grava, aconteca o que acontecer com os outros campos.
  //
  // Sem isto, uma pulseira que reinicia parada no mesmo lugar nao gera leitura
  // nenhuma na ligada nova: a comparacao de postura e movimento da igual, o
  // intervalo ainda nao fechou, e o bootAt recem-criado fica sem nenhuma
  // leitura que o aponte. O reboot desapareceria do historico - e reboot em
  // pulseira de paciente e justamente o que alguem precisa investigar.
  if (anterior.bootAt?.getTime() !== atual.bootAt?.getTime()) return true;

  if (Math.abs(atual.at.getTime() - anterior.at.getTime()) >= INTERVALO_DE_AMOSTRAGEM_MS) {
    return true;
  }
  return (
    anterior.postureId !== atual.postureId ||
    anterior.movementClass !== atual.movementClass ||
    anterior.fallDetected !== atual.fallDetected ||
    anterior.panicActive !== atual.panicActive ||
    anterior.alertWorst !== atual.alertWorst
  );
}

interface FramePreparado {
  frame: FirmwareTelemetry;
  bootAt: Date;
  receivedAt: Date;
}

/** Houve reboot entre dois frames vizinhos do lote? */
function comecaLigadaNova(anterior: FirmwareTelemetry, atual: FirmwareTelemetry): boolean {
  if (anterior.boot_id !== undefined && atual.boot_id !== undefined) {
    return anterior.boot_id !== atual.boot_id;
  }
  // Sem boot_id, a unica pista: o uptime nao volta para tras sozinho.
  return atual.timestamp_ms < anterior.timestamp_ms;
}

/** O primeiro frame do lote pertence a uma ligada nova do aparelho? */
function ligadaNovaContraOEstado(device: DeviceDoc, frame: FirmwareTelemetry): boolean {
  if (!device.currentBootAt) return true;
  if (frame.boot_id !== undefined) return device.currentBootId !== frame.boot_id;
  const ultimoUptime = device.lastUptimeMs ?? null;
  return ultimoUptime !== null && frame.timestamp_ms < ultimoUptime;
}

/**
 * Carimba cada frame com a ligada a que pertence e a hora de chegada, e deixa
 * o estado de ligada do `device` atualizado (sem salvar).
 *
 * Por que a hora de chegada e calculada e nao "agora" para todos: um lote
 * bufferizado representa minutos ou horas de coleta. Carimbar tudo com o
 * instante da reconexao comprimiria o historico num ponto - a queda de
 * 14h02 apareceria as 15h30. O espacamento sai do uptime, que e a unica
 * referencia temporal que a pulseira tem (ela nao tem relogio). E a mesma
 * conta que o app Kotlin ja faz em VitalWatchViewModel.registrarEventos.
 *
 * O preco honesto: bootAt de uma ligada descoberta agora e a hora do
 * SERVIDOR agora, nao a hora real do reboot, que ninguem sabe.
 */
function prepararFrames(device: DeviceDoc, frames: FirmwareTelemetry[]): FramePreparado[] {
  const agora = Date.now();

  // 1. Onde comecam as ligadas dentro deste lote.
  const inicioDeLigada = new Set<number>([0]);
  for (let i = 1; i < frames.length; i++) {
    const anterior = frames[i - 1];
    const atual = frames[i];
    if (anterior && atual && comecaLigadaNova(anterior, atual)) inicioDeLigada.add(i);
  }

  // 2. bootAt por frame.
  const bootAts: Date[] = [];
  let ligadasAbertas = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame) continue;
    if (inicioDeLigada.has(i)) {
      // Grupo depois do primeiro ja e, por definicao, ligada nova.
      if (i > 0 || ligadaNovaContraOEstado(device, frame)) {
        // O "+ ligadasAbertas" evita que duas ligadas descobertas no MESMO
        // lote recebam carimbos iguais: com bootAt identico, o mesmo uptime
        // nas duas colidiria na chave unica e uma leitura seria perdida.
        device.currentBootAt = new Date(agora + ligadasAbertas);
        device.currentBootId = frame.boot_id ?? null;
        ligadasAbertas++;
      } else if (frame.boot_id !== undefined) {
        device.currentBootId = frame.boot_id;
      }
    }
    bootAts.push(device.currentBootAt ?? new Date(agora));
  }

  // 3. Hora de chegada, de tras para frente a partir de agora.
  const receivedAts: Date[] = [];
  let t = agora;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (i < frames.length - 1) {
      const atual = frames[i];
      const proximo = frames[i + 1];
      // Entre ligadas nao existe delta de uptime que signifique algo: os dois
      // frames ficam colados, que e o menos errado sem outra informacao.
      const mesmaLigada = !inicioDeLigada.has(i + 1);
      const delta =
        mesmaLigada && atual && proximo
          ? Math.max(0, proximo.timestamp_ms - atual.timestamp_ms)
          : 0;
      t -= delta;
    }
    receivedAts[i] = new Date(t);
  }

  const preparados: FramePreparado[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const bootAt = bootAts[i];
    const receivedAt = receivedAts[i];
    if (!frame || !bootAt || !receivedAt) continue;
    preparados.push({ frame, bootAt, receivedAt });
  }
  return preparados;
}

/**
 * Identifica a pulseira que o frame diz ser.
 *
 * Numero e `bandNumber` - e o que o firmware manda hoje (`"device_id":12`,
 * secao 6 do documento: "Numero da pulseira"). Texto e `Device.deviceId`, que
 * existe para um identificador alfanumerico, do tipo derivado do MAC, caso o
 * firmware passe a mandar isso. Ver docs/contrato-firmware.md.
 */
function descreverIdDoFrame(id: number | string): string {
  return typeof id === 'number' ? `banda ${String(id)}` : `device_id ${id}`;
}

function confereComOAparelho(device: DeviceDoc, id: number | string): boolean {
  return typeof id === 'number' ? device.bandNumber === id : device.deviceId === id;
}

/**
 * Descobre de qual aparelho e o lote.
 *
 * Com token de aparelho, o proprio token responde - e o device_id do frame
 * serve de conferencia. Com token de usuario, o device_id do frame e a unica
 * pista, e todos os frames do lote tem de ser do mesmo aparelho: um lote
 * misturado precisaria de uma resolucao de ligada e uma checagem de permissao
 * por aparelho, o que a resposta unica desta rota nao saberia descrever.
 */
async function resolverAparelho(frames: FirmwareTelemetry[], quem: Entregador): Promise<DeviceDoc> {
  const idsNoLote = new Set(frames.map((f) => f.device_id).filter((v) => v !== undefined));
  if (idsNoLote.size > 1) {
    throw AppError.badRequest(
      'Todos os frames de um lote precisam ser do mesmo aparelho (device_id)',
    );
  }
  const idNoLote = [...idsNoLote][0];

  if (quem.device) {
    const device = quem.device;
    if (idNoLote !== undefined && !confereComOAparelho(device, idNoLote)) {
      // Primeiro contato com um device_id em texto: o token amarra o aparelho
      // a ele. Se outro Device ja tiver esse valor, o indice unico barra e sai
      // 409 - a resposta certa, porque duas pulseiras com a mesma identidade
      // e problema de provisionamento, nao de rede.
      if (typeof idNoLote === 'string' && device.deviceId === null) {
        device.deviceId = idNoLote;
      } else {
        throw AppError.conflict(
          `Este token pertence a banda ${String(device.bandNumber)}, mas o frame diz ser de ${descreverIdDoFrame(idNoLote)}`,
        );
      }
    }
    return device;
  }

  // Caminho do celular.
  if (idNoLote === undefined) {
    throw AppError.badRequest(
      'Sem token de aparelho, o frame precisa trazer device_id para o servidor saber de qual pulseira e',
    );
  }
  const filtro = typeof idNoLote === 'number' ? { bandNumber: idNoLote } : { deviceId: idNoLote };
  const device = await Device.findOne(filtro);
  if (!device) {
    throw AppError.notFound(`Nenhuma pulseira cadastrada com ${descreverIdDoFrame(idNoLote)}`);
  }
  if (device.status === 'retired') {
    throw AppError.forbidden('Este aparelho esta baixado e nao pode enviar telemetria');
  }
  return device;
}

/**
 * O celular pode escrever na pulseira deste paciente?
 *
 * Basta vinculo ATIVO, sem exigir manageDevice. O caso principal do caminho
 * BLE e justamente o familiar em casa, que nao tem manageDevice: exigi-la
 * mataria o unico cenario que esse caminho existe para atender. Quem ja ve a
 * telemetria do paciente poder entrega-la nao e escalada de privilegio.
 *
 * O que sobra de risco - um cuidador vinculado injetar dado falso - e tratado
 * por atribuicao, nao por bloqueio: cada leitura e alerta gravado por este
 * caminho guarda deliveredBy. Dado forjado fica assinado.
 *
 * 404 e nao 403 quando nao ha vinculo: um 403 confirmaria que aquele device_id
 * existe e esta num paciente.
 */
async function assertPodeEntregar(
  patientId: Types.ObjectId | null,
  quem: Entregador,
): Promise<void> {
  if (quem.device) return;
  const user = quem.user;
  if (!user) throw AppError.unauthorized();
  if (user.roles.includes('admin')) return;

  if (!patientId) {
    throw AppError.notFound('Pulseira nao encontrada');
  }

  const link = await CareLink.findOne({
    patientId,
    caregiverId: new Types.ObjectId(user.id),
    status: 'active',
  });
  if (!link) throw AppError.notFound('Pulseira nao encontrada');
}

/**
 * Grava as OCORRENCIAS de alerta do lote.
 *
 * Nunca amostrado, ao contrario das leituras: perder a amostra de um segundo
 * parado e irrelevante, perder a ocorrencia de uma queda nao e. Por isso roda
 * sobre todos os frames, inclusive os que a amostragem descartou.
 *
 * O upsert pela chave natural {deviceId, bootAt, alertKey, sinceUptimeMs} e o
 * que torna a entrega dupla inofensiva: o mesmo alerta chegando pelo ESP e
 * pelo celular atualiza o mesmo documento em vez de criar dois.
 */
async function gravarAlertas(
  device: DeviceDoc,
  patientId: Types.ObjectId | null,
  deliveredBy: Types.ObjectId | null,
  source: 'direct' | 'app',
  preparados: FramePreparado[],
): Promise<{ criados: number; atualizados: number }> {
  let criados = 0;
  let atualizados = 0;

  for (const { frame, bootAt, receivedAt } of preparados) {
    for (const a of frame.alerts ?? []) {
      const chave = {
        deviceId: device._id,
        bootAt,
        alertKey: a.id,
        sinceUptimeMs: a.since_ms,
      };
      const nascimento = {
        patientId,
        level: a.level,
        isLatched: LATCHED_ALERTS.includes(a.id),
        firstSeenAt: receivedAt,
        source,
        deliveredBy,
      };

      if (a.active) {
        const r = await Alert.updateOne(
          chave,
          {
            $setOnInsert: { ...nascimento, status: 'active' },
            $set: {
              lastSeenAt: receivedAt,
              ...(a.detail !== undefined ? { detail: a.detail } : {}),
            },
          },
          { upsert: true },
        );
        if (r.upsertedCount > 0) criados++;
        else atualizados++;
        continue;
      }

      // active:false e o firmware dizendo "normalizou". Nao desfaz um ack: um
      // alerta ja reconhecido continua reconhecido, com quem atendeu e quando.
      const normalizou = await Alert.updateOne(
        { ...chave, status: 'active' },
        { $set: { status: 'normalized', lastSeenAt: receivedAt } },
      );
      if (normalizou.matchedCount > 0) {
        atualizados++;
        continue;
      }
      // Nao existia: lote bufferizado em que a ocorrencia inteira passou
      // offline. Nasce ja normalizada, para o historico nao perder que houve.
      const r = await Alert.updateOne(
        chave,
        { $setOnInsert: { ...nascimento, status: 'normalized', lastSeenAt: receivedAt } },
        { upsert: true },
      );
      if (r.upsertedCount > 0) criados++;
      else atualizados++;
    }
  }

  return { criados, atualizados };
}

/**
 * Recebe telemetria da pulseira, venha ela por wifi ou repassada por BLE.
 *
 * O paciente e resolvido AQUI, no momento da chegada, pelo DeviceAssignment
 * aberto - e gravado em cada leitura. E o coracao do modelo: a pulseira e do
 * hospital e passa de paciente para paciente, ela nao sabe (nem deve saber) de
 * quem e. Carimbar na chegada tambem significa que o passado nao muda de dono:
 * corrigir uma atribuicao depois nao reescreve o historico ja gravado.
 *
 * Sem atribuicao aberta, patientId fica nulo e a leitura e guardada mesmo
 * assim. Recusar seria perder dado por falta de papelada; e ninguem alcanca
 * essa leitura por rota de paciente ate alguem atribuir.
 */
export async function ingestTelemetry(
  frames: FirmwareTelemetry[],
  quem: Entregador,
): Promise<ResultadoDaIngestao> {
  const device = await resolverAparelho(frames, quem);

  const assignment = await DeviceAssignment.findOne({
    deviceId: device._id,
    releasedAt: null,
  });
  const patientId = assignment?.patientId ?? null;

  await assertPodeEntregar(patientId, quem);

  const source: 'direct' | 'app' = quem.device ? 'direct' : 'app';
  const deliveredBy = quem.user ? new Types.ObjectId(quem.user.id) : null;

  const preparados = prepararFrames(device, frames);

  // Decide o que gravar, encadeando dentro do lote: a referencia da proxima
  // decisao e a amostra que esta acabou de aprovar, nao a que estava no banco.
  const lastSample = device.lastSample;
  let anterior: ResumoDaAmostra | null = lastSample?.at
    ? {
        at: lastSample.at,
        bootAt: lastSample.bootAt ?? null,
        postureId: lastSample.postureId ?? null,
        movementClass: lastSample.movementClass ?? null,
        fallDetected: lastSample.fallDetected ?? null,
        panicActive: lastSample.panicActive ?? null,
        alertWorst: lastSample.alertWorst ?? null,
      }
    : null;

  const operacoes = [];
  let amostradas = 0;

  for (const { frame, bootAt, receivedAt } of preparados) {
    const resumo = resumirFrame(frame, receivedAt, bootAt);
    if (!devoGravar(anterior, resumo)) {
      amostradas++;
      continue;
    }
    anterior = resumo;

    operacoes.push({
      updateOne: {
        filter: { deviceId: device._id, bootAt, uptimeMs: frame.timestamp_ms },
        // $setOnInsert e nao $set: se o frame ja estava aqui, quem chegou
        // primeiro fica. Reentrega nao reescreve historico.
        update: {
          $setOnInsert: {
            patientId,
            receivedAt,
            posture: {
              id: frame.posture?.id ?? 'unknown',
              inclination: frame.posture?.inclination ?? null,
              stable: frame.posture?.stable ?? null,
            },
            movement: {
              class: frame.movement?.class ?? 'unknown',
              energy: frame.movement?.energy ?? null,
              tremor: frame.movement?.tremor ?? null,
              tremorFreq: frame.movement?.tremor_freq ?? null,
              tremorS: frame.movement?.tremor_s ?? null,
              odd: frame.movement?.odd ?? null,
            },
            fall: {
              detected: frame.fall?.detected ?? false,
              simulated: frame.fall?.simulated ?? false,
              phase: frame.fall?.phase ?? null,
              count: frame.fall?.count ?? 0,
            },
            panic: {
              active: frame.panic?.active ?? false,
              count: frame.panic?.count ?? 0,
            },
            batteryPct: frame.battery?.percent ?? null,
            rssi: frame.gateway?.rssi ?? frame.network?.rssi ?? null,
            source,
            deliveredBy,
          },
        },
        upsert: true,
      },
    });
  }

  // bulkWrite com upsert, e nao insertMany: a entrega dupla e ESPERADA nos
  // dois caminhos, e aqui ela sai como matchedCount em vez de excecao. O
  // indice unico continua sendo a garantia contra corrida entre dois requests.
  let gravadas = 0;
  let duplicadas = 0;
  if (operacoes.length > 0) {
    const r = await Reading.bulkWrite(operacoes, { ordered: false });
    gravadas = r.upsertedCount;
    duplicadas = r.matchedCount;
  }

  const alertas = await gravarAlertas(device, patientId, deliveredBy, source, preparados);

  // Estado do aparelho, pelo frame mais recente do lote.
  const ultimo = preparados.at(-1);
  if (ultimo) {
    device.lastUptimeMs = ultimo.frame.timestamp_ms;
    device.lastSeenAt = new Date();
    if (ultimo.frame.device_name !== undefined) device.deviceName = ultimo.frame.device_name;
    if (ultimo.frame.firmware !== undefined) device.firmware = ultimo.frame.firmware;
    if (ultimo.frame.network?.link !== undefined) device.linkMode = ultimo.frame.network.link;
    if (ultimo.frame.battery?.percent !== undefined) {
      device.batteryPct = ultimo.frame.battery.percent;
    }
    const rssi = ultimo.frame.gateway?.rssi ?? ultimo.frame.network?.rssi;
    if (rssi !== undefined) device.rssi = rssi;
    if (anterior?.at) {
      device.lastSample = {
        at: anterior.at,
        bootAt: anterior.bootAt,
        postureId: anterior.postureId,
        movementClass: anterior.movementClass,
        fallDetected: anterior.fallDetected,
        panicActive: anterior.panicActive,
        alertWorst: anterior.alertWorst,
      };
    }
  }
  await device.save();

  return {
    deviceId: String(device._id),
    bandNumber: device.bandNumber,
    patientId: patientId ? String(patientId) : null,
    ligadaAt: device.currentBootAt ?? new Date(),
    source,
    recebidos: frames.length,
    gravadas,
    duplicadas,
    amostradas,
    alertas,
  };
}

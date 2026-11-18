import { Types } from 'mongoose';
import type mongoose from 'mongoose';
import { AppError } from '../../shared/AppError.js';
import type { AuthenticatedUser } from '../../shared/types.js';
import { paginated } from '../../shared/validation.js';
import { CareLink } from '../carelinks/careLink.model.js';
import { Alert, type AlertDoc, type AlertPlano } from './alert.model.js';
import { Reading, type ReadingPlano } from './reading.model.js';
import type { ListAlertsQuery, ListReadingsQuery } from './telemetry.schemas.js';

/**
 * Monta o filtro de intervalo. `from`/`to` sao hora de SERVIDOR (receivedAt),
 * nunca uptime: uptime zera no reboot e nao serve para localizar nada.
 */
function intervalo(campo: string, from?: Date, to?: Date): mongoose.FilterQuery<unknown> {
  if (!from && !to) return {};
  const faixa: Record<string, Date> = {};
  if (from) faixa.$gte = from;
  if (to) faixa.$lte = to;
  return { [campo]: faixa };
}

/**
 * Historico de leituras de um paciente.
 *
 * Resolve por patientId, nunca por deviceId: a pulseira e do hospital e passa
 * de paciente para paciente, e o patientId e gravado na leitura no momento da
 * ingestao. E isso que impede a familia de um paciente ver o periodo em que a
 * mesma pulseira estava em outro.
 *
 * O indice { patientId: 1, receivedAt: -1 } atende a consulta e a ordenacao:
 * nao ha SORT em memoria, mesmo com paginacao profunda.
 */
export async function listReadings(patientId: Types.ObjectId, query: ListReadingsQuery) {
  const filtro = { patientId, ...intervalo('receivedAt', query.from, query.to) };
  const skip = (query.page - 1) * query.limit;

  const [leituras, total] = await Promise.all([
    Reading.find(filtro).sort({ receivedAt: -1 }).skip(skip).limit(query.limit).lean(),
    Reading.countDocuments(filtro),
  ]);

  return paginated(leituras.map(leituraParaApi), total, query);
}

export async function listAlerts(patientId: Types.ObjectId, query: ListAlertsQuery) {
  const filtro: mongoose.FilterQuery<unknown> = {
    patientId,
    ...intervalo('firstSeenAt', query.from, query.to),
  };
  if (query.status) filtro.status = query.status;
  if (query.alertKey) filtro.alertKey = query.alertKey;

  const skip = (query.page - 1) * query.limit;
  const [alertas, total] = await Promise.all([
    Alert.find(filtro).sort({ firstSeenAt: -1 }).skip(skip).limit(query.limit).lean(),
    Alert.countDocuments(filtro),
  ]);

  return paginated(alertas.map(alertaParaApi), total, query);
}

/**
 * Reconhece um alerta: assina quem atendeu e tira da lista de ativos.
 *
 * ATENCAO ao limite: isto NAO chega a pulseira. panic e fall sao latched no
 * firmware e continuam acesos no aparelho e no painel do gateway, porque nao
 * existe canal de descida do backend para o gateway. O que isto registra e
 * "quem atendeu e quando" - nao "apaga a luz da pulseira". A propagacao entra
 * junto com a ingestao.
 *
 * Sem isto a lista de alertas ativos nunca encolhe: uma queda de tres semanas
 * atras continua no topo da tela, e a enfermagem para de olhar.
 */
export async function acknowledgeAlert(
  alertId: string,
  actor: AuthenticatedUser,
): Promise<AlertDoc> {
  const alerta = await Alert.findById(alertId);
  if (!alerta) throw AppError.notFound('Alerta nao encontrado');

  await assertPodeReconhecer(alerta.patientId ?? null, actor);

  // Idempotente: reconhecer duas vezes nao reescreve quem atendeu primeiro.
  if (alerta.status === 'acknowledged') return alerta;

  alerta.status = 'acknowledged';
  alerta.acknowledgedAt = new Date();
  alerta.acknowledgedBy = new Types.ObjectId(actor.id);
  alerta.acknowledgedVia = 'app';
  await alerta.save();
  return alerta;
}

/**
 * Precisa de vinculo ativo com a permissao acknowledgeAlerts, ou ser admin.
 *
 * A permissao nasce com a enfermagem e e configuravel para o responsavel: se
 * um familiar apaga o alerta de queda, a enfermagem deixa de ve-lo sem ninguem
 * ter ido ate a paciente.
 */
async function assertPodeReconhecer(
  patientId: Types.ObjectId | null,
  actor: AuthenticatedUser,
): Promise<void> {
  if (actor.roles.includes('admin')) return;

  // Alerta ingerido enquanto a pulseira estava sem paciente: nao ha vinculo
  // que o alcance, e so a instituicao pode mexer.
  if (!patientId) throw AppError.notFound('Alerta nao encontrado');

  const link = await CareLink.findOne({
    patientId,
    caregiverId: new Types.ObjectId(actor.id),
    status: 'active',
  });
  // 404 e nao 403: um 403 confirmaria que aquele id de alerta existe.
  if (!link) throw AppError.notFound('Alerta nao encontrado');

  if (!link.permissions?.acknowledgeAlerts) {
    throw AppError.forbidden(
      'Seu vinculo nao tem a permissao "acknowledgeAlerts". Quem atende o alerta e a equipe de enfermagem.',
    );
  }
}

/** Forma de saida de uma leitura. Nomes do firmware, hora do servidor. */
export function leituraParaApi(r: ReadingPlano) {
  return {
    id: r._id.toString(),
    receivedAt: r.receivedAt,
    bootAt: r.bootAt,
    uptimeMs: r.uptimeMs,
    posture: r.posture,
    movement: r.movement,
    fall: r.fall,
    panic: r.panic,
    batteryPct: r.batteryPct,
    rssi: r.rssi,
    source: r.source,
  };
}

export function alertaParaApi(a: AlertPlano) {
  return {
    id: a._id.toString(),
    alertKey: a.alertKey,
    level: a.level,
    detail: a.detail ?? null,
    status: a.status,
    isLatched: a.isLatched,
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    bootAt: a.bootAt,
    sinceUptimeMs: a.sinceUptimeMs,
    acknowledgedAt: a.acknowledgedAt ?? null,
    acknowledgedBy: a.acknowledgedBy ? a.acknowledgedBy.toString() : null,
    acknowledgedVia: a.acknowledgedVia ?? null,
  };
}

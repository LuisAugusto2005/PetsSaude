import { Types } from 'mongoose';
import type mongoose from 'mongoose';
import type { Response } from 'express';
import { AppError } from '../../shared/AppError.js';
import { CareLink } from '../carelinks/careLink.model.js';
import { Device } from '../devices/device.model.js';
import { DeviceAssignment } from '../devices/deviceAssignment.model.js';
import { Patient } from '../patients/patient.model.js';
import { User } from '../users/user.model.js';
import { Alert } from '../telemetry/alert.model.js';
import { Reading } from '../telemetry/reading.model.js';
import { acessosDoUsuario } from '../audit/audit.service.js';
import type { ExportPatientQuery } from './export.schemas.js';

/** Valor que uma celula de CSV aceita. Nada de objeto: CSV e plano. */
type Celula = string | number | boolean | Date | null | undefined;

/** Escapa um valor para CSV. Vira vazio quando nulo, e cita quando precisa. */
function csv(valor: Celula): string {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) return valor.toISOString();
  const texto = typeof valor === 'string' ? valor : String(valor);
  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function linha(valores: Celula[]): string {
  return valores.map(csv).join(',') + '\n';
}

/** Nome de arquivo previsivel e sem acento, que o Windows aceita. */
function nomeDoArquivo(nomePaciente: string, q: ExportPatientQuery): string {
  const base = nomePaciente
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const inicio = q.from ? q.from.toISOString().slice(0, 10) : 'inicio';
  const fim = q.to ? q.to.toISOString().slice(0, 10) : 'hoje';
  return `vitalwatch-${base}-${q.type}-${inicio}_${fim}.${q.format}`;
}

function intervalo(campo: string, q: ExportPatientQuery): mongoose.FilterQuery<unknown> {
  if (!q.from && !q.to) return {};
  const faixa: Record<string, Date> = {};
  if (q.from) faixa.$gte = q.from;
  if (q.to) faixa.$lte = q.to;
  return { [campo]: faixa };
}

const COLUNAS_LEITURA = [
  'receivedAt',
  'banda',
  'bootAt',
  'uptimeMs',
  'posture',
  'inclination',
  'stable',
  'movementClass',
  'energy',
  'tremor',
  'tremorFreq',
  'odd',
  'fallDetected',
  'fallPhase',
  'fallCount',
  'panicActive',
  'panicCount',
  'batteryPct',
  'rssi',
];

const COLUNAS_ALERTA = [
  'firstSeenAt',
  'banda',
  'alertKey',
  'level',
  'status',
  'isLatched',
  'detail',
  'acknowledgedAt',
  'acknowledgedBy',
  'acknowledgedVia',
];

/**
 * Exporta os dados da pulseira de um paciente, em STREAM.
 *
 * Por que stream e nao JSON.stringify: a TTL guarda 30 dias de leituras, e o
 * firmware manda STATE a cada 2 s. Um paciente-mes sao ~1,3 milhao de linhas,
 * cerca de 155 MB de CSV. O Render free tem 512 MB de RAM: montar isso em
 * memoria antes de responder derruba o processo. Com cursor, a memoria fica
 * constante e nao importa o tamanho do intervalo.
 *
 * Consequencia de desenho: TUDO que pode falhar precisa falhar ANTES do
 * primeiro res.write(). Depois do cabecalho enviado nao existe mais como
 * devolver um erro JSON - o cliente receberia um CSV truncado sem explicacao.
 * Por isso paciente, pulseiras e autores dos alertas sao resolvidos primeiro.
 *
 * Devolve quantas linhas sairam, que e o que entra na trilha de acesso.
 */
export async function streamPatientExport(
  res: Response,
  patientId: Types.ObjectId,
  q: ExportPatientQuery,
): Promise<number> {
  const paciente = await Patient.findById(patientId).lean();
  if (!paciente) throw AppError.notFound('Paciente nao encontrado');

  // Os periodos de uso sao o que da sentido as linhas: a pulseira e do
  // hospital e o mesmo paciente pode ter usado duas no intervalo pedido.
  const assignments = await DeviceAssignment.find({ patientId }).sort({ assignedAt: 1 }).lean();
  const devices = await Device.find({ _id: { $in: assignments.map((a) => a.deviceId) } })
    .select('bandNumber deviceId')
    .lean();
  const bandaPorDevice = new Map(devices.map((d) => [String(d._id), d.bandNumber]));

  const precisaAlertas = q.type === 'alerts' || q.type === 'all';
  const alertas = precisaAlertas
    ? await Alert.find({ patientId, ...intervalo('firstSeenAt', q) })
        .sort({ firstSeenAt: 1 })
        .lean()
    : [];

  // Nomes de quem reconheceu: resolvidos agora, antes de abrir a resposta.
  const idsAck = [...new Set(alertas.map((a) => a.acknowledgedBy).filter((v) => v !== null))];
  const usuarios = await User.find({ _id: { $in: idsAck } })
    .select('name')
    .lean();
  const nomePorId = new Map(usuarios.map((u) => [String(u._id), u.name]));

  res.setHeader('Content-Disposition', `attachment; filename="${nomeDoArquivo(paciente.name, q)}"`);
  res.setHeader('Cache-Control', 'no-store');

  const linhaDeAlerta = (a: (typeof alertas)[number]) => [
    a.firstSeenAt,
    bandaPorDevice.get(String(a.deviceId)) ?? null,
    a.alertKey,
    a.level,
    a.status,
    a.isLatched,
    a.detail ?? null,
    a.acknowledgedAt ?? null,
    a.acknowledgedBy ? (nomePorId.get(String(a.acknowledgedBy)) ?? null) : null,
    a.acknowledgedVia ?? null,
  ];

  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // BOM no inicio: sem ele o Excel no Windows interpreta o arquivo como
    // latin-1 e os acentos dos nomes saem trocados.
    res.write('﻿');

    if (q.type === 'alerts') {
      res.write(linha(COLUNAS_ALERTA));
      for (const a of alertas) res.write(linha(linhaDeAlerta(a)));
      res.end();
      return alertas.length;
    }

    // readings e 'all': em CSV so cabe uma tabela, e a que importa e a de
    // leituras. Para os dois conjuntos juntos, use format=json.
    res.write(linha(COLUNAS_LEITURA));
    let contagem = 0;
    const cursor = Reading.find({ patientId, ...intervalo('receivedAt', q) })
      .sort({ receivedAt: 1 })
      .lean()
      .cursor();
    for await (const r of cursor) {
      res.write(
        linha([
          r.receivedAt,
          bandaPorDevice.get(String(r.deviceId)) ?? null,
          r.bootAt,
          r.uptimeMs,
          r.posture?.id,
          r.posture?.inclination,
          r.posture?.stable,
          r.movement?.class,
          r.movement?.energy,
          r.movement?.tremor,
          r.movement?.tremorFreq,
          r.movement?.odd,
          r.fall?.detected,
          r.fall?.phase,
          r.fall?.count,
          r.panic?.active,
          r.panic?.count,
          r.batteryPct,
          r.rssi,
        ]),
      );
      contagem++;
    }
    res.end();
    return contagem;
  }

  // JSON: o bloco meta vem primeiro, as leituras por ultimo, porque e o que
  // pode ser enorme - quem le em stream ja tem o contexto antes do volume.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.write('{\n');
  res.write(
    `"meta":${JSON.stringify({
      paciente: { id: String(paciente._id), nome: paciente.name },
      intervalo: { de: q.from ?? null, ate: q.to ?? null },
      geradoEm: new Date(),
      periodosDeUso: assignments.map((a) => ({
        banda: bandaPorDevice.get(String(a.deviceId)) ?? null,
        de: a.assignedAt,
        ate: a.releasedAt,
      })),
      aviso: 'Leituras cruas expiram 30 dias apos a coleta (TTL). Alertas nao expiram.',
    })},\n`,
  );

  res.write(
    `"alertas":${JSON.stringify(
      alertas.map((a) => ({
        firstSeenAt: a.firstSeenAt,
        lastSeenAt: a.lastSeenAt,
        banda: bandaPorDevice.get(String(a.deviceId)) ?? null,
        alertKey: a.alertKey,
        level: a.level,
        status: a.status,
        isLatched: a.isLatched,
        detail: a.detail ?? null,
        acknowledgedAt: a.acknowledgedAt ?? null,
        acknowledgedBy: a.acknowledgedBy ? (nomePorId.get(String(a.acknowledgedBy)) ?? null) : null,
      })),
    )},\n`,
  );

  res.write('"leituras":[');
  let contagem = 0;
  if (q.type !== 'alerts') {
    const cursor = Reading.find({ patientId, ...intervalo('receivedAt', q) })
      .sort({ receivedAt: 1 })
      .lean()
      .cursor();
    for await (const r of cursor) {
      res.write(
        (contagem > 0 ? ',' : '') +
          JSON.stringify({
            receivedAt: r.receivedAt,
            banda: bandaPorDevice.get(String(r.deviceId)) ?? null,
            bootAt: r.bootAt,
            uptimeMs: r.uptimeMs,
            posture: r.posture,
            movement: r.movement,
            fall: r.fall,
            panic: r.panic,
            batteryPct: r.batteryPct,
            rssi: r.rssi,
          }),
      );
      contagem++;
    }
  }
  res.write(`],\n"totalDeLeituras":${String(contagem)}\n}\n`);
  res.end();
  return contagem + alertas.length;
}

/**
 * Export dos dados do proprio usuario - portabilidade do art. 18 da LGPD.
 *
 * Nao e stream: sao poucas linhas por definicao, porque o usuario nao e o dono
 * da telemetria. Os dados da pulseira sao do PACIENTE, e saem pela rota do
 * paciente, por quem tem vinculo com ele.
 */
export async function exportSelf(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw AppError.notFound('Usuario nao encontrado');

  const links = await CareLink.find({ caregiverId: new Types.ObjectId(userId) })
    .populate<{ patientId: { _id: Types.ObjectId; name: string } }>('patientId', 'name')
    .lean();

  return {
    geradoEm: new Date(),
    usuario: {
      id: String(user._id),
      email: user.email,
      nome: user.name,
      telefone: user.phone ?? null,
      papeis: user.roles,
      status: user.status,
      criadoEm: user.createdAt,
      atualizadoEm: user.updatedAt,
    },
    vinculos: links.map((l) => ({
      paciente: (l.patientId as unknown as { name?: string }).name ?? null,
      relacao: l.relation,
      status: l.status,
      permissoes: l.permissions,
      criadoEm: l.createdAt,
      revogadoEm: l.revokedAt,
    })),
    // A propria trilha: o titular tem direito de saber o que foi registrado
    // sobre ele, inclusive os acessos que ele mesmo fez.
    meusAcessos: await acessosDoUsuario(userId),
    aviso:
      'Nao inclui senha (guardada apenas como hash bcrypt, irreversivel) nem telemetria: os dados da pulseira pertencem ao paciente e saem por GET /api/patients/:id/export.',
  };
}

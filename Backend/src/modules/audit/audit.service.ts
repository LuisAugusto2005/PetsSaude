import { Types } from 'mongoose';
import type { Request } from 'express';
import { logger } from '../../shared/logger.js';
import { paginated, type Pagination } from '../../shared/validation.js';
import { populado, type AccessAction } from '../../shared/types.js';
import { AccessLog } from './accessLog.model.js';

interface RegistroDeAcesso {
  action: AccessAction;
  patientId?: Types.ObjectId | null;
  detail?: string;
  resultCount?: number;
}

/**
 * Grava uma linha na trilha de acesso.
 *
 * Nunca derruba a requisicao: se o insert falhar, loga em nivel error e deixa
 * a resposta seguir. E uma troca consciente - uma enfermeira nao deve perder a
 * tela de alertas porque a auditoria esta indisponivel. O custo e que uma
 * falha de banco deixa buraco na trilha, e o log do servidor passa a ser a
 * unica pista; por isso o nivel e error, nao warn.
 */
export async function registrarAcesso(req: Request, registro: RegistroDeAcesso): Promise<void> {
  if (!req.user) return;
  try {
    await AccessLog.create({
      userId: new Types.ObjectId(req.user.id),
      patientId: registro.patientId ?? null,
      action: registro.action,
      detail: registro.detail,
      resultCount: registro.resultCount,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300),
      at: new Date(),
    });
  } catch (err) {
    logger.error({ err, action: registro.action }, 'Falha ao gravar trilha de acesso');
  }
}

/** Descreve um intervalo para o campo `detail`, em ISO ou "tudo". */
export function descreverIntervalo(from?: Date, to?: Date): string {
  if (!from && !to) return 'intervalo completo';
  const i = from ? from.toISOString() : 'inicio';
  const f = to ? to.toISOString() : 'agora';
  return `${i}..${f}`;
}

/** Quem acessou os dados deste paciente. */
export async function listAccessLog(patientId: Types.ObjectId, query: Pagination) {
  const skip = (query.page - 1) * query.limit;
  const [linhas, total] = await Promise.all([
    AccessLog.find({ patientId })
      .sort({ at: -1 })
      .skip(skip)
      .limit(query.limit)
      .populate<{ userId: { _id: Types.ObjectId; name: string; email: string } }>(
        'userId',
        'name email',
      ),
    AccessLog.countDocuments({ patientId }),
  ]);

  return paginated(
    linhas.map((l) => {
      const quem = populado<{ _id: Types.ObjectId; name: string; email: string }>(l.userId);
      return {
        id: String(l._id),
        at: l.at,
        action: l.action,
        detail: l.detail ?? null,
        resultCount: l.resultCount ?? null,
        ip: l.ip ?? null,
        quem: { id: quem._id, nome: quem.name, email: quem.email },
      };
    }),
    total,
    query,
  );
}

/** O que este usuario acessou. Entra no export dos proprios dados (LGPD). */
export async function acessosDoUsuario(userId: string, limite = 500) {
  const linhas = await AccessLog.find({ userId: new Types.ObjectId(userId) })
    .sort({ at: -1 })
    .limit(limite)
    .lean();

  return linhas.map((l) => ({
    at: l.at,
    action: l.action,
    patientId: l.patientId ? String(l.patientId) : null,
    detail: l.detail ?? null,
  }));
}

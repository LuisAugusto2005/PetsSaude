import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../shared/AppError.js';
import { isProduction } from '../config/env.js';
import { logger } from '../shared/logger.js';

/** Mapeia o nome do indice unico violado para uma mensagem util. */
const DUPLICATE_KEY_MESSAGES: Record<string, string> = {
  email_1: 'Este e-mail ja esta cadastrado',
  // Indice parcial de Patient.userId: um User nao pode ser paciente duas vezes.
  userId_1: 'Este usuario ja esta ligado a um paciente',
  bandNumber_1: 'Ja existe uma pulseira com este numero',
  deviceId_1: 'Ja existe uma pulseira com este device_id',
  carelink_unico_ativo: 'Este cuidador ja possui um vinculo ativo deste tipo com o paciente',
  device_um_assignment_aberto: 'Esta pulseira ja esta atribuida a um paciente',
  paciente_um_assignment_aberto: 'Este paciente ja esta usando uma pulseira',
  alerta_ocorrencia_unica: 'Esta ocorrencia de alerta ja foi registrada',
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Rota nao encontrada: ${req.method} ${req.originalUrl}`));
};

/**
 * Erro vindo do body-parser: JSON malformado, corpo grande demais, charset
 * desconhecido. Ele marca o proprio objeto com `type` e `status`.
 */
interface ErroDeCorpo extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

const MENSAGENS_DE_CORPO: Record<string, { status: number; codigo: string; mensagem: string }> = {
  'entity.parse.failed': {
    status: 400,
    codigo: 'JSON_INVALIDO',
    mensagem:
      'O corpo nao e um JSON valido. Causas comuns: virgula sobrando antes do ultimo } ou ], aspas simples no lugar de duplas, ou campo sem aspas.',
  },
  'entity.too.large': {
    status: 413,
    codigo: 'PAYLOAD_TOO_LARGE',
    mensagem: 'Corpo grande demais. O limite e 256 kB.',
  },
  'encoding.unsupported': {
    status: 415,
    codigo: 'UNSUPPORTED_MEDIA_TYPE',
    mensagem: 'Codificacao de conteudo nao suportada.',
  },
  'charset.unsupported': {
    status: 415,
    codigo: 'UNSUPPORTED_MEDIA_TYPE',
    mensagem: 'Charset nao suportado. Use UTF-8.',
  },
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Antes de tudo: erro de parse do corpo e culpa do cliente, nao do servidor.
  // Sem este ramo, uma virgula sobrando no JSON virava 500 com stack trace -
  // o status errado, e, fora de producao, caminho de arquivo na resposta.
  if (err instanceof Error && typeof (err as ErroDeCorpo).type === 'string') {
    const conhecido = MENSAGENS_DE_CORPO[(err as ErroDeCorpo).type ?? ''];
    if (conhecido) {
      res.status(conhecido.status).json({
        erro: { codigo: conhecido.codigo, mensagem: conhecido.mensagem },
      });
      return;
    }
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      erro: { codigo: err.code, mensagem: err.message, detalhes: err.details },
    });
    return;
  }

  // Zod que escapou do middleware validate (ex.: parse dentro de um service).
  if (err instanceof ZodError) {
    res.status(400).json({
      erro: {
        codigo: 'BAD_REQUEST',
        mensagem: 'Dados invalidos',
        detalhes: err.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })),
      },
    });
    return;
  }

  // Violacao de indice unico: 409, nunca 500.
  if (
    err instanceof mongoose.mongo.MongoServerError &&
    (err.code === 11000 || err.code === 11001)
  ) {
    const indexName = typeof err.message === 'string' ? extractIndexName(err.message) : undefined;
    res.status(409).json({
      erro: {
        codigo: 'CONFLICT',
        mensagem: (indexName && DUPLICATE_KEY_MESSAGES[indexName]) ?? 'Registro duplicado',
        detalhes: { indice: indexName },
      },
    });
    return;
  }

  if (err instanceof mongoose.Error.ValidationError) {
    res.status(422).json({
      erro: {
        codigo: 'UNPROCESSABLE_ENTITY',
        mensagem: 'Documento invalido',
        detalhes: Object.values(err.errors).map((e) => ({ campo: e.path, mensagem: e.message })),
      },
    });
    return;
  }

  // ObjectId malformado na URL.
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      erro: { codigo: 'BAD_REQUEST', mensagem: `Valor invalido para "${err.path}"` },
    });
    return;
  }

  logger.error({ err }, 'Erro nao tratado');
  res.status(500).json({
    erro: {
      codigo: 'INTERNAL_ERROR',
      mensagem: 'Erro interno do servidor',
      ...(isProduction ? {} : { detalhes: String(err instanceof Error ? err.stack : err) }),
    },
  });
};

function extractIndexName(message: string): string | undefined {
  return /index: (\S+)/.exec(message)?.[1];
}

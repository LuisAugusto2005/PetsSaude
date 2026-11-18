import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../shared/AppError.js';

interface ValidationSchemas {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

/**
 * Valida e SUBSTITUI req.body/params/query pelo resultado do parse, para que os
 * controllers recebam dados ja coagidos e sem campos extras.
 *
 * No Express 5, req.query tem apenas getter, por isso a reatribuicao usa
 * defineProperty em vez de assign direto.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const key of ['body', 'params', 'query'] as const) {
      const schema = schemas[key];
      if (!schema) continue;

      const result = schema.safeParse(req[key]);
      if (!result.success) {
        const details = result.error.issues.map((issue) => ({
          campo: issue.path.join('.'),
          mensagem: issue.message,
        }));
        return next(AppError.badRequest(`Dados invalidos em "${key}"`, details));
      }

      Object.defineProperty(req, key, {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    next();
  };
}

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * O Express 5 ja repassa rejeicoes de promise para o errorHandler, mas o tipo
 * de RequestHandler nao aceita um retorno Promise<void> sem reclamar. Este
 * wrapper mantem os handlers async tipados e explicita a intencao.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

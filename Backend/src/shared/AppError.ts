/**
 * Erro de dominio com status HTTP. Qualquer coisa lancada que nao seja um
 * AppError vira 500 generico no errorHandler, sem vazar stack para o cliente.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Credenciais ausentes ou invalidas') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'Sem permissao para acessar este recurso') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  /**
   * 403 com codigo proprio: o app precisa distinguir "aguarde aprovacao" de
   * "sua conta foi desligada". Um 401 generico viraria "senha incorreta" na
   * tela, e quem acabou de se cadastrar ligaria para o suporte.
   */
  static accountPending() {
    return new AppError(
      403,
      'ACCOUNT_PENDING',
      'Sua conta aguarda aprovacao da administracao. Voce sera avisado quando for liberada.',
    );
  }

  static accountDisabled() {
    return new AppError(
      403,
      'ACCOUNT_DISABLED',
      'Esta conta foi desativada. Procure a administracao.',
    );
  }

  static notFound(message = 'Recurso nao encontrado') {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }

  static unprocessable(message: string, details?: unknown) {
    return new AppError(422, 'UNPROCESSABLE_ENTITY', message, details);
  }
}

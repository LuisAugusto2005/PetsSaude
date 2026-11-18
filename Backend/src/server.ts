import { createApp } from './app.js';
import { env, isProduction } from './config/env.js';
import { ensureBootstrapAdmin } from './db/bootstrapAdmin.js';
import { connectDatabase, disconnectDatabase, syncIndexes } from './db/connect.js';
import { logger } from './shared/logger.js';

async function main(): Promise<void> {
  await connectDatabase();
  // Em producao autoIndex esta desligado, entao sincronizamos uma vez no boot.
  if (isProduction) await syncIndexes();
  // Antes de ouvir: sem admin, ninguem aprova conta de enfermagem.
  await ensureBootstrapAdmin();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`VitalWatch API ouvindo em http://localhost:${env.PORT} (${env.NODE_ENV})`);
    logger.info(`Documentacao em http://localhost:${env.PORT}/docs`);
  });

  // O Render manda SIGTERM no deploy: fechar direito evita request cortada.
  const shutdown = (signal: string) => {
    logger.info(`${signal} recebido, encerrando...`);
    server.close(() => {
      void disconnectDatabase().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Falha ao iniciar o servidor');
  process.exit(1);
});

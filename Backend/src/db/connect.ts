import mongoose from 'mongoose';
import { env, isProduction } from '../config/env.js';
import { logger } from '../shared/logger.js';

mongoose.set('strictQuery', true);
// Em dev e teste deixamos o Mongoose criar os indices; em producao isso e
// perigoso (bloqueia a colecao), entao usamos syncIndexes manual no deploy.
mongoose.set('autoIndex', !isProduction);

export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<void> {
  mongoose.connection.on('connected', () => logger.info('Mongo conectado'));
  mongoose.connection.on('disconnected', () => logger.warn('Mongo desconectado'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'Erro no Mongo'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}

/**
 * Cria/atualiza os indices de todos os models registrados. Chamado no boot em
 * producao, onde autoIndex esta desligado.
 */
export async function syncIndexes(): Promise<void> {
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes();
  }
  logger.info({ models: mongoose.modelNames() }, 'Indices sincronizados');
}

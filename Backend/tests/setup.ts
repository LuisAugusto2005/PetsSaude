import { afterAll, afterEach, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * As variaveis tem de existir ANTES de src/config/env.ts ser importado, que e
 * o que acontece quando o arquivo de teste importa a app. setupFiles roda
 * antes dos imports do teste, por isso o lugar e aqui.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'segredo-de-teste-apenas-para-access-token-0001';
process.env.JWT_REFRESH_SECRET = 'segredo-de-teste-apenas-para-refresh-token-002';
process.env.ACCESS_TOKEN_TTL = '15m';
process.env.REFRESH_TOKEN_TTL = '30d';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder-substituido-no-beforeAll';
process.env.LOG_LEVEL = 'fatal';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('vitalwatch-test'));
  // Os indices unicos parciais sao parte do que estamos testando (um
  // assignment aberto por pulseira, um vinculo ativo por cuidador), entao
  // precisam existir de fato antes dos testes rodarem.
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

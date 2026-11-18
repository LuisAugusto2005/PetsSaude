/**
 * Cria e atualiza os indices de todas as colecoes, sem tocar em dados.
 *
 * Util num banco novo (Atlas recem-criado) e depois de mudar um schema. Em
 * producao o autoIndex do Mongoose fica desligado, porque criar indice bloqueia
 * a colecao, e o boot do servidor ja chama isto uma vez; este script existe
 * para rodar sob demanda, de fora do deploy.
 *
 * Nao apaga nada. Para popular dados de demonstracao, use `npm run seed`.
 *
 * Uso: npm run sync-indexes
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase, syncIndexes } from '../src/db/connect.js';
import '../src/db/models.js';

async function main() {
  await connectDatabase();
  await syncIndexes();

  for (const nome of mongoose.modelNames()) {
    const indices = await mongoose.model(nome).collection.indexes();
    const uteis = indices.filter((i) => i.name !== '_id_');
    const marcas = [
      uteis.some((i) => i.expireAfterSeconds !== undefined) ? 'TTL' : null,
      uteis.some((i) => i.partialFilterExpression) ? 'parcial' : null,
      uteis.some((i) => i.unique) ? 'unico' : null,
    ].filter(Boolean);
    console.log(
      `  ${nome.padEnd(18)} ${String(uteis.length).padStart(2)} indice(s)` +
        (marcas.length ? `  [${marcas.join(', ')}]` : ''),
    );
  }
}

main()
  .then(() => disconnectDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await mongoose.connection.close().catch(() => undefined);
    process.exit(1);
  });

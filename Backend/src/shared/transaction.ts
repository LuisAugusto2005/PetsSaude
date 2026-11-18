import mongoose from 'mongoose';

/**
 * Roda a funcao numa transacao quando o Mongo suporta (replica set, caso do
 * Atlas), e direto quando nao suporta (Mongo standalone no dev local e o
 * mongodb-memory-server dos testes).
 *
 * Sem este fallback, cadastrar usuario ou paciente quebraria em qualquer
 * maquina que nao rode replica set, o que seria um custo de setup absurdo
 * para um projeto de prototipo.
 */
export async function withOptionalTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } catch (err) {
    if (!semSuporteATransacao(err)) throw err;
    return fn(null);
  } finally {
    await session.endSession();
  }
}

function semSuporteATransacao(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return (
    message.includes('Transaction numbers are only allowed') ||
    message.includes('replica set') ||
    message.includes('Transactions are not supported') ||
    message.includes('not supported')
  );
}

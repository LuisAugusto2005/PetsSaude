import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    // Um Mongo em memoria por arquivo: isola os testes entre si, ao custo de
    // alguns segundos de subida. Sem isso os arquivos disputam as colecoes.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

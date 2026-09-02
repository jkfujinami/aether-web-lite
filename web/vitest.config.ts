import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    // libsodium の WASM 初期化と Argon2id の PoW 探索に時間がかかるため長めに取る
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/server/**/*.ts'],
      exclude: ['src/lib/worker/pow.worker.ts'],
    },
  },
});

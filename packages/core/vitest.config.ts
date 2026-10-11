import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: process.env.RUN_SIM ? ['**/node_modules/**', '**/dist/**'] : ['**/node_modules/**', '**/dist/**', 'tests/simulation/**'],
  },
});

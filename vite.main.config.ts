import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron', 'better-sqlite3', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
    sourcemap: true,
  },
});

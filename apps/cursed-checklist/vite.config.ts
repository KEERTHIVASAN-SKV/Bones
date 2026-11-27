// apps/cursed-checklist/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The kernel and the coordinator core are imported from source through aliases (no publishing).
    alias: {
      '@bones/kernel': path.resolve(import.meta.dirname, '../../kernel/src/index.ts'),
      '@bones/coordinator': path.resolve(import.meta.dirname, '../../coordinator/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      // Two pages in ONE build, so they share an origin (BroadcastChannel does not cross origins):
      // the app, and the control page that runs the coordinator.
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        control: path.resolve(import.meta.dirname, 'control.html'),
      },
    },
  },
});

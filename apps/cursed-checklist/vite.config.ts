// apps/cursed-checklist/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@bones/kernel': path.resolve(__dirname, '../../kernel/src/index.ts') },
  },
});

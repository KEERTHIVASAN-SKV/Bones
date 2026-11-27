// apps/cursed-checklist/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Where the app is served from. '/' for the dev server and for a root deploy; the Pages workflow sets
// BASE_PATH to the app's sub-path (for example '/Bones/cursed-checklist/'). It must start and end with '/'.
const base = process.env.BASE_PATH ?? '/';
// Each segment: letters, digits, ".", "_", "-", but not only dots ("." and ".." are path steps, not names).
if (!/^\/((?!\.+\/)[A-Za-z0-9._-]+\/)*$/.test(base)) {
  throw new Error(`BASE_PATH must start and end with "/", with name segments of letters, digits, ".", "_", "-": got "${base}"`);
}

export default defineConfig({
  base,
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

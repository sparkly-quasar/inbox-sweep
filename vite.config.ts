/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  // Baked in at build time so the app can show which version is running. There
  // is no auto-updater, so this is how you tell whether you're behind.
  define: { __APP_VERSION__: JSON.stringify(version) },
  // host: true so the dev server is reachable from a phone on the same network.
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

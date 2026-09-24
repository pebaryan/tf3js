/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        // Keep the large, rarely-changing engine libraries in their own cacheable chunks
        manualChunks: {
          three: ['three'],
          physics: ['cannon-es'],
        },
      },
    },
    // three.js alone is ~500 kB minified; that's expected for a WebGL game
    chunkSizeWarningLimit: 700,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        wip: resolve(__dirname, 'wip.html'),
      },
      output: {
        // Two stable boundaries: the translation dictionaries change on their own cadence and every
        // browser-facing library is shared by the entry; app-specific screens stay in the entry chunk.
        manualChunks(id) {
          if (id.includes('/src/lib/translations/')) return 'i18n-dicts';
          if (id.includes('/src/lib/') && !id.includes('/src/lib/wip/')) return 'app-lib';
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4789',
        changeOrigin: true,
      },
    },
  },
});

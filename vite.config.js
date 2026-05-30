import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'fs-extra': path.resolve(__dirname, 'js/mocks/fs-extra.js'),
    },
  },
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    {
      name: 'clean-urls-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url) {
            const url = new URL(req.url, 'http://localhost');
            const pathname = url.pathname;
            if (pathname === '/') {
              req.url = '/pages/index.html' + url.search;
            } else {
              const lastSegment = pathname.split('/').pop() || '';
              if (!lastSegment.includes('.') && !pathname.startsWith('/@')) {
                req.url = '/pages' + pathname + '.html' + url.search;
              }
            }
          }
          next();
        });
      }
    }
  ],
  server: {
    port: 5173,
    open: false
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'pages/index.html'),
        editor: path.resolve(__dirname, 'pages/editor.html'),
        templates: path.resolve(__dirname, 'pages/templates.html'),
        privacy: path.resolve(__dirname, 'pages/privacy.html'),
        terms: path.resolve(__dirname, 'pages/terms.html'),
      }
    }
  }
});

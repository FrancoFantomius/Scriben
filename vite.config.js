import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionlessPages = ['editor', 'privacy', 'terms'];

function extensionlessRoutes() {
  const handleRequest = (req, res, next) => {
    if (!req.url) {
      next();
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/index.html') {
      res.statusCode = 301;
      res.setHeader('Location', `/${url.search}`);
      res.end();
      return;
    }

    const htmlPage = extensionlessPages.find(page => url.pathname === `/${page}.html`);

    if (htmlPage) {
      res.statusCode = 301;
      res.setHeader('Location', `/${htmlPage}${url.search}`);
      res.end();
      return;
    }

    const extensionlessPage = extensionlessPages.find(page => url.pathname === `/${page}`);

    if (extensionlessPage) {
      req.url = `/${extensionlessPage}.html${url.search}`;
    }

    next();
  };

  return {
    name: 'extensionless-routes',
    configureServer(server) {
      server.middlewares.use(handleRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleRequest);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_redirects',
        source: [
          '/index.html / 301',
          ...extensionlessPages.map(page => `/${page}.html /${page} 301`),
        ].join('\n') + '\n',
      });
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      'fs-extra': path.resolve(__dirname, 'js/mocks/fs-extra.js'),
    },
  },
  plugins: [
    extensionlessRoutes(),
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
  ],
  server: {
    port: 5173,
    open: false
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        editor: path.resolve(__dirname, 'editor.html'),
        privacy: path.resolve(__dirname, 'privacy.html'),
        terms: path.resolve(__dirname, 'terms.html'),
      }
    }
  }
});

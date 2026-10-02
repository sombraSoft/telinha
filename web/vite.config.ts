import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// Dev only: "/" goes to the room page, like Caddy's catch-all in production.
function rootRedirect(): Plugin {
  return {
    name: 'telinha-root-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/';
        if (url !== '/' && !url.startsWith('/?')) return next();
        res.statusCode = 302;
        res.setHeader('Location', `/sala/${url.slice(1)}`);
        res.end();
      });
    },
  };
}

export default defineConfig({
  base: '/sala/',
  plugins: [svelte(), rootRedirect()],
  // livekit-client alone is ~450 kB minified; one chunk is fine for this page.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': 'http://127.0.0.1:8081',
      // LiveKit signaling; the token's url points at this proxy in dev.
      '/livekit': {
        target: 'http://127.0.0.1:7880',
        ws: true,
        rewrite: (path) => path.replace(/^\/livekit/, '') || '/',
      },
    },
  },
});

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// Dev only, like telinha in production: "/" goes to the room page's landing at /r/.
function rootRedirect(): Plugin {
  return {
    name: 'telinha-root-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (new URL(req.url ?? '/', 'http://dev').pathname !== '/') return next();
        res.statusCode = 302;
        res.setHeader('Location', '/r/');
        res.end();
      });
    },
  };
}

export default defineConfig({
  // Absolute /r/assets/... URLs, so they load from /r/<code> too.
  base: '/r/',
  plugins: [svelte(), rootRedirect()],
  // livekit-client alone is ~450 kB minified; one chunk is fine for this page.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    // Two pages under /r/: the room page and the phone test (served at /doctor).
    // livekit-client becomes a chunk both share in assets/.
    rolldownOptions: { input: { index: 'index.html', doctor: 'doctor.html' } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': 'http://127.0.0.1:8081',
      // LiveKit signaling goes through telinha, which strips the /livekit prefix itself.
      '/livekit': { target: 'http://127.0.0.1:8081', ws: true },
    },
  },
});

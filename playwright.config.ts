// E2E against the production-like stack (`bun scripts/stack.ts --e2e`): the
// built page served by the Bun server at /r/, the server's own livekit-server
// child, LiveKit signaling through its gated /livekit relay, DEV_USER fake login.
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  // Only *.e2e.ts: bun test would also pick up *.spec.ts.
  testMatch: '**/*.e2e.ts',
  // The streaming spec waits on LiveKit's bandwidth ramp-up; 30 s default is too tight.
  timeout: 90_000,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8081',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            // The stack's LiveKit (LIVEKIT_NODE_IP=127.0.0.1) only offers 127.0.0.1
            // candidates. Linux Chromium gathers no loopback candidates and hides
            // host IPs behind mDNS, so ICE never connects there without these
            // (Windows got by without them).
            '--allow-loopback-in-peer-connection',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'bun scripts/stack.ts --e2e',
    url: 'http://127.0.0.1:8081/healthz',
    reuseExistingServer: !CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // The default is SIGKILL, which the server's livekit-server (own session on
    // Linux) survives, holding 7880-7882 for the next run. SIGTERM lets stack.ts
    // and the server stop it. Ignored on Windows, where taskkill /T takes the tree.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});

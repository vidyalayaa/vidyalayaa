import { test as base } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import theme from '../../../apps/web/tailwind.config.js';

// A disconnected preview must stay disconnected even on a configured developer machine.
export const test = base.extend<{}, { previewAppURL: string }>({
  baseURL: async ({ previewAppURL }, use) => use(previewAppURL),
  previewAppURL: [
    async ({ browser }, use, workerInfo) => {
      const root = fileURLToPath(new URL('../../../apps/web', import.meta.url));
      const contentRoot = root.replaceAll('\\', '/');
      const server = await createServer({
        root,
        cacheDir: fileURLToPath(
          new URL(
            `../../../node_modules/.vite-audit/preview-app-${workerInfo.parallelIndex}`,
            import.meta.url,
          ),
        ),
        envFile: false,
        define: Object.fromEntries(
          ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_API_URL'].map((name) => [
            `import.meta.env.${name}`,
            JSON.stringify(''),
          ]),
        ),
        css: {
          postcss: {
            plugins: [
              tailwindcss({
                presets: [theme],
                content: [`${contentRoot}/index.html`, `${contentRoot}/src/**/*.{ts,tsx}`],
              }),
              autoprefixer(),
            ],
          },
        },
        server: { host: '127.0.0.1', port: 5210 + workerInfo.parallelIndex, strictPort: true },
      });
      await server.listen();
      await Promise.all(
        [
          '/src/main.tsx',
          '/src/features/auth/Login.tsx',
          '/src/features/resources/ResourceScreen.tsx',
        ].map((path) => server.warmupRequest(path)),
      );
      // Each fixture/worker has its own dependency cache. Finish the initial
      // browser dependency load outside individual workflow timing.
      const warmContext = await browser.newContext();
      try {
        const warmPage = await warmContext.newPage();
        await warmPage.route('https://mfa-qr.test/**', (route) => route.abort());
        await warmPage.goto(`http://127.0.0.1:${5210 + workerInfo.parallelIndex}/login`, {
          waitUntil: 'load',
          timeout: 90000,
        });
        await warmPage.getByRole('heading', { level: 1 }).first().waitFor();
      } finally {
        await warmContext.close();
      }
      try {
        await use(`http://127.0.0.1:${5210 + workerInfo.parallelIndex}`);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker', timeout: 120000 },
  ],
});

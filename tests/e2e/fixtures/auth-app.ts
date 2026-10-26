import { test as base } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import theme from '../../../apps/web/tailwind.config.js';

// Auth regressions use isolated servers and browser contexts, never local credentials
// or a real Supabase project. Tests intercept the .test provider's network requests.
export const test = base.extend<{ isolateServices: void }, { authAppURL: string }>({
  isolateServices: [
    async ({ page }, use) => {
      await page.route('**/api/v1/**', (route) =>
        route.fulfill(
          ['/invitations/pending', '/support-access'].some((path) =>
            new URL(route.request().url()).pathname.endsWith(path),
          )
            ? { json: { data: [] } }
            : {
                status: 501,
                json: { error: { message: 'This API request needs an explicit test fixture.' } },
              },
        ),
      );
      await use();
    },
    { auto: true },
  ],
  authAppURL: [
    async ({ browser }, use, workerInfo) => {
      const root = fileURLToPath(new URL('../../../apps/web', import.meta.url));
      const contentRoot = root.replaceAll('\\', '/');
      const server = await createServer({
        root,
        cacheDir: fileURLToPath(
          new URL(
            `../../../node_modules/.vite-audit/auth-app-${workerInfo.parallelIndex}`,
            import.meta.url,
          ),
        ),
        envFile: false,
        define: {
          'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://mfa-qr.test'),
          'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-only-public-key'),
          'import.meta.env.VITE_API_URL': JSON.stringify(''),
        },
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
        server: { host: '127.0.0.1', port: 5187 + workerInfo.parallelIndex, strictPort: true },
      });
      await server.listen();
      // Compile lazy entry screens before starting timed browser assertions.
      // This avoids testing Vite's cold transform speed on busy CI hosts.
      await Promise.all(
        [
          '/src/main.tsx',
          '/src/features/auth/Login.tsx',
          '/src/features/resources/ResourceScreen.tsx',
          '/src/features/operations/Screens.tsx',
          '/src/features/operations/Platform.tsx',
          '/src/features/calendar/SchoolCalendar.tsx',
          '/src/features/calendar/EventForm.tsx',
          '/src/features/dashboard/Dashboard.tsx',
          '/src/features/parents/ParentWorkspace.tsx',
          '/src/features/parents/ParentAttendance.tsx',
          '/src/features/parents/ParentResults.tsx',
          '/src/features/parents/ParentInsightsControls.tsx',
          '/src/features/parents/ResultCharts.tsx',
          '/src/features/results/SchoolResults.tsx',
          '/src/features/timetable/Timetable.tsx',
          '/src/features/fees/Fees.tsx',
          '/src/features/notifications/Notifications.tsx',
        ].map((path) => server.warmupRequest(path)),
      );
      const address = server.httpServer!.address();
      if (!address || typeof address === 'string')
        throw new Error('Auth test server did not start.');
      // Each fixture/worker has its own dependency cache. Finish the initial
      // browser dependency load outside individual workflow timing.
      const warmContext = await browser.newContext();
      try {
        const warmPage = await warmContext.newPage();
        await warmPage.route('https://mfa-qr.test/**', (route) => route.abort());
        await warmPage.goto(`http://127.0.0.1:${address.port}/login`, {
          waitUntil: 'load',
          timeout: 90000,
        });
        await warmPage.getByRole('heading', { level: 1 }).first().waitFor();
      } finally {
        await warmContext.close();
      }
      try {
        await use(`http://127.0.0.1:${address.port}`);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker', timeout: 120000 },
  ],
});

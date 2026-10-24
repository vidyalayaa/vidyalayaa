import { it, expect, vi, afterEach } from 'vitest';
const provider = vi.hoisted(() => ({ send: vi.fn(async () => 'fixture-fcm-message') }));
vi.mock('firebase-admin/app', () => ({
  getApps: () => [{}],
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));
vi.mock('firebase-admin/messaging', () => ({ getMessaging: () => provider }));
import { deliver } from '../../apps/worker/src/providers.js';
afterEach(() => {
  vi.unstubAllEnvs();
  provider.send.mockClear();
});
it('uses FCM v1 with custom content, a stable device-delivery tag and an authenticated application link', async () => {
  vi.stubEnv('PUBLIC_WEB_URL', 'https://school.example');
  await deliver(
    'PUSH',
    'fixture-registration-token',
    'Please open the school message.',
    'delivery:device',
    { title: 'School reminder', school_id: 'school-id' },
  );
  expect(provider.send).toHaveBeenCalledWith({
    token: 'fixture-registration-token',
    notification: { title: 'School reminder', body: 'Please open the school message.' },
    data: { delivery_id: 'delivery:device', school_id: 'school-id' },
    webpush: {
      notification: { tag: 'delivery:device' },
      fcmOptions: { link: 'https://school.example/notifications' },
    },
  });
});
it('leaves HTTP localhost click handling to the first-party worker instead of sending an invalid HTTP FCM link', async () => {
  vi.stubEnv('PUBLIC_WEB_URL', 'http://localhost:5173');
  await deliver('PUSH', 'fixture-registration-token', 'School message', 'fixture-delivery');
  expect(provider.send.mock.calls[0][0].webpush).not.toHaveProperty('fcmOptions');
});

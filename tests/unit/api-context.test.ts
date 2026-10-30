import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const session = (id: string) => ({
  data: { session: { user: { id }, access_token: 'fixture-' + id } },
});
let getSession: ReturnType<typeof vi.fn>,
  refreshSession: ReturnType<typeof vi.fn>,
  fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://context-fixture.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'publishable-fixture');
  vi.stubGlobal('window', {
    location: { href: 'https://school.test/' },
    history: { replaceState: vi.fn() },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal('sessionStorage', { getItem: () => 'school-a', removeItem: vi.fn() });
  getSession = vi.fn().mockResolvedValue(session('owner'));
  refreshSession = vi.fn();
  fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ saved: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({ auth: { getSession, refreshSession } }),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock('@supabase/supabase-js');
  vi.resetModules();
});
it('prevents a queued write if the account or school is no longer the original context', async () => {
  const { api } = await import('../../apps/web/src/lib/auth');
  for (const expected of [
    { userId: 'other', schoolId: 'school-a' },
    { userId: 'owner', schoolId: 'school-b' },
  ])
    await expect(api('/marks/entry', {}, true, 'json', expected)).rejects.toMatchObject({
      code: 'CONTEXT_CHANGED',
    });
  expect(fetcher).not.toHaveBeenCalled();
});
it('sends a queued write only using its matching current identity and school', async () => {
  const { api } = await import('../../apps/web/src/lib/auth');
  await expect(
    api('/marks/entry', { method: 'POST', body: '{}' }, true, 'json', {
      userId: 'owner',
      schoolId: 'school-a',
    }),
  ).resolves.toEqual({ saved: 1 });
  const headers = fetcher.mock.calls[0][1].headers as Headers;
  expect(headers.get('X-School-Id')).toBe('school-a');
  expect(headers.get('Authorization')).toBe('Bearer fixture-owner');
});
it('keeps the original identity guard on authentication refresh retries', async () => {
  getSession
    .mockReset()
    .mockResolvedValueOnce(session('owner'))
    .mockResolvedValueOnce(session('owner'))
    .mockResolvedValueOnce(session('owner'))
    .mockResolvedValue(session('other'));
  refreshSession.mockResolvedValue(session('owner'));
  fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 }),
  );
  const { api } = await import('../../apps/web/src/lib/auth');
  await expect(
    api('/marks/entry', {}, true, 'json', { userId: 'owner', schoolId: 'school-a' }),
  ).rejects.toMatchObject({ code: 'CONTEXT_CHANGED' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('sends a verified single-school implicit request without falsely reporting a school change', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => '', removeItem: vi.fn() });
  const { marksRequestContext } = await import('../../apps/web/src/lib/marks-request-context');
  const membership = {
    school_id: 'school-a',
    school_name: 'A',
    timezone: 'Asia/Kolkata',
    role: 'school_admin' as const,
    permissions: ['marks.write'],
  };
  const { api } = await import('../../apps/web/src/lib/auth');
  await expect(
    api(
      '/marks/entry',
      { method: 'POST', body: '{}' },
      true,
      'json',
      marksRequestContext(
        { id: 'owner', school: membership, memberships: [membership] },
        'owner',
        'school-a',
        '',
      ),
    ),
  ).resolves.toEqual({ saved: 1 });
  expect((fetcher.mock.calls[0][1].headers as Headers).has('X-School-Id')).toBe(false);
});

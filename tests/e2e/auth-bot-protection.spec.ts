import { expect } from '@playwright/test';
import { test } from './fixtures/auth-app';

test.use({ turnstileSiteKey: 'fixture-site-key' });

test('gates password and email requests and shares the resend cooldown', async ({
  page,
  authAppURL,
}) => {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.turnstile = {
        render(host, options) {
          if (options.appearance !== 'always') throw new Error('Expected a visible widget');
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Complete test security check';
          button.onclick = () => options.callback('fixture-captcha-token');
          host.append(button);
          return 'fixture-widget';
        },
        remove() {},
      };`,
    }),
  );
  const requests: string[] = [];
  await page.route('https://mfa-qr.test/auth/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/').pop()!;
    if (path === 'settings') {
      requests.push(path);
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      return;
    }
    if (path === 'verify') expect(request.postDataJSON().type).toBe('email');
    else
      expect(request.postDataJSON().gotrue_meta_security.captcha_token).toBe(
        'fixture-captcha-token',
      );
    requests.push(path);
    await route.fulfill(
      path === 'token' || path === 'verify'
        ? { status: 429, json: { code: 'over_request_rate_limit', message: 'Rate limited' } }
        : { json: {} },
    );
  });
  await page.goto(`${authAppURL}/login`);
  await page.getByLabel('Email address').fill('student@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-only-password');
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(signIn).toBeDisabled();
  const check = page.getByRole('button', { name: 'Complete test security check' });
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeDisabled();
  await check.click();
  await google.click();
  await expect(page.getByRole('alert')).toHaveText(
    'Could not start Google sign-in. Please try again.',
  );
  await expect(google).toBeDisabled();
  await check.click();
  await signIn.click();
  await expect(page.getByRole('alert')).toHaveText('Too many attempts. Wait before trying again.');
  await expect(signIn).toBeDisabled();

  await page.getByRole('button', { name: 'Forgot password?' }).click();
  const recover = page.getByRole('button', { name: 'Send recovery link' });
  await expect(recover).toBeDisabled();
  await check.click();
  await recover.click();
  await expect(page.getByRole('button', { name: /Send again in/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Back to sign in' }).click();
  const details = page.locator('details').filter({ hasText: 'Sign in with an email link or code' });
  await details.locator('summary').click();
  const send = details.getByRole('button', { name: 'Send sign-in email' });
  await expect(send).toBeDisabled();
  expect(requests).toEqual(['settings', 'token', 'recover']);
  // Start a clean tab session without waiting for the production cooldown.
  await page.evaluate(() => sessionStorage.removeItem('vidyalayaa.auth-email-cooldown'));
  await page.reload();
  await details.locator('summary').click();
  await details.getByLabel('Email for sign-in link').fill('student@example.test');
  await expect(send).toBeDisabled();
  await details.getByRole('button', { name: 'Complete test security check' }).click();
  await send.click();
  await expect(details.getByLabel('Email sign-in code')).toBeVisible();
  await expect(details.getByRole('button', { name: 'Request a new email' })).toBeDisabled();
  await details.getByLabel('Email sign-in code').fill('123456');
  const verify = details.getByRole('button', { name: 'Verify sign-in code' });
  await expect(verify).toBeDisabled();
  await details.getByRole('button', { name: 'Complete test security check' }).click();
  await verify.click();
  await expect(details.getByRole('alert')).toHaveText(
    'Too many attempts. Wait before trying again.',
  );
  await expect(verify).toBeDisabled();
  expect(requests).toEqual(['settings', 'token', 'recover', 'otp', 'verify']);
});

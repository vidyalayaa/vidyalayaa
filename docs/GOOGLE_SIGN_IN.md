# Google sign-in setup

The login page offers **Continue with Google** alongside email/password. Both methods use Supabase Auth, the same application identity, the same school memberships and the same MFA checks. Google sign-in does not assign school roles or Super Admin access. New users without membership can accept an invitation for their verified email or contact their school administrator.

## 1. Create your Google OAuth client

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) in your Google Cloud project. Set the application name to Vidyalayaa, provide your support/contact email and complete the branding fields. For users across different schools, choose the External audience. While the app is in Testing, add the intended Google accounts as test users; publish the app when ready for other users, completing any verification Google requires.

Use only the `openid`, email and profile scopes for login. Vidyalayaa does not request Gmail, Drive or offline access.

Create an OAuth client of type **Web application**. Add these development JavaScript origins:

```text
http://localhost:5173
http://127.0.0.1:5173
```

Add your deployed HTTPS website origin when deploying. In **Authorized redirect URIs**, enter the exact callback URL shown in your Supabase project's Google provider settings. For hosted Supabase it normally has this form:

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
```

This is Google's redirect back to Supabase. The website callback in step 3 is a separate URL. For local Supabase CLI testing use its Auth callback, normally `http://127.0.0.1:54321/auth/v1/callback`.

## 2. Enable Google in Supabase

Open your Supabase project, then **Authentication → Sign In / Providers → Google** (the dashboard may label this Providers). Enable Google and paste the Google Client ID and Client Secret there. Save the provider settings. Keep nonce checking enabled.

The client secret belongs in Supabase's provider configuration. Do not paste it into chat, commit it, or place it in any `VITE_` variable. No new frontend secret or Google SDK is required. The web app uses its existing public Supabase URL and anon key.

To let previously unregistered Google users sign in, enable **Allow new users to sign up** in Supabase Auth. This creates an identity only; school access still requires an accepted invitation. With signup disabled, provision/invite the identity first. The local Supabase template defaults to `enable_signup = false`; deliberately change it to `true` when testing new Google identities.

## 3. Allow the website callback

In **Authentication → URL Configuration**, set the Site URL to your website origin. Add these development redirect URLs:

```text
http://localhost:5173/auth/google/callback
http://127.0.0.1:5173/auth/google/callback
```

Keep the existing `/auth/callback` entries for invitations/password recovery. Also add `https://YOUR_WEBSITE/auth/google/callback` for the deployed website, using your actual domain. Use exact trusted origins; do not add a broad production wildcard. Separate staging and production projects and OAuth clients are recommended.

## 4. Test sign-in

- Keep the local web server and API running and use the same browser throughout the redirect.
- Open `/login`, choose Continue with Google, then choose your Google account.
- If an authenticator is enrolled, enter its six-digit code. Google does not bypass this check. Super Admin platform endpoints continue to require MFA even before enrollment.
- An account with a school membership opens its assigned role's workspace. An account without membership sees the invitation/school-selection screen and receives no school data.
- Test email/password as well, including MFA and recovery. Users who registered only with Google can use password recovery for their verified email if they also want a Vidyalayaa password. MFA remains required for enrolled accounts when accessing the API.

Supabase can automatically link a Google identity to an existing account with the same verified email. Use the same email you were invited with, and confirm the existing school memberships remain attached. Vidyalayaa never performs client-side email-based role assignment or manual identity merging.

## Troubleshooting

**Google sign-in is not available yet:** enable the Google provider and save its credentials in Supabase. The button checks provider availability before redirecting; email/password remains available. No website rebuild is required when the provider is enabled.

**redirect_uri_mismatch:** the Google client's Authorized redirect URI must be the exact Supabase Auth callback, including any custom Auth domain.

**Redirect returns to the wrong page:** allow the website's `/auth/google/callback` in Supabase. Use the same `localhost` or `127.0.0.1` origin used to start login; browser storage is separate for each origin.

**Testing access denied:** add the Google account as a test user, or finish the appropriate publishing/verification steps for your audience.

**Expired/invalid callback:** start a new login from `/login` in the same browser. Do not copy callback codes to another browser or reuse them. PKCE codes are single-use; the callback removes them from the visible URL.

**No school assigned:** invite the Google account's verified email and accept the invitation. Signing in does not grant a role.

## Verification and implementation

The implementation uses PKCE with an explicitly handled `/auth/google/callback`. Provider errors, missing codes and failed exchanges do not reuse an existing session as successful login. Return destinations are restricted to application routes. Auth codes/tokens are never sent to the application API; Supabase verifies them. The API validates Supabase identity and enrolled factors before returning authenticated data, and retains all role checks/RLS.

```powershell
node node_modules/vitest/vitest.mjs run tests/unit/auth-return.test.ts tests/api/invitations.test.ts
node node_modules/@playwright/test/cli.js test tests/e2e/google-login.spec.ts tests/e2e/auth-callback.spec.ts tests/e2e/mfa.spec.ts --workers=2
```

Browser tests use isolated provider fixtures. A real Google round trip must be checked after the provider credentials and redirect allowlist are configured.

References: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google), [identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking), [MFA](https://supabase.com/docs/guides/auth/auth-mfa).

# Public Explore and school welcome

`/explore` is a public React Router page, available without authentication or a
school membership. It introduces the existing platform with role previews,
feature explanations, onboarding steps, FAQs, and an email contact link. The
previews are illustrative; they do not query school records, assign roles, or
change account permissions. Existing subscription and role restrictions still
apply inside each workspace.

## Entry points

- People without a school workspace see a welcome screen after signing in,
  with **Explore Vidyalayaa** and **Sign out**. Pending invitations remain
  available for acceptance, and existing memberships can still be selected.
- The login page links to Explore.
- Every workspace sidebar links to Explore.
- Explore's account link returns signed-in users to their workspace or welcome
  screen; visitors go to the existing login page.
- Account session controls remain available at `/settings/security` and through
  existing member settings. They are no longer promoted on the unassigned
  account's welcome screen.

## Implementation

The page and welcome screen live in `apps/web/src/features/explore/`. Their CSS
is scoped to those screens and follows the existing Fabric Grotesk, lime,
white, and dark-green design system. Motion respects reduced-motion settings;
role selection uses pressed-state buttons, FAQs use native details elements,
and the mobile navigation supports keyboard and screen-reader interaction.

There are no new dependencies, database migrations, public data endpoints, or
changes to Supabase Auth, MFA, invitations, or server-side authorization.

## Validation and deployment

From the repository root, with the project's supported Node.js version:

```sh
npm run build -w @vidyalayaa/web
npx playwright test tests/e2e/explore.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/google-login.spec.ts --workers=1
npx playwright test tests/e2e/login-sessions.spec.ts --grep "unassigned account" --workers=1
```

The browser checks use isolated providers and test accounts. They do not send
real invitations or access production school data. They cover desktop/mobile
public access, accessibility, layout overflow, role previews, FAQ and menu
interactions, welcome restrictions, provider logout, and API-outage behavior.
Existing invitation and sign-in checks protect those workflows.

Deploy the frontend through the existing Firebase Hosting deployment process.
The current SPA rewrite serves `/explore` on direct navigation. No API or worker
deployment is required for these presentation changes.

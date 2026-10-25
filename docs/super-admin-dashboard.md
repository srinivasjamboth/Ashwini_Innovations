# Super Admin Dashboard (`/ashwini-control`)

Owner-only window into how the platform is used: registration volume,
activity, campaigns, contacts, and subscription mix. Strictly
read-only — there is no edit / delete / suspend / impersonation path
anywhere in this area.

Terminology used throughout: **Admin / Platform Owner** = the one
person who can open `/ashwini-control`. **Customer** = anyone who
registered on the product. Customers can never access the admin area,
even with a valid login.

## Pages (names live in `src/lib/admin/constants.ts`, rename in one place)

| Name          | Path                              | What it shows                                        |
| ------------- | --------------------------------- | ---------------------------------------------------- |
| Pulse         | `/ashwini-control`                | 6 metric cards, 12-month new-users chart, fresh signups, last login |
| Member Ledger | `/ashwini-control/member-ledger`  | All customers: search, filters, sort, 25/page        |
| Plan Vault    | `/ashwini-control/plan-vault`     | Plans from the `plans` table + per-plan subscriber splits |
| Login         | `/ashwini-control/login`          | Email + password only. No signup, no reset, no social |

The area is unlisted: nothing on the public site or client dashboard
links to it, `robots.txt` disallows `/ashwini-control`, and every
response in the subtree carries `X-Robots-Tag: noindex` and
`Cache-Control: no-store` (stamped by `src/middleware.ts`).

## Setting up the owner (one-time)

No code path can create an owner. The owner is an **existing** account
whose immutable auth UUID you pin in the environment:

1. Find the UUID of the account you trust
   (Supabase Dashboard → Authentication → Users → copy the User ID,
   or `select id from auth.users where email = 'you@example.com'`).
2. In `.env.local` add:

   ```
   ADMIN_OWNER_USER_ID=00000000-0000-0000-0000-000000000000
   ```

3. Apply the migration (adds `admin_login_events`, one index, three
   service-role-only aggregate functions; touches nothing existing):

   ```
   supabase db push          # or paste 045_admin_dashboard.sql into the SQL editor
   ```

Fail-closed: if `ADMIN_OWNER_USER_ID` is unset, every admin page and
API denies everyone (client app unaffected) and the server logs a
warning naming the variable.

## How authorization works (defense in depth)

- `requireOwner()` (`src/lib/admin/guard.ts`) checks the session user
  ID against `ADMIN_OWNER_USER_ID` and email confirmation — server
  side, called in the admin layout, **every** page, and **every** API
  route. Middleware alone is never trusted.
- Logged out → redirect to `/ashwini-control/login` (pages) or `401`
  (APIs). Logged in but not the owner → `404`, byte-identical to a
  nonexistent page. No signal that the area exists.
- The admin login verifies ownership **before** any session cookie is
  persisted: credentials are checked inside an isolated in-memory
  cookie jar; a non-owner who types their correct client password
  gets the generic `Invalid credentials` and zero browser state.
- A short-lived `httpOnly` marker cookie (`ashwini_admin_sid`,
  scoped to `/ashwini-control`) enforces the 60-minute idle / 8-hour
  absolute admin timeout on top of Supabase's own session, plus
  same-origin CSRF checks on login and logout.
- All cross-tenant reads go through `supabaseAdmin()`
  (service-role key, server-only, never imported by client code).

## Throttling & audit

- 5 wrong passwords on an email lock the 6th attempt (429 +
  `Retry-After`), doubling per repeat: 1 → 2 → 4 → 8 → capped at 16
  minutes; strikes decay after 30 quiet minutes. Per-IP counter runs
  in parallel (threshold 10) alongside the shared
  `checkRateLimit('adminLogin', …)` limiter. All failures answer with
  the same `Invalid credentials` — never "email exists", never
  "locked reason".
- Every attempt (pass or fail) inserts a row into
  `admin_login_events` — attempted email, success, IP, user-agent,
  timestamp. Never a password. RLS-on-with-no-policies + revoked
  grants make the table UPDATE/DELETE-unreachable for every app
  role; the app itself only ever INSERTs/SELECTs.
- Pulse's "Last login" reads the newest successful event.

## Metric definitions (`src/lib/admin/metrics.ts` — single source)

"User" = registered **customer**: `profiles.account_role = 'owner'`.
Invited teammates (admin/agent/viewer) are not counted. The
Platform Owner's own account is excluded from every number and list.
The schema has no soft-delete columns, so that exclusion is a no-op.

- **Total Users** — all customers.
- **Active Users** — last sign-in (`auth.users.last_sign_in_at`) or
  profile activity within `ACTIVE_WINDOW_DAYS = 30`.
- **Total Campaigns** — all broadcasts across accounts.
- **Contacts** — all contacts across accounts.
- **Subscribers** — customers with an active paid subscription.
  ⚠ This schema has no `subscriptions`/`plans` tables yet, so this
  is honestly 0 and Plan Vault shows an empty state. The code is
  forward-compatible: the day those tables exist (and migration 045
  is applied), Subscribers, badges, filters, and Plan Vault light up
  with no UI changes. Yearly cycles are supported throughout.
- **Free Users** — Total − Subscribers (so Free + Subscribers =
  Total by construction).

Month bucketing (chart, ledger filters) runs in SQL with
`generate_series` + `AT TIME ZONE`, zero-filled, in `Asia/Kolkata`
(or `NEXT_PUBLIC_APP_TIMEZONE`).

## Known limitations

- Login throttle counters and admin-session markers are per-process
  in-memory maps (matching the project's existing rate-limiter). A
  server restart unlocks throttles and signs admin sessions out; a
  multi-instance deployment would need a shared store.
- Logging out of `/ashwini-control` also ends the owner's regular
  client session (there is one Supabase auth session per browser —
  ending it is the only way to guarantee no admin-capable cookie
  survives).
- The admin UI is English-only on purpose: it stays out of the
  `messages/*.json` catalogue so the existing translation-parity
  tests and client i18n flows are untouched.

/**
 * Super Admin Dashboard — single source of truth for naming and paths.
 *
 * The three page labels below are deliberately unique ("Pulse",
 * "Member Ledger", "Plan Vault"); renaming a page is a one-line change
 * here plus the matching route folder. Paths are absolute because the
 * sidebar, the guards, and the middleware all key off them.
 */

/** Root of the admin area. Never link to this from public/client code. */
export const ADMIN_ROOT = '/ashwini-control';

/** Where the owner lands when they have no session. */
export const ADMIN_LOGIN_PATH = `${ADMIN_ROOT}/login`;

/** Sidebar entries, in display order. */
export const ADMIN_PAGES = [
  { key: 'pulse', label: 'Pulse', path: ADMIN_ROOT },
  { key: 'member-ledger', label: 'Member Ledger', path: `${ADMIN_ROOT}/member-ledger` },
  { key: 'plan-vault', label: 'Plan Vault', path: `${ADMIN_ROOT}/plan-vault` },
] as const;

export type AdminPageKey = (typeof ADMIN_PAGES)[number]['key'];

/** Brand — mirrors the lockup used by the client auth shell. */
export const BRAND_NAME = 'Ashwini Innovations';
export const BRAND_LOGO_SRC = '/logo.jpeg';

// ------------------------------------------------------------
// Metric windows
// ------------------------------------------------------------

/** Chart window: trailing months, ending in the current month. */
export const CHART_MONTHS = 12;

/** Buckets (chart + "registered" labels) cut in this timezone. */
export const ADMIN_TIMEZONE =
  process.env.NEXT_PUBLIC_APP_TIMEZONE || 'Asia/Kolkata';

/** Pulse fresh-users table — default rows on the first render. */
export const FRESH_USERS_LIMIT = 10;

/** Member Ledger entries selector (spec Part 1: 10/25/50/100, default 25,
 *  remembered in localStorage). */
export const LEDGER_PAGE_SIZES = [10, 25, 50, 100] as const;
export const LEDGER_DEFAULT_PAGE_SIZE = 25;
export const LEDGER_PAGE_SIZE_STORAGE_KEY = "ashwini:ledger-page-size";

/** Pulse fresh-users entries selector (spec Part 1B: 10/25/50, default 10,
 *  remembered in localStorage) + its OWN URL params so they never clash
 *  with the Member Ledger's. */
export const USERS_PAGE_SIZES = [10, 25, 50] as const;
export const USERS_DEFAULT_PAGE_SIZE = 10;
export const USERS_PAGE_SIZE_STORAGE_KEY = "ashwini:pulse-users-page-size";
export const USERS_PAGE_PARAM = "usersPage";
export const USERS_PAGE_SIZE_PARAM = "usersPageSize";

/** Member Ledger search: min characters before we hit the database. */
export const LEDGER_MIN_QUERY_LENGTH = 2;

/** Plan Vault scan cap: the number of subscription rows the server
 *  module folds into memory per request (search/status/date filters
 *  run over this set so list, summary and the shared effective-status
 *  function can never disagree). Beyond the cap the response flags
 *  `truncated` and the UI says so instead of lying. */
export const VAULT_SCAN_CAP = 5_000;

/** Plan Vault page sizes (spec 3.4). */
export const VAULT_PAGE_SIZES = [10, 25, 50, 100] as const;
export const VAULT_DEFAULT_PAGE_SIZE = 25;

// ------------------------------------------------------------
// Session / cookie names
// ------------------------------------------------------------

/**
 * Admin marker cookie. The real credentials stay with the Supabase
 * session; this cookie only says "this browser passed the owner check
 * at time T" and is validated against the server-side session store
 * (idle 60 min, absolute 8 h).
 */
export const ADMIN_SESSION_COOKIE = 'ashwini_admin_sid';

/**
 * Path the marker cookie is scoped to. MUST be '/' — the admin APIs
 * live under `/api/ashwini-control/*`, which a browser does NOT treat
 * as under the `/ashwini-control` path prefix (cookie Path matching is
 * literal), so a page-scoped marker never reaches the APIs and every
 * dashboard fetch 401s. Server-side validation against the session
 * store (owner uid + idle/absolute timeouts) is what actually secures
 * the marker, so widening the path costs no security.
 */
export const ADMIN_SESSION_COOKIE_PATH = '/';

/** Legacy page-scoped path; login/logout expire any stale cookie set
 *  here so a browser never carries two markers with the same name. */
export const ADMIN_SESSION_COOKIE_LEGACY_PATH = ADMIN_ROOT;

/** Idle timeout: no admin request for this long ⇒ re-login. */
export const ADMIN_SESSION_IDLE_MS = 60 * 60 * 1000;

/** Absolute timeout: oldest allowed session, however active. */
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/** Cookie maxAge in seconds — equals the absolute timeout. */
export const ADMIN_SESSION_COOKIE_MAXAGE_S = ADMIN_SESSION_ABSOLUTE_MS / 1000;

// ------------------------------------------------------------
// Impersonation (Login-as-user)
// ------------------------------------------------------------

/**
 * Page prefixes an impersonated admin session cannot open in the
 * customer app. Everything destructive or credential-changing lives
 * here: the settings area (password form, email change, API-key
 * management, billing tab) and the authenticated password-reset page.
 * Blocked in middleware on a marker-cookie check — see
 * src/middleware.ts for why presence-only is the right edge primitive.
 */
export const IMPERSONATION_BLOCKED_PAGES = ['/settings', '/reset-password'] as const;

/**
 * API prefixes blocked while impersonating. Covers the actions the
 * page block protects: API-key create/list/reveal/delete and the
 * payment checkout (subscribe / upgrade / renew). Read-only billing
 * (entitlements snapshot, payments history) stays open — the app
 * needs the snapshot to render, and reading is not a mutation.
 */
export const IMPERSONATION_BLOCKED_APIS = [
  '/api/account/api-keys',
  '/api/billing/checkout',
] as const;

/** Where the middleware sends an impersonated page visit that hit the block. */
export const IMPERSONATION_BLOCKED_REDIRECT = '/dashboard?impersonation=blocked';

// ------------------------------------------------------------
// Login throttling
// ------------------------------------------------------------

/** Failed attempts on one email before the lockout engages. */
export const LOGIN_LOCK_THRESHOLD = 5;

/** First lockout length; doubles on every further failure. */
export const LOGIN_LOCK_BASE_MS = 60_000;

/** Lockouts stop doubling here (cap keeps a legitimate owner out at most ~16 min). */
export const LOGIN_LOCK_MAX_MS = 16 * 60_000;

/** Strike counters forget after this much quiet, so an old typo doesn't haunt the owner. */
export const LOGIN_STRIKE_DECAY_MS = 30 * 60_000;

/** Coarse per-IP budget (uses the shared fixed-window limiter). */
export const LOGIN_IP_RATE_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

/** Generic failure text — identical for wrong password, unknown email,
 *  non-owner credentials, and lockout. Never reveals which. */
export const ADMIN_LOGIN_GENERIC_ERROR = 'Invalid credentials';

/** Env var holding the owner's immutable auth uid. */
export const ADMIN_OWNER_ENV_VAR = 'ADMIN_OWNER_USER_ID';

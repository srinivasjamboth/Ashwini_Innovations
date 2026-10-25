/**
 * Plan engine — configuration constants.
 *
 * Kept tiny and dependency-free so it can be imported from anywhere
 * (service, API routes, cron, tests) without dragging in the Supabase
 * client. Values are configuration, NOT plan data — the plan limits and
 * feature flags themselves live in the database (see migration 048) and
 * are read through `getEntitlements`. The one exception is the numeric
 * defaults below, which the spec asks us to expose as single constants.
 */

/** Part 2: "the plan expires exactly at period end." Set >0 for leniency. */
export const GRACE_DAYS = 0;

/** Part 2: free-trial length in days, mirrored by the DB trial trigger. */
export const TRIAL_DAYS = 7;

/** Part 1: -1 is the sentinel for "unlimited" in plan_limits.value. */
export const UNLIMITED = -1;

/**
 * Flag 7: Enterprise bulk broadcast is unlimited, but we record an alert
 * once an account's monthly sends cross this number so the operator can
 * review fair use. Propose / adjust here; nothing else reads a hard-coded
 * value. 100k sends/month is ~3,300/day — far above legitimate team use,
 * low enough to catch a runaway script.
 */
export const FAIR_USE_ALERT_THRESHOLD = 100_000;

/** Gated features whose availability is a COUNT vs a numeric limit. */
export const LIMIT_FEATURES = [
  'contacts',
  'bulk_messages',
  'templates',
  'quick_replies',
  'automation_flows',
  'whatsapp_forms',
  'team_members',
] as const;

/** Gated features whose availability is a boolean plan flag. */
export const FEATURE_FLAGS = [
  'fields_tags',
  'broadcast_scheduler',
  'ai_agent',
] as const;

export type LimitFeature = (typeof LIMIT_FEATURES)[number];
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/**
 * Resource-table metadata for live usage counting (used by the
 * entitlements service). `total`-period limits are answered with a live
 * COUNT against the owning table so a delete automatically frees a slot
 * (Part 4 "deleting a counted resource decrements usage"); `bulk_messages`
 * is the one append-only counter and is handled separately.
 */
export const LIMIT_SOURCE_TABLES: Record<LimitFeature, string | null> = {
  contacts: 'contacts',
  templates: 'message_templates',
  quick_replies: 'quick_replies',
  automation_flows: 'automations',
  whatsapp_forms: 'whatsapp_flows',
  team_members: null, // profiles + pending invitations, computed specially
  bulk_messages: null, // usage_counters, computed specially
};

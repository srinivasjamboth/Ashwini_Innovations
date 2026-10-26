/**
 * Super Admin — "Add New User".
 *
 * Creates a customer through the SAME path a self-serve signup uses, so
 * the account, phone, and 7-day trial all come into existence via the
 * existing database triggers — never by hand-inserting customer rows:
 *
 *   auth.admin.createUser({ email_confirm: true, data: { full_name, phone } })
 *     └─ trigger on_auth_user_created → handle_new_user()   (044)  → account + owner profile (+ phone)
 *     └─ trigger on_auth_user_trial   → grant_trial_subscription() (048) → 7-day trialing subscription
 *
 * `email_confirm: true` is deliberate: an admin-created customer has no
 * confirmation email to click, and the spec says the admin always sets
 * the password (no invite). We use the service-role client (bypasses
 * RLS on the write) but touch ONLY the auth schema here — no customer
 * table is written directly.
 *
 * Validation reuses the SHARED signup primitives (isValidPhone /
 * phoneForDb) so the phone can never drift from what the profiles CHECK
 * accepts. The password rule is the admin's own — 8+ chars with a letter
 * and a number — stricter than the public signup floor, and applied here
 * only (the customer-side signup is intentionally untouched).
 */

import { isValidPhone, phoneForDb } from '@/lib/auth/phone'
import { supabaseAdmin } from './supabase-admin'

export interface NewUserInput {
  fullName: string
  email: string
  phone: string
  password: string
}

export type NewUserValidation =
  | { ok: true; value: NewUserInput }
  | { ok: false; fieldErrors: Record<string, string> }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Admin password rule: ≥8 chars, at least one letter and one digit. */
export function isValidAdminPassword(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw)
}

/** Hand-rolled schema check (repo ships no zod), mirroring the fields the
 *  signup page collects. `phone` is the joined dial-code + national
 *  number exactly as signup builds `fullPhone`. */
export function validateNewUser(body: unknown): NewUserValidation {
  const b = (body ?? {}) as Record<string, unknown>
  const errors: Record<string, string> = {}

  const fullName = typeof b.fullName === 'string' ? b.fullName.trim() : ''
  if (!fullName) errors.fullName = 'Full name is required.'
  else if (fullName.length > 120) errors.fullName = 'Full name is too long (max 120).'

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  if (!email) errors.email = 'Email is required.'
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.'

  const rawPhone = typeof b.phone === 'string' ? b.phone : ''
  const normalizedPhone = phoneForDb(rawPhone)
  if (!rawPhone.trim()) errors.phone = 'Mobile number is required.'
  else if (!normalizedPhone || !isValidPhone(rawPhone))
    errors.phone = "That phone number doesn't look right."

  const password = typeof b.password === 'string' ? b.password : ''
  if (!password) errors.password = 'A password is required.'
  else if (!isValidAdminPassword(password))
    errors.password = 'Use at least 8 characters with a letter and a number.'

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors }
  return { ok: true, value: { fullName, email, phone: normalizedPhone as string, password } }
}

export type CreateUserResult =
  | { kind: 'ok'; userId: string; email: string; fullName: string }
  | { kind: 'emailTaken' }
  | { kind: 'failed'; message: string }

/** Create the auth user. The DB triggers do everything else, so we never
 *  insert an account/profile/subscription row here. */
export async function createUserViaAdminApi(input: NewUserInput): Promise<CreateUserResult> {
  try {
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      // handle_new_user (044) reads raw_user_meta_data for these, the
      // same field signup populates via auth.signUp options.data. The
      // admin API calls it user_metadata.
      user_metadata: { full_name: input.fullName, phone: input.phone },
    })
    if (error) {
      const msg = String(error.message ?? '').toLowerCase()
      if (
        msg.includes('already') ||
        msg.includes('registered') ||
        msg.includes('exists') ||
        (error as { status?: number }).status === 422
      ) {
        return { kind: 'emailTaken' }
      }
      console.error('[admin-users] createUser failed:', error.message)
      return { kind: 'failed', message: 'create_failed' }
    }
    const userId = data.user?.id
    if (!userId) return { kind: 'failed', message: 'create_failed' }
    return { kind: 'ok', userId, email: input.email, fullName: input.fullName }
  } catch (err) {
    console.error('[admin-users] createUser threw:', err)
    return { kind: 'failed', message: 'create_failed' }
  }
}

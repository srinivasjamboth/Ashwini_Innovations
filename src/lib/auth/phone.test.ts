import { describe, expect, it } from "vitest";
import {
  isValidPhone,
  normalizePhone,
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  phoneForDb,
} from "./phone";

// The browser and the DB have to agree: `profiles.phone` is guarded by
// `CHECK (phone IS NULL OR phone ~ '^\\+?[0-9]{7,15}$')` in
// supabase/migrations/044_profile_phone.sql, and handle_new_user() filters
// signup metadata through the same expression. These cases are written
// against that shape — if either side moves, the other must too.

describe("normalizePhone", () => {
  it("keeps the digits a user typed with separators", () => {
    expect(normalizePhone("(+91) 96401-11265")).toBe("+919640111265");
    expect(normalizePhone("96401 11265")).toBe("9640111265");
    expect(normalizePhone("+91 96401.11265")).toBe("+919640111265");
  });

  it("trims surrounding whitespace before deciding about the +", () => {
    expect(normalizePhone("  +919640111265  ")).toBe("+919640111265");
    expect(normalizePhone("\t+91 9640111265")).toBe("+919640111265");
  });

  it("only ever keeps a leading +", () => {
    expect(normalizePhone("+91+9640111265")).toBe("+919640111265");
    expect(normalizePhone("91+9640111265")).toBe("919640111265");
  });

  it("drops letters and other junk rather than passing it through", () => {
    expect(normalizePhone("call me 9640111265")).toBe("9640111265");
    expect(normalizePhone("abcdefg")).toBe("");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
  });
});

describe("isValidPhone", () => {
  it("accepts local and international shapes", () => {
    expect(isValidPhone("9640111265")).toBe(true);
    expect(isValidPhone("+919640111265")).toBe(true);
    expect(isValidPhone("+1 202 555 0147")).toBe(true);
  });

  it("sits on the documented digit bounds", () => {
    expect(isValidPhone("1".repeat(PHONE_MIN_DIGITS))).toBe(true);
    expect(isValidPhone("1".repeat(PHONE_MIN_DIGITS - 1))).toBe(false);
    expect(isValidPhone("1".repeat(PHONE_MAX_DIGITS))).toBe(true);
    expect(isValidPhone("1".repeat(PHONE_MAX_DIGITS + 1))).toBe(false);
  });

  it("rejects blank, short, long and non-numeric input", () => {
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone("   ")).toBe(false);
    expect(isValidPhone("1234")).toBe(false);
    expect(isValidPhone("phone: 12345")).toBe(false);
    expect(isValidPhone("abcdefg")).toBe(false);
    expect(isValidPhone("12345678901234567890")).toBe(false);
  });

  it("never accepts a lone +", () => {
    expect(isValidPhone("+")).toBe(false);
  });
});

describe("phoneForDb", () => {
  it("writes the normalised form", () => {
    expect(phoneForDb("(+91) 96401-11265")).toBe("+919640111265");
  });

  it("maps blank and invalid input to null, never to ''", () => {
    // The column CHECK requires 7-15 digits, so an empty string would
    // raise on write. null is the only safe way to say "no phone".
    expect(phoneForDb("")).toBeNull();
    expect(phoneForDb("   ")).toBeNull();
    expect(phoneForDb(null)).toBeNull();
    expect(phoneForDb(undefined)).toBeNull();
    expect(phoneForDb("12")).toBeNull();
  });

  it("always returns a value the column CHECK accepts", () => {
    const sqlCheck = /^\+?[0-9]{7,15}$/;
    const samples = [
      "+91 96401 11265",
      "(040) 5550-1234",
      "0000000",
      "+123456789012345",
      "",
      "nope",
    ];
    for (const sample of samples) {
      const stored = phoneForDb(sample);
      expect(stored === null || sqlCheck.test(stored), sample).toBe(true);
    }
  });
});

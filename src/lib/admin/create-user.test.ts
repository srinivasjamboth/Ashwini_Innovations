import { describe, expect, it } from "vitest";
import { isValidAdminPassword, validateNewUser } from "./create-user";

describe("isValidAdminPassword", () => {
  it("requires 8+ chars with a letter and a number", () => {
    expect(isValidAdminPassword("abcdefg1")).toBe(true); // 8, letter+digit
    expect(isValidAdminPassword("short1")).toBe(false); // < 8
    expect(isValidAdminPassword("allletters")).toBe(false); // no digit
    expect(isValidAdminPassword("12345678")).toBe(false); // no letter
  });
});

describe("validateNewUser", () => {
  const base = {
    fullName: "Ashwini Kumar",
    email: "Ashwini@Example.COM",
    phone: "+919640111265",
    password: "Passw0rd123",
  };

  it("accepts a valid, fully-formed request and normalizes it", () => {
    const res = validateNewUser(base);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.email).toBe("ashwini@example.com"); // lower-cased
      expect(res.value.fullName).toBe("Ashwini Kumar");
      expect(res.value.phone).toBe("+919640111265");
    }
  });

  it("accepts separator-laden phones via the shared normalizer", () => {
    const res = validateNewUser({ ...base, phone: "(+91) 96401-11265" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.phone).toBe("+919640111265");
  });

  it("reports every missing field", () => {
    const res = validateNewUser({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fieldErrors).toHaveProperty("fullName");
      expect(res.fieldErrors).toHaveProperty("email");
      expect(res.fieldErrors).toHaveProperty("phone");
      expect(res.fieldErrors).toHaveProperty("password");
    }
  });

  it("rejects a malformed email", () => {
    const res = validateNewUser({ ...base, email: "not-an-email" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors).toHaveProperty("email");
  });

  it("rejects a too-short / invalid phone", () => {
    const res = validateNewUser({ ...base, phone: "1234" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors).toHaveProperty("phone");
  });

  it("enforces the admin password rule (not the signup floor)", () => {
    // 6-char values pass the public signup but fail the admin rule.
    const res = validateNewUser({ ...base, password: "ab1cde" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors).toHaveProperty("password");
  });
});

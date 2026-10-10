import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  matchesEnvVerifyToken,
  parseEnvVerifyTokens,
} from "./webhook-verify-token";

describe("matchesEnvVerifyToken", () => {
  const original = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "meta-verify-abc123";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    else process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = original;
  });

  it("accepts the configured token", () => {
    expect(matchesEnvVerifyToken("meta-verify-abc123")).toBe(true);
  });

  it("rejects a different token", () => {
    expect(matchesEnvVerifyToken("meta-verify-abc124")).toBe(false);
  });

  it("rejects an empty candidate without throwing", () => {
    // Hashing both sides means a zero-length value compares safely instead
    // of tripping timingSafeEqual's length check.
    expect(matchesEnvVerifyToken("")).toBe(false);
  });

  it("is exact, not a prefix match", () => {
    expect(matchesEnvVerifyToken("meta-verify-abc123-extra")).toBe(false);
  });

  it("accepts any of several comma-separated tokens", () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = " tok-one , tok-two ,, tok-three ";
    expect(matchesEnvVerifyToken("tok-one")).toBe(true);
    expect(matchesEnvVerifyToken("tok-two")).toBe(true);
    expect(matchesEnvVerifyToken("tok-three")).toBe(true);
    expect(matchesEnvVerifyToken("tok-four")).toBe(false);
  });

  it("matches a token whose stored form was trimmed", () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "  padded-token  ";
    expect(matchesEnvVerifyToken("padded-token")).toBe(true);
  });

  it("accepts nothing when the env var is unset or blank", () => {
    // This is the whole point of the feature being opt-in: no env token
    // means the handler behaves exactly as it did before.
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    expect(matchesEnvVerifyToken("anything")).toBe(false);

    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "";
    expect(matchesEnvVerifyToken("anything")).toBe(false);

    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = " , , ";
    expect(matchesEnvVerifyToken("anything")).toBe(false);
  });
});

describe("parseEnvVerifyTokens", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(parseEnvVerifyTokens(" a , b,,c ,")).toEqual(["a", "b", "c"]);
  });

  it("returns a single token unchanged", () => {
    expect(parseEnvVerifyTokens("only-one")).toEqual(["only-one"]);
  });

  it("returns nothing for unset, empty, or comma-only values", () => {
    expect(parseEnvVerifyTokens(undefined)).toEqual([]);
    expect(parseEnvVerifyTokens("")).toEqual([]);
    expect(parseEnvVerifyTokens(" , ,")).toEqual([]);
  });
});

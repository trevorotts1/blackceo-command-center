// Tests for the constant-time secret compare (FIX-RESCUE-11 ii).
// Run: node --test fleet-heartbeat/scripts/lib/rescue-constant-time-compare.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual, authHeaderOk } from "./rescue-constant-time-compare.mjs";

test("constantTimeEqual matches equal secrets and rejects mismatches", () => {
  assert.equal(constantTimeEqual("s3cr3t", "s3cr3t"), true);
  assert.equal(constantTimeEqual("s3cr3t", "s3cr3T"), false);
  assert.equal(constantTimeEqual("short", "a-much-longer-secret"), false, "unequal lengths never throw and never match");
});

test("constantTimeEqual is nullish-safe (fails closed)", () => {
  assert.equal(constantTimeEqual(null, "x"), false);
  assert.equal(constantTimeEqual("x", null), false);
  assert.equal(constantTimeEqual(undefined, undefined), false);
  assert.equal(constantTimeEqual("", ""), true, "two empty strings are equal (caller guards emptiness via authHeaderOk)");
});

test("authHeaderOk fails closed when no secret is configured", () => {
  assert.equal(authHeaderOk("anything", ""), false);
  assert.equal(authHeaderOk("anything", undefined), false);
  assert.equal(authHeaderOk("", "configured"), false);
  assert.equal(authHeaderOk("configured", "configured"), true);
});

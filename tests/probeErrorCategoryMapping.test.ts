/**
 * Task 11.3 — Unit test for the probe error category mapping.
 *
 * Validates: Requirements 23.2
 *
 * Requirement 23.2: a failed Model_Probe is classified into a
 * {@link ProbeErrorCategory} so the Setup_UI can tell the user which part of
 * their configuration to fix. This suite exercises the mapping table in
 * {@link classifyProbeError} (`src/providers/probe.ts`, task 11.1):
 *
 *  1. Every {@link ProbeErrorCategory} value is reachable — at least one
 *     representative signal lands in each bucket.
 *  2. The most-specific-to-least-specific ordering is honored, so an
 *     overlapping signal lands in the most actionable bucket (e.g. a `403`
 *     carrying "no access to model" classifies as `model_access_missing`, not
 *     `auth_invalid`; a content/safety `400` classifies as `content_rejected`,
 *     not `parameter_incompatible`).
 *
 * The classifier is a pure, dependency-free heuristic, so there is ZERO disk,
 * network, or provider I/O here.
 */
import { describe, expect, it } from "vitest";

import {
  ProbeErrorCategorySchema,
  classifyProbeError,
  type ProbeErrorCategory,
  type ProbeFailureSignal,
} from "../src/providers/probe";

/** The complete set of classified probe categories declared by the schema. */
const ALL_CATEGORIES = ProbeErrorCategorySchema.options;

describe("classifyProbeError — mapping table covers every ProbeErrorCategory (Requirement 23.2)", () => {
  // A representative signal for each category, asserting the heuristic routes it
  // to the expected bucket. Cases are grouped per category for traceability.
  const cases: ReadonlyArray<{
    readonly category: ProbeErrorCategory;
    readonly label: string;
    readonly signal: ProbeFailureSignal;
  }> = [
    // content_rejected — checked before the generic 400 parameter branch.
    { category: "content_rejected", label: "content filter keyword", signal: { status: 400, message: "blocked by content filter" } },
    { category: "content_rejected", label: "responsible AI safety policy", signal: { status: 400, message: "Responsible AI content management policy triggered" } },
    { category: "content_rejected", label: "jailbreak detection", signal: { message: "request flagged for jailbreak attempt" } },

    // quota_exceeded — 429 or quota/rate-limit keywords.
    { category: "quota_exceeded", label: "HTTP 429", signal: { status: 429 } },
    { category: "quota_exceeded", label: "insufficient_quota code", signal: { code: "insufficient_quota", message: "you exceeded your current quota" } },
    { category: "quota_exceeded", label: "rate limit text", signal: { message: "rate limit reached, too many requests" } },

    // deployment_not_found — Azure-specific 404/config, before generic endpoint.
    { category: "deployment_not_found", label: "DeploymentNotFound code", signal: { status: 404, code: "DeploymentNotFound" } },
    { category: "deployment_not_found", label: "deployment + 404", signal: { status: 404, message: "The API deployment for this resource does not exist" } },
    { category: "deployment_not_found", label: "deployment env required", signal: { message: "deployment env is required" } },

    // region_unsupported — region/location keywords.
    { category: "region_unsupported", label: "region keyword", signal: { message: "model is not available in your region" } },
    { category: "region_unsupported", label: "unsupported_region code", signal: { code: "unsupported_region", message: "not supported in this region" } },

    // model_access_missing — checked before auth so an access/agreement gap wins.
    { category: "model_access_missing", label: "no access to the model", signal: { status: 403, message: "your account does not have access to the model" } },
    { category: "model_access_missing", label: "marketplace agreement", signal: { message: "you must accept the marketplace agreement first" } },
    { category: "model_access_missing", label: "subscribe to the model", signal: { message: "please subscribe to the model to continue" } },

    // auth_invalid — 401/403 or auth keywords.
    { category: "auth_invalid", label: "HTTP 401", signal: { status: 401 } },
    { category: "auth_invalid", label: "HTTP 403 with no special keywords", signal: { status: 403, message: "forbidden" } },
    { category: "auth_invalid", label: "invalid api key", signal: { code: "invalid_api_key", message: "Invalid API key provided" } },

    // endpoint_invalid — 404 or network/DNS/URL keywords.
    { category: "endpoint_invalid", label: "HTTP 404 (no deployment context)", signal: { status: 404, message: "not found" } },
    { category: "endpoint_invalid", label: "DNS ENOTFOUND", signal: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.example.test" } },
    { category: "endpoint_invalid", label: "connection refused", signal: { message: "fetch failed: connection refused (ECONNREFUSED)" } },

    // parameter_incompatible — 400 or request-shape keywords.
    { category: "parameter_incompatible", label: "HTTP 400", signal: { status: 400 } },
    { category: "parameter_incompatible", label: "unsupported parameter", signal: { code: "invalid_request_error", message: "unsupported parameter: temperature" } },

    // unknown — unrecognized signal falls through.
    { category: "unknown", label: "empty signal", signal: {} },
    { category: "unknown", label: "HTTP 500 with opaque body", signal: { status: 500, message: "internal server error" } },
  ];

  for (const { category, label, signal } of cases) {
    it(`maps ${category}: ${label}`, () => {
      expect(classifyProbeError(signal)).toBe(category);
    });
  }

  it("covers every category declared by ProbeErrorCategorySchema", () => {
    const covered = new Set(cases.map((c) => c.category));
    for (const category of ALL_CATEGORIES) {
      expect(covered.has(category)).toBe(true);
    }
  });

  it("only ever returns a value declared by the schema", () => {
    for (const { signal } of cases) {
      expect(ALL_CATEGORIES).toContain(classifyProbeError(signal));
    }
  });
});

describe("classifyProbeError — ordering/precedence between overlapping signals (Requirement 23.2)", () => {
  it("prefers model_access_missing over auth_invalid for a 403 access/agreement gap", () => {
    // A 403 alone would be auth_invalid, but the access keyword is more actionable.
    expect(classifyProbeError({ status: 403, message: "you do not have access to the model" })).toBe(
      "model_access_missing",
    );
    expect(classifyProbeError({ status: 403 })).toBe("auth_invalid");
  });

  it("prefers content_rejected over parameter_incompatible for a safety 400", () => {
    // A bare 400 is parameter_incompatible, but a safety block surfaced as a 400
    // is the more actionable content_rejected.
    expect(classifyProbeError({ status: 400, message: "request rejected by safety filter" })).toBe(
      "content_rejected",
    );
    expect(classifyProbeError({ status: 400 })).toBe("parameter_incompatible");
  });

  it("prefers deployment_not_found over endpoint_invalid for an Azure deployment 404", () => {
    // A bare 404 is endpoint_invalid, but a named-deployment miss is more specific.
    expect(
      classifyProbeError({ status: 404, message: "deployment does not exist for this resource" }),
    ).toBe("deployment_not_found");
    expect(classifyProbeError({ status: 404, message: "not found" })).toBe("endpoint_invalid");
  });

  it("prefers quota_exceeded over generic auth/parameter handling on a 429", () => {
    expect(classifyProbeError({ status: 429, message: "too many requests" })).toBe("quota_exceeded");
  });

  it("prefers region_unsupported over auth_invalid when both signals overlap", () => {
    // A 403 region failure is more actionable as a region problem.
    expect(
      classifyProbeError({ status: 403, message: "this model is not available in your region" }),
    ).toBe("region_unsupported");
  });
});

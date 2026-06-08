/**
 * Task 12.3 — Setup_UI secret-presence boolean property test.
 *
 * **Feature: byok-chat-ux-and-model-discovery, Property 17: Secret presence is exposed only as a boolean**
 * **Validates: Requirements 24.3**
 *
 * Property 17: *For any* provider configuration view model, the secret SHALL be
 * represented as a boolean presence state only and never as a value.
 *
 * The provider configuration view model is the `{ ...record, secretPresent }`
 * payload the Setup_API returns and the panel renders (task 12.1). This test
 * generates the widest plausible payload — every preset provider, an
 * openai-compatible record, an arbitrary `secretPresent` boolean per provider,
 * and a recognizable key-like secret planted into every value-bearing record
 * field the API must never echo (`secretRef`, `apiKey`, `secret`, `key`,
 * `token`, `secretValue`) — drives it through `loadProviderConfig`, and asserts
 * the two universal invariants of the rendered provider configuration:
 *
 *   1. The secret VALUE never appears anywhere in the rendered card — not in
 *      text, an input value, a placeholder, a title, a class, or a data
 *      attribute.
 *   2. Secret presence is conveyed ONLY as a boolean state: the key hint and
 *      masked-key placeholder are exactly one of two constant strings, selected
 *      solely by `secretPresent === true`, and the key input itself is always
 *      empty.
 *
 * The targeted, example-based panel behaviors (status derivation, write-once
 * upsert body, connection-test states) live in `providerConfig.dom.test.ts`
 * (task 13). Every run is hermetic: `app.js` runs in a `vm` over a fake DOM and
 * an injected `fetch` double, so the property makes ZERO network/provider calls
 * and never touches disk or a real browser.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { createProviderPanelHarness, jsonResponse, type ProviderPanelHarness } from "./support/providerPanelHarness";

type AnyEl = any;

// The three preset providers the panel always renders (Together, Cloudflare, Azure), plus the
// openai-compatible advanced card. Each entry names the container the card is rendered into and a
// builder for its safe (non-secret) rendered fields, so the planted secret can only ever surface
// through the secret-presence path — never through a legitimate rendered field.
const PRESET_PROVIDERS = [
  {
    id: "together",
    kind: "together",
    label: "Together AI",
    container: "provider-config-cards",
    rendered: () => ({ model: "safe-model", baseUrl: "https://safe.example/v1" }),
  },
  {
    id: "cloudflare",
    kind: "cloudflare",
    label: "Cloudflare Workers AI",
    container: "provider-config-cards",
    rendered: () => ({ cloudflare: { accountId: "acct-safe" }, model: "@cf/safe/model" }),
  },
  {
    id: "azure-openai",
    kind: "azure-openai",
    label: "Azure OpenAI",
    container: "provider-config-cards",
    rendered: () => ({
      azure: { endpoint: "https://safe.openai.azure.com", deployment: "dep-safe", apiVersion: "2024-02-01" },
      model: "safe-azure-model",
    }),
  },
  {
    id: "openai-compatible:proxy",
    kind: "openai-compatible",
    label: "Safe Proxy",
    container: "provider-config-adv-cards",
    rendered: () => ({ baseUrl: "https://proxy.safe.example/v1", model: "proxy-safe-model" }),
  },
] as const;

// The two constant presence indicators the panel renders, selected solely by the boolean. Encoding
// them here pins the "boolean state only" guarantee: there is no third, value-bearing state.
const HINT_PRESENT = "A key is stored for this provider.";
const HINT_ABSENT = "No key stored yet.";
const PLACEHOLDER_PRESENT = "•••••• stored — leave blank to keep";
const PLACEHOLDER_ABSENT = "Enter API key";

// A recognizable key-like secret: a prefix plus URL/JSON-safe alphanumerics, >= 24 chars, so a
// leaked substring is unambiguously searchable in any serialized rendered output.
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");
const SECRET_PREFIXES = ["sk-", "key-", "tok-", "secret-"] as const;
const arbSecret: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...SECRET_PREFIXES), fc.array(fc.constantFrom(...SECRET_ALPHABET), { minLength: 24, maxLength: 48 }))
  .map(([prefix, chars]) => `${prefix}${chars.join("")}`);

// One generated view-model intent per provider: whether to include a record for it at all, the
// boolean presence the API reports, and the secret value planted into every field the API must
// never echo back.
interface ProviderIntent {
  include: boolean;
  secretPresent: boolean;
  secret: string;
}
const arbProviderIntent: fc.Arbitrary<ProviderIntent> = fc.record({
  include: fc.boolean(),
  secretPresent: fc.boolean(),
  secret: arbSecret,
});

/**
 * Build the `GET /api/providers` payload from the per-provider intents. For every included provider
 * the record carries its safe rendered fields, the `secretPresent` boolean, and the planted secret
 * in every value-bearing key the API must never expose. Returns the payload plus a lookup of the
 * expected presence boolean and the set of planted secret values to scan for.
 */
function buildPayload(intents: readonly ProviderIntent[]): {
  providers: Record<string, unknown>[];
  expectedPresent: Map<string, boolean>;
  secrets: Set<string>;
} {
  const providers: Record<string, unknown>[] = [];
  const expectedPresent = new Map<string, boolean>();
  const secrets = new Set<string>();

  PRESET_PROVIDERS.forEach((preset, index) => {
    const intent = intents[index];
    // A preset with no record renders as not-configured -> presence is the boolean `false`.
    expectedPresent.set(preset.id, intent.include ? intent.secretPresent : false);
    if (!intent.include) {
      return;
    }
    secrets.add(intent.secret);
    providers.push({
      id: preset.id,
      kind: preset.kind,
      label: preset.label,
      ...preset.rendered(),
      // Presence is reported ONLY as a boolean (the real API contract, Req 24.3).
      secretPresent: intent.secretPresent,
      // Adversarial: every value-bearing field the API must NEVER echo carries the secret. The
      // panel must surface none of them.
      secretRef: intent.secret,
      apiKey: intent.secret,
      secret: intent.secret,
      key: intent.secret,
      token: intent.secret,
      secretValue: intent.secret,
    });
  });

  return { providers, expectedPresent, secrets };
}

/** Recursively collect every string the rendered card could leak a secret through. */
function collectRenderedStrings(el: AnyEl, out: string[]): void {
  if (!el) {
    return;
  }
  out.push(String(el.textContent ?? ""));
  out.push(String(el.value ?? ""));
  out.push(String(el.className ?? ""));
  for (const attr of ["placeholder", "title", "aria-label", "value"]) {
    const v = el.getAttribute?.(attr);
    if (v != null) {
      out.push(String(v));
    }
  }
  for (const v of Object.values(el.dataset ?? {})) {
    out.push(String(v));
  }
  for (const child of el.children ?? []) {
    collectRenderedStrings(child, out);
  }
}

/** Find a rendered provider card by its provider id across all card containers. */
function cardFor(harness: ProviderPanelHarness, containerId: string, providerId: string): AnyEl {
  return harness
    .getEl(containerId)
    .querySelectorAll(".provider-config-card")
    .find((c: AnyEl) => c.dataset.providerId === providerId);
}

describe("Feature: byok-chat-ux-and-model-discovery, Property 17: Secret presence is exposed only as a boolean", () => {
  let harness: ProviderPanelHarness;

  beforeEach(() => {
    harness = createProviderPanelHarness();
  });

  afterEach(() => {
    // Reset the injected fetch so a later run never reuses a stale handler.
    harness.setFetchHandler(async () => jsonResponse({}));
  });

  // Validates: Requirements 24.3
  it("renders secret presence as a boolean state only and never exposes the secret value", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(arbProviderIntent, arbProviderIntent, arbProviderIntent, arbProviderIntent),
        async (intents) => {
          const { providers, expectedPresent, secrets } = buildPayload(intents);

          // Serve the generated view model through the Setup_API GET and render the panel.
          harness.setFetchHandler(async () => jsonResponse({ providers, activeRoutes: {} }));
          await harness.sandbox.loadProviderConfig();

          for (const preset of PRESET_PROVIDERS) {
            const card = cardFor(harness, preset.container, preset.id);
            // Preset cards always render; the openai-compatible advanced card renders only when a
            // record exists for it.
            if (!card) {
              expect(preset.kind).toBe("openai-compatible");
              expect(expectedPresent.get(preset.id)).toBe(false);
              continue;
            }

            const present = expectedPresent.get(preset.id) === true;

            // (2) Presence is a boolean state ONLY: the hint and placeholder are exactly one of two
            // constant strings, chosen solely by the boolean.
            const hint = card.querySelector(".provider-config-key-hint");
            const keyInput = card.querySelector(".provider-config-key");
            expect(hint?.textContent).toBe(present ? HINT_PRESENT : HINT_ABSENT);
            expect(keyInput?.getAttribute("placeholder")).toBe(present ? PLACEHOLDER_PRESENT : PLACEHOLDER_ABSENT);
            // The masked key input never carries a value (no secret lingers in the DOM, Req 24.3/24.1).
            expect(keyInput?.value ?? "").toBe("");

            // (1) The secret VALUE never appears anywhere in the rendered card.
            const strings: string[] = [];
            collectRenderedStrings(card, strings);
            const haystack = strings.join("\u0000");
            for (const secret of secrets) {
              expect(haystack).not.toContain(secret);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

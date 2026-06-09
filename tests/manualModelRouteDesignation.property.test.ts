/**
 * Task 1.2 — Manual-list route designation property test.
 *
 * **Feature: cloud-capable-transition, Property 15: Any manual-list identifier is designable as a route model**
 * **Validates: Requirements 3.8**
 *
 * Property 15: WHERE a Manual_Model_List is present on a `ProviderConfigRecord`,
 * the Active_Route_Map SHALL be able to designate ANY Manual_Model_List model
 * identifier as the `flagship` or `slm` model identifier for that record
 * (Requirement 3.8).
 *
 * The designation surface is the record's per-role model map
 * (`ProviderModelMapSchema`, i.e. `models.flagship` / `models.slm`), paired with
 * the {@link ActiveRouteMapSchema} that points a role at the record by id. This
 * property proves that the schema layer never rejects a designation drawn from a
 * record's own `manualModels`: for any manual identifier picked from the list,
 *  1. a record whose `models.flagship` is that identifier validates and round-trips
 *     the identifier unchanged,
 *  2. the same holds for `models.slm`,
 *  3. an {@link ActiveRouteMap} designating the record id for that role validates,
 *  4. the designated identifier is genuinely a member of the record's `manualModels`.
 *
 * Because `manualModels` entries and the `models` map fields share the same
 * non-empty-string constraint, any list identifier is always an acceptable route
 * model id. The test is pure schema validation: ZERO disk, network, or clock I/O,
 * so every run is deterministic and hermetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  ActiveRouteMapSchema,
  PROVIDER_MODEL_ROLES,
  ProviderConfigRecordSchema,
  type ProviderModelRole,
} from "../src/providers/config";

// A fixed, schema-valid ISO timestamp for record metadata; the designation
// invariant is independent of the actual timestamp, so it can stay constant.
const TS = "2026-01-01T00:00:00.000Z";

/**
 * A non-empty model identifier. The alphabet mirrors real provider model ids
 * (vendor prefixes, hyphens, slashes, dots, version digits) and is deliberately
 * wider than alphanumerics so the property exercises identifiers like
 * `meta-llama/Llama-3.1-8B-Instruct`. The `min(1)` length matches the schema's
 * `NonEmptyStringSchema` constraint shared by `manualModels` and the model map.
 */
const arbModelId: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._/\-:]*$/)
  .filter((value) => value.length >= 1);

/** A non-empty Manual_Model_List of model identifiers. */
const arbManualModels: fc.Arbitrary<string[]> = fc.array(arbModelId, {
  minLength: 1,
  maxLength: 8,
});

/** A short non-empty slug used to build a stable record id. */
const arbSlug: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]*$/)
  .filter((value) => value.length >= 1 && value.length <= 16);

describe("Feature: cloud-capable-transition, Property 15: Any manual-list identifier is designable as a route model", () => {
  // Validates: Requirements 3.8
  it("accepts any Manual_Model_List identifier as the flagship/slm route model id", () => {
    fc.assert(
      fc.property(
        arbManualModels,
        arbSlug,
        fc.constantFrom<ProviderModelRole>(...PROVIDER_MODEL_ROLES),
        // A raw index into the list; mapped to a valid position with modulo so it
        // always selects an existing entry regardless of the generated length.
        fc.nat(),
        (manualModels, slug, role, rawIndex) => {
          const chosen = manualModels[rawIndex % manualModels.length];
          const id = `openai-compatible:${slug}`;

          // (4) Sanity: the chosen identifier is genuinely a list member.
          expect(manualModels).toContain(chosen);

          // (1)/(2) The record designates `chosen` for the selected role via the
          // per-role model map and validates against the record schema, and the
          // identifier round-trips unchanged (the map "accepts it").
          const record = ProviderConfigRecordSchema.parse({
            id,
            kind: "openai-compatible",
            label: `proxy ${slug}`,
            baseUrl: `https://${slug}.test`,
            manualModels,
            models: { [role]: chosen },
            secretRef: id,
            createdAt: TS,
            updatedAt: TS,
          });

          expect(record.models?.[role]).toBe(chosen);
          expect(record.manualModels).toContain(record.models?.[role]);

          // The OTHER role can independently designate the same identifier too,
          // confirming designability holds for both flagship and slm.
          const otherRole: ProviderModelRole = role === "flagship" ? "slm" : "flagship";
          const bothRoles = ProviderConfigRecordSchema.parse({
            ...record,
            models: { flagship: chosen, slm: chosen },
          });
          expect(bothRoles.models?.flagship).toBe(chosen);
          expect(bothRoles.models?.slm).toBe(chosen);
          expect(bothRoles.models?.[otherRole]).toBe(chosen);

          // (3) The Active_Route_Map designates this record for the role.
          const activeRoutes = ActiveRouteMapSchema.parse({ [role]: record.id });
          expect(activeRoutes[role]).toBe(record.id);
        },
      ),
      { numRuns: 200 },
    );
  });
});

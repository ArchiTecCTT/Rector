import { describe, expect, it } from "vitest";

import { SkillFrontmatterSchema } from "../src/memory/skillSchema";

describe("skill schema", () => {
  it("parses valid agentskills-compatible frontmatter", () => {
    const parsed = SkillFrontmatterSchema.parse({
      name: "engineering-plan",
      description: "Plan scoped engineering work before code changes.",
      prerequisites: {
        commands: ["npm test"],
        platforms: ["win32", "linux"],
      },
      metadata: {
        tags: ["engineering", "planning"],
        related_skills: ["engineering-tdd"],
        risk: "low",
      },
    });

    expect(parsed.name).toBe("engineering-plan");
    expect(parsed.metadata?.risk).toBe("low");
    expect(parsed.metadata?.tags).toContain("engineering");
  });

  it("rejects missing names", () => {
    const parsed = SkillFrontmatterSchema.safeParse({
      description: "No name is present.",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invalid risk enums", () => {
    const parsed = SkillFrontmatterSchema.safeParse({
      name: "unsafe-skill",
      description: "Invalid risk value.",
      metadata: { risk: "critical" },
    });

    expect(parsed.success).toBe(false);
  });
});

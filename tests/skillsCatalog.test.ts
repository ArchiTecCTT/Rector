import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InMemoryTruthLibrary, SkillsCatalog, parseSkillDocument, syncSkillsToTruthLibrary } from "../src/memory";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rector-skills-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, id: string, frontmatter: string, body = "Body"): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

describe("skills catalog", () => {
  it("scans valid skill directories and ignores invalid folders", () => {
    const root = tempRoot();
    writeSkill(root, "engineering-plan", "name: engineering-plan\ndescription: Plan work.\nmetadata:\n  tags: [engineering]\n  risk: low");
    fs.mkdirSync(path.join(root, "missing-manifest"));
    writeSkill(root, "invalid", "description: Missing name.");

    const catalog = new SkillsCatalog({ workspaceRoot: root, bundledRoot: "." });

    expect(catalog.scanBundled().map((skill) => skill.id)).toEqual(["engineering-plan"]);
    expect(parseSkillDocument(fs.readFileSync(path.join(root, "engineering-plan", "SKILL.md"), "utf8"))?.frontmatter.name)
      .toBe("engineering-plan");
  });

  it("merges bundled and user skills with user skills overriding the same id", () => {
    const root = tempRoot();
    writeSkill(path.join(root, "skills"), "engineering-plan", "name: bundled\ndescription: Bundled plan.\nmetadata:\n  risk: low");
    writeSkill(path.join(root, ".rector", "skills"), "engineering-plan", "name: user\ndescription: User plan.\nmetadata:\n  risk: low");
    writeSkill(path.join(root, "skills"), "engineering-debug", "name: engineering-debug\ndescription: Debug.\nmetadata:\n  risk: low");

    const catalog = new SkillsCatalog({ workspaceRoot: root });
    const list = catalog.list();

    expect(list.map((skill) => skill.id)).toEqual(["engineering-debug", "engineering-plan"]);
    expect(catalog.get("engineering-plan")?.frontmatter.name).toBe("user");
    expect(catalog.list({ bundledOnly: true }).find((skill) => skill.id === "engineering-plan")?.frontmatter.name)
      .toBe("bundled");
  });

  it("invalidates the scan cache when SKILL.md mtime changes", () => {
    const root = tempRoot();
    writeSkill(root, "engineering-plan", "name: first\ndescription: First.\nmetadata:\n  risk: low");
    const skillFile = path.join(root, "engineering-plan", "SKILL.md");
    const catalog = new SkillsCatalog({ workspaceRoot: root, bundledRoot: "." });

    expect(catalog.scanBundled()[0]?.frontmatter.name).toBe("first");

    fs.writeFileSync(skillFile, "---\nname: second\ndescription: Second.\nmetadata:\n  risk: low\n---\n\nBody", "utf8");
    fs.utimesSync(skillFile, new Date("2026-06-13T00:00:00.000Z"), new Date("2026-06-13T00:00:00.000Z"));

    expect(catalog.scanBundled()[0]?.frontmatter.name).toBe("second");
  });

  it("lists nested skill files relative to the skill root", () => {
    const root = tempRoot();
    writeSkill(root, "engineering-debug", "name: engineering-debug\ndescription: Debug.\nmetadata:\n  risk: low");
    fs.mkdirSync(path.join(root, "engineering-debug", "references"), { recursive: true });
    fs.writeFileSync(path.join(root, "engineering-debug", "references", "debug.md"), "Debug reference", "utf8");

    const catalog = new SkillsCatalog({ workspaceRoot: root, bundledRoot: "." });

    expect(catalog.scanBundled()[0]?.files.map((file) => file.relativePath)).toContain("references/debug.md");
  });

  it("bridges skills to truth-library skill items by tag", () => {
    const root = tempRoot();
    writeSkill(root, "engineering-tdd", "name: engineering-tdd\ndescription: TDD loop.\nmetadata:\n  tags:\n    - engineering\n    - testing\n  risk: low", "Write the failing test first.");
    const catalog = new SkillsCatalog({ workspaceRoot: root, bundledRoot: "." });
    const library = new InMemoryTruthLibrary({ now: () => "2026-06-13T00:00:00.000Z" });

    syncSkillsToTruthLibrary(catalog, library);

    const results = library.search({ query: "failing test", kinds: ["skill"], tags: ["engineering"] });
    expect(results[0]?.item.kind).toBe("skill");
    expect(results[0]?.item.tags).toContain("engineering-tdd");
  });
});

import nodeFs from "node:fs";
import nodePath from "node:path";
import { redactString } from "../security/redaction";
import {
  SkillFrontmatterSchema,
  SkillManifestSchema,
  SkillManifestSummarySchema,
  normalizeSkillStrings,
  skillRiskOf,
  skillTagsOf,
  type SkillFrontmatter,
  type SkillManifest,
  type SkillManifestSummary,
} from "./skillSchema";
import type { TruthItem, TruthItemUpsert } from "./truthLibrary";

const DEFAULT_MAX_SCAN_DEPTH = 3;
const DEFAULT_TRUTH_BODY_MAX_CHARS = 8_000;

export interface SkillsCatalogFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string, options?: { withFileTypes?: boolean }): Array<string | SkillsCatalogDirent>;
  statSync(path: string): SkillsCatalogStats;
}

export interface SkillsCatalogDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface SkillsCatalogStats {
  mtimeMs: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface SkillsCatalogOptions {
  workspaceRoot?: string;
  bundledRoot?: string;
  userRoot?: string;
  fsImpl?: SkillsCatalogFs;
  maxScanDepth?: number;
  now?: () => string;
}

export interface SkillsCatalogListOptions {
  bundledOnly?: boolean;
  tags?: string[];
}

export interface TruthLibraryWriter {
  upsert(input: TruthItemUpsert): TruthItem;
}

interface CacheEntry {
  signature: string;
  manifests: SkillManifest[];
}

interface ParsedSkillDocument {
  frontmatter: SkillFrontmatter;
  body: string;
}

export class SkillsCatalog {
  private readonly workspaceRoot: string;
  private readonly bundledRoot: string;
  private readonly userRoot: string;
  private readonly fsImpl: SkillsCatalogFs;
  private readonly maxScanDepth: number;
  private readonly now: () => string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: SkillsCatalogOptions = {}) {
    this.workspaceRoot = nodePath.resolve(options.workspaceRoot ?? process.cwd());
    this.bundledRoot = options.bundledRoot ?? "skills";
    this.userRoot = options.userRoot ?? ".rector/skills";
    this.fsImpl = options.fsImpl ?? (nodeFs as unknown as SkillsCatalogFs);
    this.maxScanDepth = Math.max(1, Math.trunc(options.maxScanDepth ?? DEFAULT_MAX_SCAN_DEPTH));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  scanBundled(root = this.bundledRoot): SkillManifest[] {
    return this.scanRoot(root, true);
  }

  scanUser(root = this.userRoot): SkillManifest[] {
    return this.scanRoot(root, false);
  }

  get(id: string): SkillManifest | undefined {
    return this.list().find((manifest) => manifest.id === id);
  }

  list(options: SkillsCatalogListOptions = {}): SkillManifest[] {
    const manifestsById = new Map<string, SkillManifest>();
    for (const manifest of this.scanBundled()) {
      manifestsById.set(manifest.id, manifest);
    }
    if (!options.bundledOnly) {
      for (const manifest of this.scanUser()) {
        manifestsById.set(manifest.id, manifest);
      }
    }

    const wantedTags = normalizeSkillStrings(options.tags ?? []);
    return [...manifestsById.values()]
      .filter((manifest) => {
        if (wantedTags.length === 0) return true;
        const tags = skillTagsOf(manifest);
        return wantedTags.every((tag) => tags.includes(tag));
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneManifest);
  }

  readSkillBody(manifestOrId: SkillManifest | string): string {
    const manifest = typeof manifestOrId === "string" ? this.get(manifestOrId) : manifestOrId;
    if (!manifest) return "";
    const raw = this.fsImpl.readFileSync(manifest.skillPath, "utf8");
    return parseSkillDocument(raw)?.body ?? "";
  }

  readSkillReference(manifest: SkillManifest, relativePath: string): string | undefined {
    if (!isSafeRelativePath(relativePath)) return undefined;
    const skillDir = nodePath.dirname(manifest.skillPath);
    const candidate = nodePath.resolve(skillDir, relativePath);
    if (!isPathInside(skillDir, candidate) || !this.fsImpl.existsSync(candidate)) return undefined;
    const stats = this.safeStat(candidate);
    if (!stats?.isFile()) return undefined;
    return this.fsImpl.readFileSync(candidate, "utf8");
  }

  toApiSummary(manifest: SkillManifest): SkillManifestSummary {
    return skillManifestToApiSummary(manifest, this.workspaceRoot);
  }

  toApiManifest(manifest: SkillManifest): SkillManifest {
    return {
      ...cloneManifest(manifest),
      skillPath: skillPathForApi(manifest.skillPath, this.workspaceRoot),
    };
  }

  workspaceRelativePath(path: string): string {
    return skillPathForApi(path, this.workspaceRoot);
  }

  private scanRoot(root: string, bundled: boolean): SkillManifest[] {
    const absoluteRoot = resolveRoot(this.workspaceRoot, root);
    const cacheKey = `${bundled ? "bundled" : "user"}:${absoluteRoot}`;
    const signature = this.computeSignature(absoluteRoot);
    const cached = this.cache.get(cacheKey);
    if (cached?.signature === signature) {
      return cached.manifests.map(cloneManifest);
    }

    const manifests = this.collectSkillDirs(absoluteRoot, 0)
      .map((dir) => this.readManifest(dir, bundled))
      .filter((manifest): manifest is SkillManifest => manifest !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));

    this.cache.set(cacheKey, { signature, manifests: manifests.map(cloneManifest) });
    return manifests.map(cloneManifest);
  }

  private collectSkillDirs(root: string, depth: number): string[] {
    if (depth > this.maxScanDepth || !this.fsImpl.existsSync(root)) return [];
    const stats = this.safeStat(root);
    if (!stats?.isDirectory()) return [];

    const dirs: string[] = [];
    const skillPath = nodePath.join(root, "SKILL.md");
    if (this.fsImpl.existsSync(skillPath)) {
      dirs.push(root);
    }

    if (depth >= this.maxScanDepth) return dirs;
    for (const entry of this.sortedEntries(root)) {
      if (!entry.isDirectory()) continue;
      dirs.push(...this.collectSkillDirs(nodePath.join(root, entry.name), depth + 1));
    }
    return dirs;
  }

  private readManifest(skillDir: string, bundled: boolean): SkillManifest | undefined {
    const skillPath = nodePath.join(skillDir, "SKILL.md");
    try {
      const parsed = parseSkillDocument(this.fsImpl.readFileSync(skillPath, "utf8"));
      if (!parsed) return undefined;
      const manifest = SkillManifestSchema.safeParse({
        id: nodePath.basename(skillDir),
        frontmatter: parsed.frontmatter,
        skillPath,
        bundled,
        files: this.collectFiles(skillDir, skillDir, 0),
      });
      return manifest.success ? manifest.data : undefined;
    } catch {
      return undefined;
    }
  }

  private collectFiles(skillRoot: string, root: string, depth: number): Array<{ relativePath: string; sizeBytes: number }> {
    if (depth > this.maxScanDepth) return [];
    const files: Array<{ relativePath: string; sizeBytes: number }> = [];
    for (const entry of this.sortedEntries(root)) {
      const absolute = nodePath.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectFiles(skillRoot, absolute, depth + 1));
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = this.safeStat(absolute);
      if (!stats) continue;
      files.push({
        relativePath: toPosix(nodePath.relative(skillRoot, absolute)),
        sizeBytes: Math.max(0, Math.trunc(stats.size)),
      });
    }
    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private computeSignature(root: string): string {
    if (!this.fsImpl.existsSync(root)) return "missing";
    const parts: string[] = [];
    const visit = (dir: string, depth: number): void => {
      if (depth > this.maxScanDepth || !this.fsImpl.existsSync(dir)) return;
      const stats = this.safeStat(dir);
      if (!stats) return;
      parts.push(`${toPosix(nodePath.relative(root, dir)) || "."}:d:${stats.mtimeMs}:${stats.size}`);
      if (!stats.isDirectory()) return;
      for (const entry of this.sortedEntries(dir)) {
        const absolute = nodePath.join(dir, entry.name);
        const entryStats = this.safeStat(absolute);
        if (!entryStats) continue;
        parts.push(`${toPosix(nodePath.relative(root, absolute))}:${entryStats.isDirectory() ? "d" : "f"}:${entryStats.mtimeMs}:${entryStats.size}`);
        if (entryStats.isDirectory()) visit(absolute, depth + 1);
      }
    };
    visit(root, 0);
    return parts.sort().join("|");
  }

  private sortedEntries(dir: string): SkillsCatalogDirent[] {
    try {
      const entries = this.fsImpl.readdirSync(dir, { withFileTypes: true });
      return entries
        .map((entry) => normalizeDirent(entry, dir, this.fsImpl))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  }

  private safeStat(path: string): SkillsCatalogStats | undefined {
    try {
      return this.fsImpl.statSync(path);
    } catch {
      return undefined;
    }
  }

  currentTimestamp(): string {
    return this.now();
  }
}

export function parseSkillDocument(content: string): ParsedSkillDocument | undefined {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  const frontmatter = parseYamlSubset(match[1] ?? "");
  const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) return undefined;
  return { frontmatter: parsed.data, body: match[2] ?? "" };
}

export function skillToTruthItem(
  manifest: SkillManifest,
  body: string,
  options: { now?: () => string; maxBodyChars?: number } = {},
): TruthItemUpsert {
  const now = options.now?.() ?? new Date().toISOString();
  const bodyMax = options.maxBodyChars ?? DEFAULT_TRUTH_BODY_MAX_CHARS;
  const content = truncateForIndex(redactString(body), bodyMax);
  const skillUri = `skill://catalog/${encodeURIComponent(manifest.id)}`;
  return {
    id: `skill:${manifest.id}`,
    kind: "skill",
    title: redactString(manifest.frontmatter.name),
    content: content.length > 0 ? content : redactString(manifest.frontmatter.description),
    status: "TRUSTED",
    provenance: {
      source: skillUri,
      sourceType: "file",
      observedAt: now,
      citations: [{ title: `${manifest.id}/SKILL.md`, uri: skillUri }],
    },
    citations: [{ title: manifest.frontmatter.name, uri: skillUri }],
    tags: normalizeSkillStrings([...(manifest.frontmatter.metadata?.tags ?? []), "skill", manifest.id]),
    updatedAt: now,
  };
}

export function syncSkillsToTruthLibrary(catalog: SkillsCatalog, truthLibrary: TruthLibraryWriter): TruthItem[] {
  return catalog.list().map((manifest) =>
    truthLibrary.upsert(
      skillToTruthItem(manifest, catalog.readSkillBody(manifest), { now: () => catalog.currentTimestamp() }),
    ),
  );
}

export function skillManifestToApiSummary(
  manifest: SkillManifest,
  workspaceRoot = process.cwd(),
): SkillManifestSummary {
  return SkillManifestSummarySchema.parse({
    id: manifest.id,
    name: redactString(manifest.frontmatter.name),
    description: redactString(manifest.frontmatter.description),
    tags: skillTagsOf(manifest).map(redactString),
    risk: skillRiskOf(manifest),
    bundled: manifest.bundled,
    skillPath: skillPathForApi(manifest.skillPath, workspaceRoot),
  });
}

export function skillPathForApi(skillPath: string, workspaceRoot = process.cwd()): string {
  const root = nodePath.resolve(workspaceRoot);
  const absolute = nodePath.resolve(skillPath);
  if (isPathInside(root, absolute)) {
    return toPosix(nodePath.relative(root, absolute));
  }
  return `[redacted]/${toPosix(nodePath.basename(nodePath.dirname(absolute)))}/SKILL.md`;
}

function parseYamlSubset(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: "prerequisites" | "metadata" | undefined;
  let arrayKey: "commands" | "env_vars" | "platforms" | "tags" | "related_skills" | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim().length === 0) continue;
    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const line = withoutComment.trim();

    if (indent === 0) {
      section = undefined;
      arrayKey = undefined;
      const parsed = keyValue(line);
      if (!parsed) continue;
      if (parsed.value === "") {
        if (parsed.key === "prerequisites" || parsed.key === "metadata") {
          section = parsed.key;
          root[parsed.key] = recordFrom(root[parsed.key]) ?? {};
        }
        continue;
      }
      root[parsed.key] = parseYamlScalar(parsed.value);
      continue;
    }

    if (indent === 2 && section) {
      const target = recordFrom(root[section]) ?? {};
      root[section] = target;
      const parsed = keyValue(line);
      if (!parsed) continue;
      arrayKey = undefined;
      if (parsed.value === "") {
        if (isSkillArrayKey(parsed.key)) {
          arrayKey = parsed.key;
          target[parsed.key] = [];
        } else {
          target[parsed.key] = {};
        }
        continue;
      }
      target[parsed.key] = parseYamlScalar(parsed.value);
      continue;
    }

    if (indent >= 4 && section && arrayKey && line.startsWith("- ")) {
      const target = recordFrom(root[section]) ?? {};
      const values = Array.isArray(target[arrayKey]) ? target[arrayKey] as unknown[] : [];
      values.push(parseYamlScalar(line.slice(2).trim()));
      target[arrayKey] = values;
      root[section] = target;
    }
  }

  return root;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    if (char === "\"" && !inSingle) inDouble = !inDouble;
    if (char === "#" && !inSingle && !inDouble) return line.slice(0, index);
  }
  return line;
}

function keyValue(line: string): { key: string; value: string } | undefined {
  const index = line.indexOf(":");
  if (index <= 0) return undefined;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

function parseYamlScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseYamlScalar(part.trim()));
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function isSkillArrayKey(value: string): value is "commands" | "env_vars" | "platforms" | "tags" | "related_skills" {
  return value === "commands" || value === "env_vars" || value === "platforms" || value === "tags" || value === "related_skills";
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resolveRoot(workspaceRoot: string, root: string): string {
  return nodePath.isAbsolute(root) ? nodePath.resolve(root) : nodePath.resolve(workspaceRoot, root);
}

function normalizeDirent(entry: string | SkillsCatalogDirent, dir: string, fsImpl: SkillsCatalogFs): SkillsCatalogDirent {
  if (typeof entry !== "string") return entry;
  const absolute = nodePath.join(dir, entry);
  const stats = fsImpl.statSync(absolute);
  return {
    name: entry,
    isDirectory: () => stats.isDirectory(),
    isFile: () => stats.isFile(),
  };
}

function isSafeRelativePath(path: string): boolean {
  if (!path || nodePath.isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return path.replace(/\\/g, "/").split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function truncateForIndex(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function cloneManifest(manifest: SkillManifest): SkillManifest {
  return structuredClone(manifest);
}

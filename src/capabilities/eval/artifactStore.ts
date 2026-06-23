import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { redactSecrets, redactString } from "../../security/redaction";

export const RAW_ARTIFACT_SCHEMA_VERSION = "rector.capability.rawArtifact.v1";

export const RawArtifactRedactionStateSchema = z.enum(["redacted", "no_secrets_detected"]);

const SafePathSegmentSchema = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/);

export const WriteRawArtifactInputSchema = z
  .object({
    callId: SafePathSegmentSchema,
    artifactName: SafePathSegmentSchema,
    content: z.string(),
    contentType: z.string().min(1).default("text/plain"),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

export const RawArtifactRecordSchema = z
  .object({
    schemaVersion: z.literal(RAW_ARTIFACT_SCHEMA_VERSION),
    callId: SafePathSegmentSchema,
    artifactName: SafePathSegmentSchema,
    uri: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    contentType: z.string().min(1),
    redactionState: RawArtifactRedactionStateSchema,
    metadata: z.record(z.unknown()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();

const LocalFsRawArtifactStoreOptionsSchema = z
  .object({
    rootDir: z.string().min(1),
    now: z.function().args().returns(z.date()).optional(),
  })
  .strict();

export type WriteRawArtifactInput = Readonly<z.infer<typeof WriteRawArtifactInputSchema>>;
export type RawArtifactRedactionState = z.infer<typeof RawArtifactRedactionStateSchema>;
export type RawArtifactRecord = Readonly<z.infer<typeof RawArtifactRecordSchema>>;
export type StoredRawArtifact = {
  readonly record: RawArtifactRecord;
  readonly content: string;
};
export type LocalFsRawArtifactStoreOptions = Readonly<z.infer<typeof LocalFsRawArtifactStoreOptionsSchema>>;

export interface RawArtifactStore {
  writeRawArtifact(input: WriteRawArtifactInput): Promise<RawArtifactRecord>;
  readRawArtifact(uri: string): Promise<StoredRawArtifact>;
  listRawArtifacts(callId: string): Promise<readonly RawArtifactRecord[]>;
}

export class LocalFsRawArtifactStore implements RawArtifactStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: LocalFsRawArtifactStoreOptions) {
    const parsed = LocalFsRawArtifactStoreOptionsSchema.parse(options);
    this.rootDir = path.resolve(parsed.rootDir);
    this.now = parsed.now ?? (() => new Date());
  }

  async writeRawArtifact(input: WriteRawArtifactInput): Promise<RawArtifactRecord> {
    const parsed = WriteRawArtifactInputSchema.parse(input);
    const redactedContent = redactString(parsed.content);
    const redactedMetadata = redactSecrets(parsed.metadata);
    const artifactPath = this.artifactPath(parsed.callId, parsed.artifactName);
    const recordPath = this.recordPath(parsed.callId, parsed.artifactName);
    const record: RawArtifactRecord = {
      schemaVersion: RAW_ARTIFACT_SCHEMA_VERSION,
      callId: parsed.callId,
      artifactName: parsed.artifactName,
      uri: artifactUri(parsed.callId, parsed.artifactName),
      sha256: sha256Hex(redactedContent),
      sizeBytes: Buffer.byteLength(redactedContent, "utf8"),
      contentType: parsed.contentType,
      redactionState: parsed.content === redactedContent ? "no_secrets_detected" : "redacted",
      metadata: redactedMetadata,
      createdAt: this.now().toISOString(),
    };
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, redactedContent, "utf8");
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return RawArtifactRecordSchema.parse(record);
  }

  async readRawArtifact(uri: string): Promise<StoredRawArtifact> {
    const ref = parseArtifactUri(uri);
    const [recordText, content] = await Promise.all([
      fs.readFile(this.recordPath(ref.callId, ref.artifactName), "utf8"),
      fs.readFile(this.artifactPath(ref.callId, ref.artifactName), "utf8"),
    ]);
    const rawRecord: unknown = JSON.parse(recordText);
    return { record: RawArtifactRecordSchema.parse(rawRecord), content };
  }

  async listRawArtifacts(callId: string): Promise<readonly RawArtifactRecord[]> {
    const parsedCallId = SafePathSegmentSchema.parse(callId);
    const callDir = this.callDir(parsedCallId);
    const entries = await readDirOrEmpty(callDir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".metadata.json"))
        .map(async (entry) => {
          const recordText = await fs.readFile(path.join(callDir, entry), "utf8");
          const rawRecord: unknown = JSON.parse(recordText);
          return RawArtifactRecordSchema.parse(rawRecord);
        }),
    );
    return records.sort((left, right) => compareUtf16(left.artifactName, right.artifactName));
  }

  private callDir(callId: string): string {
    return path.join(this.rootDir, callId);
  }

  private artifactPath(callId: string, artifactName: string): string {
    return path.join(this.callDir(callId), artifactName);
  }

  private recordPath(callId: string, artifactName: string): string {
    return path.join(this.callDir(callId), `${artifactName}.metadata.json`);
  }
}

function artifactUri(callId: string, artifactName: string): string {
  return `artifact://${callId}/${artifactName}`;
}

function parseArtifactUri(uri: string): { readonly callId: string; readonly artifactName: string } {
  const parsed = new URL(uri);
  const artifactName = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  return {
    callId: SafePathSegmentSchema.parse(parsed.hostname),
    artifactName: SafePathSegmentSchema.parse(artifactName),
  };
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function readDirOrEmpty(dir: string): Promise<readonly string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

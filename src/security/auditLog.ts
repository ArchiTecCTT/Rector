import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { redactString } from "./redaction";

export const AuditOutcomeSchema = z.enum(["success", "denied", "failed"]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  actorUserId: z.string().min(1).optional(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1).optional(),
  outcome: AuditOutcomeSchema,
  reason: z.string().optional(),
  ipHash: z.string().min(1).optional(),
  userAgentHash: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export type CreateAuditEventInput = Omit<AuditEvent, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export interface AuditEventFilter {
  workspaceId?: string;
  actorUserId?: string;
  action?: string;
  outcome?: AuditOutcome;
  limit?: number;
}

export interface AuditLogService {
  record(input: CreateAuditEventInput): Promise<AuditEvent>;
  list(filter?: AuditEventFilter): Promise<AuditEvent[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sanitizeAuditInput(input: CreateAuditEventInput, now: () => string): AuditEvent {
  return AuditEventSchema.parse({
    ...input,
    id: input.id ?? randomUUID(),
    reason: input.reason === undefined ? undefined : redactString(input.reason),
    createdAt: input.createdAt ?? now(),
  });
}

function filterEvents(events: AuditEvent[], filter: AuditEventFilter = {}): AuditEvent[] {
  const limit = filter.limit ?? 100;
  return events
    .filter((event) => filter.workspaceId === undefined || event.workspaceId === filter.workspaceId)
    .filter((event) => filter.actorUserId === undefined || event.actorUserId === filter.actorUserId)
    .filter((event) => filter.action === undefined || event.action === filter.action)
    .filter((event) => filter.outcome === undefined || event.outcome === filter.outcome)
    .slice(-limit)
    .map(clone);
}

export function hashAuditValue(value: string | undefined, salt = "rector.audit.v1"): string | undefined {
  if (!value || value.trim().length === 0) return undefined;
  return createHash("sha256").update(salt).update("\0").update(value).digest("hex");
}

export function createInMemoryAuditLogService(options: { now?: () => string } = {}): AuditLogService {
  const events: AuditEvent[] = [];
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async record(input: CreateAuditEventInput): Promise<AuditEvent> {
      const event = sanitizeAuditInput(input, now);
      events.push(clone(event));
      return clone(event);
    },

    async list(filter?: AuditEventFilter): Promise<AuditEvent[]> {
      return filterEvents(events, filter);
    },
  };
}

export interface LocalAuditLogFs {
  readFile(path: string): Promise<string | undefined>;
  appendFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface LocalAuditLogOptions {
  filePath: string;
  fsImpl?: LocalAuditLogFs;
  now?: () => string;
}

function defaultAuditFs(): LocalAuditLogFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async appendFile(path: string, data: string): Promise<void> {
      await appendFile(path, data, "utf8");
    },
    async mkdir(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
  };
}

/** Durable JSONL audit backing for self-hosted/VPS deployments. */
export function createLocalAuditLogService(options: LocalAuditLogOptions): AuditLogService {
  const fsImpl = options.fsImpl ?? defaultAuditFs();
  const now = options.now ?? (() => new Date().toISOString());

  async function readEvents(): Promise<AuditEvent[]> {
    const raw = await fsImpl.readFile(options.filePath);
    if (!raw || raw.trim().length === 0) return [];
    const events: AuditEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(AuditEventSchema.parse(JSON.parse(line)));
      } catch {
        // Skip corrupted lines rather than surfacing possibly-sensitive raw content.
      }
    }
    return events;
  }

  return {
    async record(input: CreateAuditEventInput): Promise<AuditEvent> {
      const event = sanitizeAuditInput(input, now);
      await fsImpl.mkdir(dirname(options.filePath));
      await fsImpl.appendFile(options.filePath, `${JSON.stringify(event)}\n`);
      return clone(event);
    },

    async list(filter?: AuditEventFilter): Promise<AuditEvent[]> {
      return filterEvents(await readEvents(), filter);
    },
  };
}

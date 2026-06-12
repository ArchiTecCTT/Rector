import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactString } from "../security/redaction";
import {
  MemoryAssignmentStateSchema,
  MemoryRoleAssignmentSchema,
  emptyMemoryAssignmentState,
  type MemoryAssignmentState,
  type MemoryRole,
  type MemoryRoleAssignment,
} from "./memoryAssignments";

export type MemoryAssignmentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface MemoryAssignmentFilter {
  userId?: string;
  workspaceId?: string;
  role?: MemoryRole;
}

export interface MemoryAssignmentStore {
  getState(): Promise<MemoryAssignmentState>;
  listAssignments(filter?: MemoryAssignmentFilter): Promise<MemoryRoleAssignment[]>;
  upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>>;
  removeAssignment(id: string): Promise<MemoryAssignmentResult<void>>;
  resetAssignments(filter?: MemoryAssignmentFilter): Promise<MemoryAssignmentResult<void>>;
}

export interface MemoryAssignmentFs {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, data: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
}

export interface LocalMemoryAssignmentStoreOptions {
  filePath: string;
  fsImpl?: MemoryAssignmentFs;
}

function defaultMemoryAssignmentFs(): MemoryAssignmentFs {
  return {
    async readFile(path: string): Promise<string | undefined> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async writeFile(path: string, data: string): Promise<void> {
      await writeFile(path, data, "utf8");
    },
    async rename(fromPath: string, toPath: string): Promise<void> {
      await rename(fromPath, toPath);
    },
    async mkdir(dirPath: string): Promise<void> {
      await mkdir(dirPath, { recursive: true });
    },
  };
}

function toRedactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message);
}

function matchesFilter(assignment: MemoryRoleAssignment, filter: MemoryAssignmentFilter = {}): boolean {
  if (filter.role !== undefined && assignment.role !== filter.role) return false;
  if (filter.userId !== undefined && assignment.userId !== filter.userId) return false;
  if (filter.workspaceId !== undefined && assignment.workspaceId !== filter.workspaceId) return false;
  return true;
}

function normalizeAssignment(assignment: MemoryRoleAssignment): MemoryRoleAssignment {
  return MemoryRoleAssignmentSchema.parse(assignment);
}

export function createLocalMemoryAssignmentStore(
  options: LocalMemoryAssignmentStoreOptions,
): MemoryAssignmentStore {
  const { filePath } = options;
  const fsImpl = options.fsImpl ?? defaultMemoryAssignmentFs();

  async function readState(): Promise<MemoryAssignmentState> {
    const raw = await fsImpl.readFile(filePath);
    if (raw === undefined || raw.trim() === "") return emptyMemoryAssignmentState();
    const parsed = MemoryAssignmentStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return emptyMemoryAssignmentState();
    return parsed.data;
  }

  async function writeState(state: MemoryAssignmentState): Promise<void> {
    await fsImpl.mkdir(dirname(filePath));
    const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await fsImpl.writeFile(tempPath, JSON.stringify(state, null, 2));
    await fsImpl.rename(tempPath, filePath);
  }

  return {
    async getState(): Promise<MemoryAssignmentState> {
      try {
        return await readState();
      } catch {
        return emptyMemoryAssignmentState();
      }
    },

    async listAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryRoleAssignment[]> {
      const state = await this.getState();
      return state.assignments.filter((assignment) => matchesFilter(assignment, filter));
    },

    async upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>> {
      try {
        const normalized = normalizeAssignment(assignment);
        const state = await readState();
        const assignments = [...state.assignments];
        const index = assignments.findIndex((existing) => existing.id === normalized.id);
        if (index >= 0) assignments[index] = normalized;
        else assignments.push(normalized);
        await writeState({ ...state, assignments });
        return { ok: true, value: normalized };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async removeAssignment(id: string): Promise<MemoryAssignmentResult<void>> {
      try {
        const state = await readState();
        await writeState({
          ...state,
          assignments: state.assignments.filter((assignment) => assignment.id !== id),
        });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },

    async resetAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryAssignmentResult<void>> {
      try {
        const state = await readState();
        const hasFilter = filter.role !== undefined || filter.userId !== undefined || filter.workspaceId !== undefined;
        const assignments = hasFilter
          ? state.assignments.filter((assignment) => !matchesFilter(assignment, filter))
          : [];
        await writeState({ ...state, assignments });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: toRedactedError(error) };
      }
    },
  };
}

export function createInMemoryMemoryAssignmentStore(initial?: MemoryAssignmentState): MemoryAssignmentStore {
  let state: MemoryAssignmentState = initial
    ? MemoryAssignmentStateSchema.parse(initial)
    : emptyMemoryAssignmentState();

  return {
    async getState(): Promise<MemoryAssignmentState> {
      return structuredClone(state);
    },

    async listAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryRoleAssignment[]> {
      return structuredClone(state.assignments.filter((assignment) => matchesFilter(assignment, filter)));
    },

    async upsertAssignment(assignment: MemoryRoleAssignment): Promise<MemoryAssignmentResult<MemoryRoleAssignment>> {
      const normalized = normalizeAssignment(assignment);
      const assignments = [...state.assignments];
      const index = assignments.findIndex((existing) => existing.id === normalized.id);
      if (index >= 0) assignments[index] = normalized;
      else assignments.push(normalized);
      state = { ...state, assignments };
      return { ok: true, value: structuredClone(normalized) };
    },

    async removeAssignment(id: string): Promise<MemoryAssignmentResult<void>> {
      state = { ...state, assignments: state.assignments.filter((assignment) => assignment.id !== id) };
      return { ok: true, value: undefined };
    },

    async resetAssignments(filter: MemoryAssignmentFilter = {}): Promise<MemoryAssignmentResult<void>> {
      const hasFilter = filter.role !== undefined || filter.userId !== undefined || filter.workspaceId !== undefined;
      state = {
        ...state,
        assignments: hasFilter
          ? state.assignments.filter((assignment) => !matchesFilter(assignment, filter))
          : [],
      };
      return { ok: true, value: undefined };
    },
  };
}

export function selectMemoryAssignmentForRole(
  assignments: MemoryRoleAssignment[],
  input: { role: MemoryRole; userId?: string; workspaceId?: string },
): MemoryRoleAssignment | undefined {
  const candidates = assignments.filter((assignment) => {
    if (assignment.role !== input.role) return false;
    if (assignment.userId !== undefined && assignment.userId !== input.userId) return false;
    if (assignment.workspaceId !== undefined && assignment.workspaceId !== input.workspaceId) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const score = (assignment: MemoryRoleAssignment): number =>
      (assignment.userId ? 2 : 0) + (assignment.workspaceId ? 1 : 0);
    const bySpecificity = score(b) - score(a);
    if (bySpecificity !== 0) return bySpecificity;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });

  return candidates[0];
}

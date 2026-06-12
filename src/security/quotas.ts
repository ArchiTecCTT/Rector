import { z } from "zod";

export const QuotaPolicySchema = z.object({
  maxRunsPerDay: z.number().int().nonnegative().optional(),
  maxUsdPerDay: z.number().nonnegative().optional(),
  maxUsdPerMonth: z.number().nonnegative().optional(),
  maxProviderCallsPerRun: z.number().int().nonnegative().optional(),
  maxSandboxMinutesPerDay: z.number().nonnegative().optional(),
  maxStorageMb: z.number().nonnegative().optional(),
});
export type QuotaPolicy = z.infer<typeof QuotaPolicySchema>;

export const QuotaUsageSchema = z.object({
  workspaceId: z.string().min(1),
  day: z.string().min(1),
  month: z.string().min(1),
  runsToday: z.number().int().nonnegative(),
  usdToday: z.number().nonnegative(),
  usdMonth: z.number().nonnegative(),
  sandboxMinutesToday: z.number().nonnegative(),
  storageMb: z.number().nonnegative(),
  providerCallsByRun: z.record(z.number().int().nonnegative()),
});
export type QuotaUsage = z.infer<typeof QuotaUsageSchema>;

export interface QuotaCheck {
  allowed: boolean;
  reason?: string;
  policy: QuotaPolicy;
  usage: QuotaUsage;
}

export interface QuotaService {
  getPolicy(workspaceId: string): Promise<QuotaPolicy>;
  setPolicy(workspaceId: string, policy: QuotaPolicy): Promise<QuotaPolicy>;
  getUsage(workspaceId: string): Promise<QuotaUsage>;
  checkRunCreation(workspaceId: string): Promise<QuotaCheck>;
  recordRunCreated(workspaceId: string, input?: { estimatedUsd?: number }): Promise<QuotaUsage>;
  checkProviderCall(workspaceId: string, runId: string, input?: { estimatedUsd?: number }): Promise<QuotaCheck>;
  recordProviderCall(workspaceId: string, runId: string, input?: { estimatedUsd?: number }): Promise<QuotaUsage>;
  checkSandboxMinutes(workspaceId: string, minutes: number): Promise<QuotaCheck>;
  recordSandboxMinutes(workspaceId: string, minutes: number): Promise<QuotaUsage>;
  checkStorage(workspaceId: string, storageMb: number): Promise<QuotaCheck>;
  recordStorage(workspaceId: string, storageMb: number): Promise<QuotaUsage>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function emptyUsage(workspaceId: string, date: Date): QuotaUsage {
  return QuotaUsageSchema.parse({
    workspaceId,
    day: dayKey(date),
    month: monthKey(date),
    runsToday: 0,
    usdToday: 0,
    usdMonth: 0,
    sandboxMinutesToday: 0,
    storageMb: 0,
    providerCallsByRun: {},
  });
}

function deny(policy: QuotaPolicy, usage: QuotaUsage, reason: string): QuotaCheck {
  return { allowed: false, reason, policy: clone(policy), usage: clone(usage) };
}

function allow(policy: QuotaPolicy, usage: QuotaUsage): QuotaCheck {
  return { allowed: true, policy: clone(policy), usage: clone(usage) };
}

export function createInMemoryQuotaService(options: {
  policies?: Record<string, QuotaPolicy>;
  now?: () => Date;
} = {}): QuotaService {
  const policies = new Map<string, QuotaPolicy>();
  for (const [workspaceId, policy] of Object.entries(options.policies ?? {})) {
    policies.set(workspaceId, QuotaPolicySchema.parse(policy));
  }
  const usageByWorkspace = new Map<string, QuotaUsage>();
  const now = options.now ?? (() => new Date());

  function getCurrentUsage(workspaceId: string): QuotaUsage {
    const date = now();
    const existing = usageByWorkspace.get(workspaceId);
    if (!existing || existing.day !== dayKey(date) || existing.month !== monthKey(date)) {
      const reset = emptyUsage(workspaceId, date);
      // Preserve storage across daily/monthly resets; it is a current allocation, not a daily counter.
      reset.storageMb = existing?.storageMb ?? 0;
      usageByWorkspace.set(workspaceId, reset);
      return reset;
    }
    return existing;
  }

  function currentPolicy(workspaceId: string): QuotaPolicy {
    return policies.get(workspaceId) ?? {};
  }

  function checkUsd(policy: QuotaPolicy, usage: QuotaUsage, deltaUsd: number): QuotaCheck | undefined {
    if (policy.maxUsdPerDay !== undefined && usage.usdToday + deltaUsd > policy.maxUsdPerDay) {
      return deny(policy, usage, `Daily USD quota exceeded: ${usage.usdToday + deltaUsd} > ${policy.maxUsdPerDay}.`);
    }
    if (policy.maxUsdPerMonth !== undefined && usage.usdMonth + deltaUsd > policy.maxUsdPerMonth) {
      return deny(policy, usage, `Monthly USD quota exceeded: ${usage.usdMonth + deltaUsd} > ${policy.maxUsdPerMonth}.`);
    }
    return undefined;
  }

  return {
    async getPolicy(workspaceId: string): Promise<QuotaPolicy> {
      return clone(currentPolicy(workspaceId));
    },

    async setPolicy(workspaceId: string, policy: QuotaPolicy): Promise<QuotaPolicy> {
      const parsed = QuotaPolicySchema.parse(policy);
      policies.set(workspaceId, clone(parsed));
      return clone(parsed);
    },

    async getUsage(workspaceId: string): Promise<QuotaUsage> {
      return clone(getCurrentUsage(workspaceId));
    },

    async checkRunCreation(workspaceId: string): Promise<QuotaCheck> {
      const policy = currentPolicy(workspaceId);
      const usage = getCurrentUsage(workspaceId);
      if (policy.maxRunsPerDay !== undefined && usage.runsToday + 1 > policy.maxRunsPerDay) {
        return deny(policy, usage, `Daily run quota exceeded: ${usage.runsToday + 1} > ${policy.maxRunsPerDay}.`);
      }
      return allow(policy, usage);
    },

    async recordRunCreated(workspaceId: string, input: { estimatedUsd?: number } = {}): Promise<QuotaUsage> {
      const usage = getCurrentUsage(workspaceId);
      const estimatedUsd = input.estimatedUsd ?? 0;
      usage.runsToday += 1;
      usage.usdToday += estimatedUsd;
      usage.usdMonth += estimatedUsd;
      usageByWorkspace.set(workspaceId, clone(usage));
      return clone(usage);
    },

    async checkProviderCall(workspaceId: string, runId: string, input: { estimatedUsd?: number } = {}): Promise<QuotaCheck> {
      const policy = currentPolicy(workspaceId);
      const usage = getCurrentUsage(workspaceId);
      const currentCalls = usage.providerCallsByRun[runId] ?? 0;
      if (policy.maxProviderCallsPerRun !== undefined && currentCalls + 1 > policy.maxProviderCallsPerRun) {
        return deny(policy, usage, `Provider-call quota for run ${runId} exceeded: ${currentCalls + 1} > ${policy.maxProviderCallsPerRun}.`);
      }
      const usdDenial = checkUsd(policy, usage, input.estimatedUsd ?? 0);
      if (usdDenial) return usdDenial;
      return allow(policy, usage);
    },

    async recordProviderCall(workspaceId: string, runId: string, input: { estimatedUsd?: number } = {}): Promise<QuotaUsage> {
      const usage = getCurrentUsage(workspaceId);
      usage.providerCallsByRun = { ...usage.providerCallsByRun, [runId]: (usage.providerCallsByRun[runId] ?? 0) + 1 };
      const estimatedUsd = input.estimatedUsd ?? 0;
      usage.usdToday += estimatedUsd;
      usage.usdMonth += estimatedUsd;
      usageByWorkspace.set(workspaceId, clone(usage));
      return clone(usage);
    },

    async checkSandboxMinutes(workspaceId: string, minutes: number): Promise<QuotaCheck> {
      const policy = currentPolicy(workspaceId);
      const usage = getCurrentUsage(workspaceId);
      if (policy.maxSandboxMinutesPerDay !== undefined && usage.sandboxMinutesToday + minutes > policy.maxSandboxMinutesPerDay) {
        return deny(policy, usage, `Daily sandbox-minutes quota exceeded: ${usage.sandboxMinutesToday + minutes} > ${policy.maxSandboxMinutesPerDay}.`);
      }
      return allow(policy, usage);
    },

    async recordSandboxMinutes(workspaceId: string, minutes: number): Promise<QuotaUsage> {
      const usage = getCurrentUsage(workspaceId);
      usage.sandboxMinutesToday += minutes;
      usageByWorkspace.set(workspaceId, clone(usage));
      return clone(usage);
    },

    async checkStorage(workspaceId: string, storageMb: number): Promise<QuotaCheck> {
      const policy = currentPolicy(workspaceId);
      const usage = getCurrentUsage(workspaceId);
      if (policy.maxStorageMb !== undefined && storageMb > policy.maxStorageMb) {
        return deny(policy, usage, `Storage quota exceeded: ${storageMb} MB > ${policy.maxStorageMb} MB.`);
      }
      return allow(policy, usage);
    },

    async recordStorage(workspaceId: string, storageMb: number): Promise<QuotaUsage> {
      const usage = getCurrentUsage(workspaceId);
      usage.storageMb = storageMb;
      usageByWorkspace.set(workspaceId, clone(usage));
      return clone(usage);
    },
  };
}

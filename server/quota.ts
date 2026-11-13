import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { timestampMs } from "./probe.js";
import { UsageError } from "./errors.js";

const summarySchema = z.object({ groups: z.array(z.unknown()) });
const groupSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(z.unknown()),
});
const bucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string().optional(),
  window: z.string().optional(),
  disabled: z.boolean().optional(),
  remainingFraction: z.unknown().optional(),
  resetTime: z.unknown().optional(),
});

const quotaInfoSchema = z.object({
  remainingFraction: z.number().optional(),
  resetTime: z.string().optional(),
});

const modelEntrySchema = z.object({
  displayName: z.string().optional(),
  apiProvider: z.string().optional(),
  modelProvider: z.string().optional(),
  disabled: z.boolean().optional(),
  isInternal: z.boolean().optional(),
  quotaInfo: quotaInfoSchema.optional(),
});

const availableModelsSchema = z.object({
  models: z.record(z.string(), z.unknown()),
  agentModelSorts: z.array(z.object({
    groups: z.array(z.object({
      modelIds: z.array(z.string()),
    })).optional(),
  })).optional(),
});

type Bucket = z.infer<typeof bucketSchema>;
type ModelEntry = z.infer<typeof modelEntrySchema>;
type WindowPeriod = "5h" | "weekly" | "other";

export interface ModelCatalog {
  gemini: string[];
  argon: string[];
  carbon: string[];
  argonSharesGemini?: boolean;
  carbonSharesGemini?: boolean;
}

interface ParsedBucket {
  bucket: Bucket;
  period: WindowPeriod;
  usedPct: number | null;
  resetsAtMs: number | null;
}

interface PoolAccumulator {
  poolId: string;
  order: number;
  groupName: string | null;
  active: ParsedBucket[];
  disabled: ParsedBucket[];
}

const POOL_PRIORITY: Record<string, number> = {
  gemini: 0,
  "3p": 1,
  argon: 2,
  carbon: 3,
};

const PERIOD_PRIORITY: Record<WindowPeriod, number> = {
  "5h": 0,
  weekly: 1,
  other: 2,
};

function shortGoogleFamilyName(displayName: string): string {
  const withoutEffort = displayName.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, "").trim();
  if (/^Gemini\s+4\s+/i.test(withoutEffort)) {
    return withoutEffort.replace(/^Gemini\s+4\s+/i, "").trim();
  }
  if (/^Gemini\s+\d/i.test(withoutEffort)) {
    return withoutEffort.replace(/^Gemini\s+/i, "").trim();
  }
  return withoutEffort;
}

function isGoogleModel(id: string, entry: ModelEntry): boolean {
  return (
    entry.apiProvider === "API_PROVIDER_GOOGLE_GEMINI" ||
    entry.modelProvider === "MODEL_PROVIDER_GOOGLE" ||
    id.startsWith("gemini-")
  );
}

function addUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

interface QuotaSignature {
  remainingFraction: number | null;
  resetTimeMs: number | null;
}

function readQuotaSignature(entry: ModelEntry): QuotaSignature | null {
  const info = entry.quotaInfo;
  if (!info) return null;
  const remainingFraction = typeof info.remainingFraction === "number" && Number.isFinite(info.remainingFraction)
    ? info.remainingFraction
    : null;
  const resetTimeMs = timestampMs(info.resetTime);
  if (remainingFraction === null && resetTimeMs === null) return null;
  return { remainingFraction, resetTimeMs };
}

function quotaSignaturesMatch(a: QuotaSignature, b: QuotaSignature): boolean {
  if ((a.resetTimeMs === null) !== (b.resetTimeMs === null)) return false;
  if (a.resetTimeMs !== null && b.resetTimeMs !== null && Math.abs(a.resetTimeMs - b.resetTimeMs) > 5_000) {
    return false;
  }
  if (a.remainingFraction !== null && b.remainingFraction !== null && Math.abs(a.remainingFraction - b.remainingFraction) > 0.01) {
    return false;
  }
  return true;
}

function familySharesGeminiQuota(geminiRefs: QuotaSignature[], familySignatures: QuotaSignature[]): boolean {
  // Without per-model quotaInfo on either side, fall back to summary-group membership.
  if (geminiRefs.length === 0) return true;
  if (familySignatures.length === 0) return false;
  return familySignatures.every((sig) => geminiRefs.some((ref) => quotaSignaturesMatch(ref, sig)));
}

export function extractModelCatalog(document: unknown): ModelCatalog | null {
  const parsed = availableModelsSchema.safeParse(document);
  if (!parsed.success) return null;

  const entries = new Map<string, ModelEntry>();
  for (const [id, raw] of Object.entries(parsed.data.models)) {
    const model = modelEntrySchema.safeParse(raw);
    if (model.success) entries.set(id, model.data);
  }

  // agentModelSorts lists the active picker models without legacy/deprecated clutter.
  const sortedIds = (parsed.data.agentModelSorts ?? [])
    .flatMap((sort) => sort.groups ?? [])
    .flatMap((group) => group.modelIds)
    .filter((id) => entries.has(id));

  const primaryIds = sortedIds.length > 0 ? sortedIds : [...entries.keys()];
  const catalog: ModelCatalog = { gemini: [], argon: [], carbon: [] };
  const primaryGeminiSignatures: QuotaSignature[] = [];
  const flashGeminiSignatures: QuotaSignature[] = [];
  const argonSignatures: QuotaSignature[] = [];
  const carbonSignatures: QuotaSignature[] = [];

  for (const id of primaryIds) {
    const entry = entries.get(id);
    if (!entry || entry.isInternal || entry.disabled || !entry.displayName) continue;
    if (!isGoogleModel(id, entry)) continue;
    const name = shortGoogleFamilyName(entry.displayName);
    const sig = readQuotaSignature(entry);
    if (/\bargon\b/i.test(id) || /\bargon\b/i.test(name)) {
      addUnique(catalog.argon, name);
      if (sig) argonSignatures.push(sig);
    } else if (/\bcarbon\b/i.test(id) || /\bcarbon\b/i.test(name)) {
      addUnique(catalog.carbon, name);
      if (sig) carbonSignatures.push(sig);
    } else {
      addUnique(catalog.gemini, name);
      if (sig) {
        (/\bflash\b/i.test(name) ? flashGeminiSignatures : primaryGeminiSignatures).push(sig);
      }
    }
  }

  const geminiRefs = primaryGeminiSignatures.length > 0 ? primaryGeminiSignatures : flashGeminiSignatures;
  catalog.argonSharesGemini = familySharesGeminiQuota(geminiRefs, argonSignatures);
  catalog.carbonSharesGemini = familySharesGeminiQuota(geminiRefs, carbonSignatures);
  return catalog;
}

export function readTierLabel(document: unknown): string | null {
  const tier = z.object({
    id: z.string().min(1),
    name: z.string().optional(),
  });
  const parsed = z.object({
    g1Tier: z.unknown().optional(),
    paidTier: z.unknown().optional(),
    currentTier: z.unknown().optional(),
  }).safeParse(document);
  if (!parsed.success) return null;
  const root = parsed.data;
  // currentTier alone is Code Assist's plan, often free even for a paid
  // Antigravity user. Prefer the consumer Google One fields when present.
  const g1TierId = typeof root.g1Tier === "string" && root.g1Tier.trim() !== "" ? root.g1Tier.trim() : null;
  const paid = tier.safeParse(root.paidTier).data;
  const current = tier.safeParse(root.currentTier).data;
  const id = g1TierId ?? paid?.id ?? current?.id;
  if (!id) return null;
  const names: Record<string, string> = {
    "free-tier": "Free tier",
    "standard-tier": "Standard tier",
    "g1-pro-tier": "Google AI Pro",
    "g1-ultra-lite-tier": "Google AI Ultra",
    "g1-ultra-tier": "Google AI Ultra",
  };
  if (Object.hasOwn(names, id)) return names[id] ?? id;
  // Use the server's plan name for unknown tiers (ignoring Code Assist's generic
  // "Antigravity" placeholder on currentTier) before exposing raw tier IDs.
  const source = id === paid?.id ? paid : id === current?.id ? current : null;
  const displayName = source?.name?.trim();
  if (displayName && displayName !== "Antigravity") return displayName;
  return id;
}

function classifyPool(bucketId: string, groupName: string | null, groupIndex: number): string {
  if (bucketId === "gemini-5h" || bucketId === "gemini-weekly") return "gemini";
  if (bucketId === "3p-5h" || bucketId === "3p-weekly") return "3p";
  if (/argon/i.test(bucketId) || (groupName !== null && /argon/i.test(groupName))) return "argon";
  if (/carbon/i.test(bucketId) || (groupName !== null && /carbon/i.test(groupName))) return "carbon";
  return `custom:${groupName ? groupName.toLowerCase() : String(groupIndex)}`;
}

function inferPeriod(bucket: Bucket): WindowPeriod {
  const raw = bucket.window?.trim().toLowerCase();
  if (raw === "5h") return "5h";
  if (raw === "weekly") return "weekly";
  if (/(?:^|[-_])5h(?:$|[-_])/i.test(bucket.bucketId)) return "5h";
  if (/weekly/i.test(bucket.bucketId)) return "weekly";
  return "other";
}

function periodLabel(period: WindowPeriod, fallbackDisplayName?: string): string {
  if (period === "5h") return "5h";
  if (period === "weekly") return "Weekly";
  return fallbackDisplayName?.trim() || "Limit";
}

function shortPeriodSuffix(period: WindowPeriod): string {
  if (period === "5h") return "5h";
  if (period === "weekly") return "wk";
  return "";
}

function selectBottleneck(valid: ParsedBucket[]): { chosen: ParsedBucket; resetsAtMs: number | null } {
  const first = valid[0]!;
  if (valid.length === 1) {
    return { chosen: first, resetsAtMs: first.resetsAtMs };
  }

  const maxUsed = Math.max(...valid.map((entry) => entry.usedPct ?? -1));
  const tied = valid.filter((entry) => entry.usedPct === maxUsed);
  const allExhausted = maxUsed >= 100 && valid.every((entry) => (entry.usedPct ?? 0) >= 100);

  if (allExhausted) {
    // When every window in the pool is exhausted, service resumes only after the latest reset.
    const sortedByLatestReset = [...tied].sort((a, b) => (b.resetsAtMs ?? -1) - (a.resetsAtMs ?? -1));
    const chosen = sortedByLatestReset[0]!;
    return { chosen, resetsAtMs: chosen.resetsAtMs };
  }

  const sorted = [...tied].sort((a, b) => PERIOD_PRIORITY[a.period] - PERIOD_PRIORITY[b.period]);
  const chosen = sorted[0]!;
  return { chosen, resetsAtMs: chosen.resetsAtMs };
}

function poolNaming(
  pool: PoolAccumulator,
  hasSeparateArgon: boolean,
  hasSeparateCarbon: boolean,
  catalog: ModelCatalog | null,
): { windowId: string; baseName: string; shortBase: string } {
  if (pool.poolId === "gemini") {
    const families: string[] = [];
    if (catalog) {
      const nonFlash = catalog.gemini.filter((name) => !/\bflash\b/i.test(name));
      const primaryGemini = nonFlash.length > 0 ? nonFlash : catalog.gemini;
      for (const name of primaryGemini) addUnique(families, name);
      if (!hasSeparateArgon && catalog.argonSharesGemini !== false) {
        for (const name of catalog.argon) addUnique(families, name);
      }
      if (!hasSeparateCarbon && catalog.carbonSharesGemini !== false) {
        for (const name of catalog.carbon) addUnique(families, name);
      }
    }
    const baseName = families.length > 0 ? families.join(" · ") : "Gemini";
    const shortBase = families.length === 1 ? families[0]! : "Gemini";
    return { windowId: "gemini", baseName, shortBase };
  }

  if (pool.poolId === "3p") {
    return { windowId: "3p", baseName: "Claude/GPT", shortBase: "Claude/GPT" };
  }

  if (pool.poolId === "argon") {
    const existingId = pool.active.find((entry) => entry.bucket.bucketId === "gemini-argon-wtu-weekly")
      ?.bucket.bucketId;
    const families = catalog?.argon ?? [];
    const baseName = families.length > 0 ? families.join(" · ") : "Argon";
    return { windowId: existingId ?? "argon", baseName, shortBase: "Argon" };
  }

  if (pool.poolId === "carbon") {
    const firstId = pool.active[0]?.bucket.bucketId ?? pool.disabled[0]?.bucket.bucketId ?? "carbon";
    const families = catalog?.carbon ?? [];
    const baseName = families.length > 0 ? families.join(" · ") : "Carbon";
    return { windowId: firstId, baseName, shortBase: "Carbon" };
  }

  const first = pool.active[0] ?? pool.disabled[0];
  const baseName = pool.groupName || first?.bucket.displayName?.trim() || first?.bucket.bucketId || "Quota";
  const windowId = pool.active.length === 1 && first ? first.bucket.bucketId : pool.poolId;
  return { windowId, baseName, shortBase: baseName.slice(0, 14) };
}

export function mapQuotaSummary(
  document: unknown,
  planLabel: string | null = null,
  modelCatalog: ModelCatalog | null = null,
): UsageReport {
  const parsed = summarySchema.safeParse(document);
  if (!parsed.success) throw new UsageError("Antigravity returned an invalid quota summary (expected groups).");

  const pools = new Map<string, PoolAccumulator>();
  const seenBucketIds = new Set<string>();

  for (const [groupIndex, rawGroup] of parsed.data.groups.entries()) {
    const group = groupSchema.safeParse(rawGroup);
    if (!group.success) throw new UsageError("Antigravity returned an invalid quota group (expected buckets).");
    const groupName = group.data.displayName?.trim() || null;

    for (const rawBucket of group.data.buckets) {
      const parsedBucket = bucketSchema.safeParse(rawBucket);
      if (!parsedBucket.success) continue;
      const bucket = parsedBucket.data;
      if (seenBucketIds.has(bucket.bucketId)) continue;
      seenBucketIds.add(bucket.bucketId);

      const poolId = classifyPool(bucket.bucketId, groupName, groupIndex);
      let pool = pools.get(poolId);
      if (!pool) {
        pool = {
          poolId,
          order: POOL_PRIORITY[poolId] ?? (100 + groupIndex),
          groupName,
          active: [],
          disabled: [],
        };
        pools.set(poolId, pool);
      } else if (!pool.groupName && groupName) {
        pool.groupName = groupName;
      }

      const remaining = bucket.remainingFraction;
      const usedPct = typeof remaining === "number" && Number.isFinite(remaining)
        ? Math.max(0, Math.min(100, (1 - remaining) * 100))
        : null;
      const entry: ParsedBucket = {
        bucket,
        period: inferPeriod(bucket),
        usedPct,
        resetsAtMs: timestampMs(bucket.resetTime),
      };

      if (bucket.disabled) {
        pool.disabled.push(entry);
      } else {
        pool.active.push(entry);
      }
    }
  }

  if (pools.size === 0) {
    return unavailable({ kind: "no_quota", detail: "Antigravity did not report any quota pools for this login." });
  }

  const orderedPools = [...pools.values()].sort((a, b) => a.order - b.order);
  const hasSeparateArgon = pools.has("argon");
  const hasSeparateCarbon = pools.has("carbon");

  const windows: UsageWindow[] = [];
  const details: UsageDetail[] = [];

  for (const pool of orderedPools) {
    const { windowId, baseName, shortBase } = poolNaming(pool, hasSeparateArgon, hasSeparateCarbon, modelCatalog);

    if (pool.active.length === 0) {
      details.push({ id: `disabled-${pool.poolId}`, label: baseName, value: "Disabled" });
      continue;
    }

    const valid = pool.active.filter((entry) => entry.usedPct !== null);
    if (valid.length === 0) {
      const onlyPeriod = pool.active.length === 1 ? periodLabel(pool.active[0]!.period) : null;
      windows.push(windowFromUsedPct({
        id: windowId,
        label: onlyPeriod ? `${baseName} · ${onlyPeriod}` : baseName,
        shortLabel: shortBase,
        summary: true,
        utilizationPct: null,
        resetsAt: null,
        tone: toneFromUsedPct(null),
      }));
      continue;
    }

    const { chosen, resetsAtMs } = selectBottleneck(valid);
    const pLabel = periodLabel(chosen.period, chosen.bucket.displayName);
    const label = `${baseName} · ${pLabel}`;
    const shortSuffix = shortPeriodSuffix(chosen.period);
    const shortLabel = shortSuffix ? `${shortBase} ${shortSuffix}` : shortBase;

    windows.push(windowFromUsedPct({
      id: windowId,
      label,
      shortLabel,
      summary: true,
      utilizationPct: chosen.usedPct,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
      tone: toneFromUsedPct(chosen.usedPct),
    }));
  }

  if (windows.length > 0 && windows.every((window) => window.usedPct === null)) {
    throw new UsageError("Antigravity quota buckets contain no valid remainingFraction readings.");
  }

  if (planLabel === "Free tier") {
    details.push({
      id: "free-tier-note",
      label: "Free tier",
      value: "On free plans the 5h buckets may stay at full remaining quota; use the weekly value to track consumption.",
    });
  }

  if (windows.some((window) => window.usedPct === null)) {
    details.push({
      id: "missing-buckets",
      label: "Quota data",
      value: "Some quota buckets were omitted or had no valid reading; their usage is unknown, not zero.",
    });
  }

  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
    details,
  };
}

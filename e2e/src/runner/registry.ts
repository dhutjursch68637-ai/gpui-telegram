import {
  ALL_FEATURE_IDS,
  type FeatureId,
  type SharedTierContext,
  type TierNumber,
} from '../harness/tier_context.ts';

export interface RegisteredTestCase {
  id: string;
  title: string;
  tier: TierNumber;
  features: FeatureId[];
  timeoutMs: number;
  fn: (ctx: SharedTierContext) => Promise<void> | void;
}

export interface DefineTestSpec {
  id: string;
  title?: string;
  name?: string;
  tier: TierNumber;
  features?: FeatureId[];
  featureIds?: FeatureId[];
  timeoutMs?: number;
  fn?: (ctx: SharedTierContext) => Promise<void> | void;
  run?: (ctx: SharedTierContext) => Promise<void> | void;
}

export const COVERAGE_THRESHOLDS = {
  totalMin: 184,
  tier1Min: 80,
  tier1PerFeatureMin: 5,
  tier2Min: 80,
  tier2PerFeatureMin: 5,
  tier3Min: 16,
  tier4Min: 8,
} as const;

export class InventoryThresholdError extends Error {
  readonly report: InventoryValidationReport;

  constructor(report: InventoryValidationReport) {
    super(
      `[INVENTORY_THRESHOLD_FAILED] Registered test inventory (${report.total} total) does not meet required thresholds:\n` +
        report.violations.map((v) => `  - ${v}`).join('\n'),
    );
    this.name = 'InventoryThresholdError';
    this.report = report;
  }
}

export interface InventoryValidationReport {
  valid: boolean;
  total: number;
  byTier: Record<TierNumber, number>;
  byTierFeature: Record<1 | 2, Record<FeatureId, number>>;
  violations: string[];
}

const VALID_FEATURES = new Set<string>(ALL_FEATURE_IDS);
const registeredById = new Map<string, RegisteredTestCase>();
const registeredList: RegisteredTestCase[] = [];

export function defineTest(spec: DefineTestSpec): RegisteredTestCase;
export function defineTest(
  id: string,
  title: string,
  meta: { tier: TierNumber; features?: FeatureId[]; featureIds?: FeatureId[]; timeoutMs?: number },
  fn: (ctx: SharedTierContext) => Promise<void> | void,
): RegisteredTestCase;
export function defineTest(
  specOrId: DefineTestSpec | string,
  maybeTitle?: string,
  maybeMeta?: {
    tier: TierNumber;
    features?: FeatureId[];
    featureIds?: FeatureId[];
    timeoutMs?: number;
  },
  maybeFn?: (ctx: SharedTierContext) => Promise<void> | void,
): RegisteredTestCase {
  const spec: DefineTestSpec =
    typeof specOrId === 'string'
      ? {
          id: specOrId,
          title: maybeTitle ?? specOrId,
          tier: maybeMeta!.tier,
          features: maybeMeta?.features ?? maybeMeta?.featureIds,
          timeoutMs: maybeMeta?.timeoutMs,
          fn: maybeFn,
        }
      : specOrId;

  const id = spec.id.trim();
  if (!id) {
    throw new Error('defineTest requires a non-empty test id');
  }
  if (registeredById.has(id)) {
    throw new Error(`Duplicate E2E test ID registered: "${id}"`);
  }

  if (spec.tier !== 1 && spec.tier !== 2 && spec.tier !== 3 && spec.tier !== 4) {
    throw new Error(`Invalid tier ${String(spec.tier)} for test "${id}" (expected 1|2|3|4)`);
  }

  const rawFeatures = spec.features ?? spec.featureIds ?? [];
  if (!Array.isArray(rawFeatures) || rawFeatures.length === 0) {
    throw new Error(`Test "${id}" must declare at least one FeatureId in features`);
  }
  const dedupFeatures: FeatureId[] = [];
  for (const f of rawFeatures) {
    if (!VALID_FEATURES.has(f)) {
      throw new Error(`Test "${id}" references unknown FeatureId "${String(f)}"`);
    }
    if (!dedupFeatures.includes(f)) {
      dedupFeatures.push(f);
    }
  }

  const fn = spec.fn ?? spec.run;
  if (typeof fn !== 'function') {
    throw new Error(`Test "${id}" is missing executable fn(ctx) implementation`);
  }

  const defaultTimeout =
    spec.tier === 4 ? 90000 : spec.tier === 3 ? 60000 : 45000;

  const entry: RegisteredTestCase = {
    id,
    title: (spec.title ?? spec.name ?? id).trim(),
    tier: spec.tier,
    features: dedupFeatures,
    timeoutMs: spec.timeoutMs ?? defaultTimeout,
    fn,
  };

  registeredById.set(id, entry);
  registeredList.push(entry);
  return entry;
}

export function getRegisteredTests(tier?: TierNumber): RegisteredTestCase[] {
  if (tier === undefined) {
    return [...registeredList];
  }
  return registeredList.filter((t) => t.tier === tier);
}

export function clearRegistry(): void {
  registeredById.clear();
  registeredList.length = 0;
}

export function validateInventoryThresholds(
  opts: { tier?: TierNumber } = {},
): InventoryValidationReport {
  const byTier: Record<TierNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const makeFeatureCounts = (): Record<FeatureId, number> =>
    Object.fromEntries(ALL_FEATURE_IDS.map((f) => [f, 0])) as Record<FeatureId, number>;

  const byTierFeature: Record<1 | 2, Record<FeatureId, number>> = {
    1: makeFeatureCounts(),
    2: makeFeatureCounts(),
  };

  for (const t of registeredList) {
    byTier[t.tier]++;
    if (t.tier === 1 || t.tier === 2) {
      for (const f of t.features) {
        byTierFeature[t.tier][f]++;
      }
    }
  }

  const total = registeredList.length;
  const violations: string[] = [];

  const checkTier1 = opts.tier === undefined || opts.tier === 1;
  const checkTier2 = opts.tier === undefined || opts.tier === 2;
  const checkTier3 = opts.tier === undefined || opts.tier === 3;
  const checkTier4 = opts.tier === undefined || opts.tier === 4;

  if (opts.tier === undefined && total < COVERAGE_THRESHOLDS.totalMin) {
    violations.push(
      `Total registered tests (${total}) < required minimum (${COVERAGE_THRESHOLDS.totalMin})`,
    );
  }

  if (checkTier1) {
    if (byTier[1] < COVERAGE_THRESHOLDS.tier1Min) {
      violations.push(
        `Tier 1 test count (${byTier[1]}) < required minimum (${COVERAGE_THRESHOLDS.tier1Min})`,
      );
    }
    for (const f of ALL_FEATURE_IDS) {
      if (byTierFeature[1][f] < COVERAGE_THRESHOLDS.tier1PerFeatureMin) {
        violations.push(
          `Tier 1 feature ${f} count (${byTierFeature[1][f]}) < required minimum (${COVERAGE_THRESHOLDS.tier1PerFeatureMin})`,
        );
      }
    }
  }

  if (checkTier2) {
    if (byTier[2] < COVERAGE_THRESHOLDS.tier2Min) {
      violations.push(
        `Tier 2 test count (${byTier[2]}) < required minimum (${COVERAGE_THRESHOLDS.tier2Min})`,
      );
    }
    for (const f of ALL_FEATURE_IDS) {
      if (byTierFeature[2][f] < COVERAGE_THRESHOLDS.tier2PerFeatureMin) {
        violations.push(
          `Tier 2 feature ${f} count (${byTierFeature[2][f]}) < required minimum (${COVERAGE_THRESHOLDS.tier2PerFeatureMin})`,
        );
      }
    }
  }

  if (checkTier3 && byTier[3] < COVERAGE_THRESHOLDS.tier3Min) {
    violations.push(
      `Tier 3 test count (${byTier[3]}) < required minimum (${COVERAGE_THRESHOLDS.tier3Min})`,
    );
  }

  if (checkTier4 && byTier[4] < COVERAGE_THRESHOLDS.tier4Min) {
    violations.push(
      `Tier 4 test count (${byTier[4]}) < required minimum (${COVERAGE_THRESHOLDS.tier4Min})`,
    );
  }

  return {
    valid: violations.length === 0,
    total,
    byTier,
    byTierFeature,
    violations,
  };
}

export function assertInventoryThresholdsOrThrow(
  opts: { tier?: TierNumber } = {},
): InventoryValidationReport {
  const report = validateInventoryThresholds(opts);
  if (!report.valid) {
    throw new InventoryThresholdError(report);
  }
  return report;
}

import type { ToolkitConfig } from "./config.js";
import type {
  InspectedEntry,
  LedgerCloseInterval,
  SnapshotConsistency,
} from "./rpc-client.js";
import { assessRisk, type RiskLevel } from "./risk.js";

export interface InspectionReport {
  schemaVersion: 1;
  network: string;
  networkPassphrase: string;
  latestLedger: number;
  ledgerCloseSeconds: number;
  ledgerCloseInterval: LedgerCloseInterval;
  thresholds: { criticalDays: number; warningDays: number };
  entries: Array<
    InspectedEntry & {
      risk: RiskLevel;
      remainingLedgers: number | null;
      remainingDays: number | null;
    }
  >;
  limitations: string[];
}

export interface MaintenancePlan extends InspectionReport {
  plan: {
    mode: "dry-run";
    targetDays: number;
    targetLedger: number;
    estimatedTotalStroops: string | null;
    assumptions: string[];
    actions: Array<{
      key: string;
      ttlKey: string;
      action: "extend" | "no-op" | "unavailable";
      currentLiveUntilLedgerSeq: number | null;
      targetLiveUntilLedgerSeq: number;
      estimatedCostStroops: string | null;
      reason?: string;
    }>;
  };
}

export function createInspectionReport(
  network: string,
  latestLedger: number,
  entries: InspectedEntry[],
  config: ToolkitConfig,
  networkPassphrase: string,
  ledgerCloseInterval?: LedgerCloseInterval,
  consistency?: SnapshotConsistency,
): InspectionReport {
  const interval =
    ledgerCloseInterval ??
    ({
      seconds: config.ledgerCloseSeconds,
      source: "configured-fallback",
      samplingWindow: null,
      fallbackReason: "not-sampled",
    } satisfies LedgerCloseInterval);
  const riskConfig = {
    ...config,
    ledgerCloseSeconds: interval.seconds,
  };
  assessRisk(null, latestLedger, riskConfig);
  if (!network || !networkPassphrase) {
    throw new Error("network and network-passphrase must not be empty");
  }
  const inspected = entries.map((entry) => {
    const assessment = assessRisk(
      entry.liveUntilLedgerSeq,
      latestLedger,
      riskConfig,
    );
    return {
      ...entry,
      ...assessment,
      risk: entry.found ? assessment.risk : ("unknown" as const),
    };
  });

  return {
    schemaVersion: 1,
    network,
    networkPassphrase,
    latestLedger,
    ledgerCloseSeconds: interval.seconds,
    ledgerCloseInterval: interval,
    thresholds: {
      criticalDays: config.criticalDays,
      warningDays: config.warningDays,
    },
    entries: inspected,
    limitations: [
      "Only the explicitly supplied ledger keys are inspected; a contract ID does not reveal every storage key.",
      "Expiration is taken from the liveUntilLedgerSeq metadata returned with each ledger entry.",
      "Temporary entries can be extended by any party; TTL must not be used as an application-level authorization, safety, or guaranteed-expiration mechanism.",
      "This toolkit does not construct, sign, or submit extension transactions.",
      ...(consistency && consistency.requestCount > 1
        ? [
            `Entries were read with ${consistency.requestCount} separate getLedgerEntries requests because Soroban RPC limits keys per request and cannot pin requests to one ledger; entries may reflect ledgers ${consistency.oldestLedger} through ${consistency.latestLedger}, and remaining TTL is measured from ledger ${latestLedger}.`,
          ]
        : []),
      ...(config.network === "custom" &&
      config.expectedNetworkPassphrase === undefined
        ? [
            "The custom RPC network passphrase was observed but not pinned to an expected value.",
          ]
        : []),
    ],
  };
}

export function createMaintenancePlan(
  report: InspectionReport,
  config: ToolkitConfig,
  targetDays: number,
): MaintenancePlan {
  if (!Number.isFinite(targetDays) || targetDays <= 0) {
    throw new Error("target-days must be a positive number");
  }
  const targetLedger =
    report.latestLedger +
    Math.ceil((targetDays * 86_400) / report.ledgerCloseSeconds);
  if (!Number.isSafeInteger(targetLedger) || targetLedger > 0xffff_ffff) {
    throw new Error(
      "target-days produces a ledger number outside the supported uint32 range",
    );
  }
  const hasRate = config.rentFeePerByteLedger !== undefined;
  const assumptions = [
    `Target TTL is ${targetDays} days from ledger ${report.latestLedger}, using ${report.ledgerCloseSeconds} seconds per ledger from ${report.ledgerCloseInterval.source}${report.ledgerCloseInterval.samplingWindow ? ` (sampled ledgers ${report.ledgerCloseInterval.samplingWindow.startLedger}-${report.ledgerCloseInterval.samplingWindow.endLedger}, ${report.ledgerCloseInterval.samplingWindow.intervalCount} intervals)` : ` (no sampling window${report.ledgerCloseInterval.fallbackReason ? `; ${report.ledgerCloseInterval.fallbackReason}` : ""})`}.`,
    hasRate
      ? `Cost is an illustrative estimate: ledger-entry data XDR bytes x added ledgers x configured ${config.rentFeePerByteLedger} stroops per byte-ledger.`
      : "No rent rate was configured; extension costs are not estimated.",
    "Actual rent charges depend on network protocol configuration and transaction simulation; this estimate is not a quote.",
    "The plan is dry-run only and does not create, sign, or submit a transaction.",
    "This plan reflects the reported snapshot; re-inspect before acting because ledger state advances.",
    "Temporary storage TTL extension is not a substitute for application-level expiration or safety checks.",
  ];

  let total = 0n;
  let totalIsAvailable = true;
  const actions = report.entries.map((entry) => {
    const action: MaintenancePlan["plan"]["actions"][number] = {
      key: entry.key,
      ttlKey: entry.ttlKey,
      action: "unavailable",
      currentLiveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      targetLiveUntilLedgerSeq: targetLedger,
      estimatedCostStroops: null,
    };

    if (!entry.found) {
      action.reason = "storage-entry-not-found";
      totalIsAvailable = false;
      return action;
    }
    if (entry.liveUntilLedgerSeq === null) {
      action.reason = "expiration-metadata-unavailable";
      totalIsAvailable = false;
      return action;
    }
    if (entry.liveUntilLedgerSeq < report.latestLedger) {
      action.reason = "entry-expired";
      totalIsAvailable = false;
      return action;
    }
    if (entry.liveUntilLedgerSeq >= targetLedger) {
      action.action = "no-op";
      action.reason = "existing-ttl-meets-target";
      action.estimatedCostStroops = "0";
      return action;
    }

    action.action = "extend";
    if (!hasRate) {
      action.reason = "rent-rate-not-configured";
      totalIsAvailable = false;
      return action;
    }
    const bytes = entry.entryBytes;
    if (bytes === null) {
      action.action = "unavailable";
      action.reason = "entry-size-unavailable";
      totalIsAvailable = false;
      return action;
    }
    const estimate =
      BigInt(bytes) *
      BigInt(targetLedger - entry.liveUntilLedgerSeq) *
      BigInt(config.rentFeePerByteLedger!);
    action.estimatedCostStroops = estimate.toString();
    total += estimate;
    return action;
  });

  return {
    ...report,
    plan: {
      mode: "dry-run",
      targetDays,
      targetLedger,
      estimatedTotalStroops: totalIsAvailable ? total.toString() : null,
      assumptions,
      actions,
    },
  };
}

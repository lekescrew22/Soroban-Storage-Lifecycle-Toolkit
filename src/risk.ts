import type { ToolkitConfig } from "./config.js";

export type RiskLevel = "critical" | "warning" | "healthy" | "unknown";

export interface RiskAssessment {
  risk: RiskLevel;
  remainingLedgers: number | null;
  remainingDays: number | null;
}

function validateLedgerSequence(
  value: number,
  name: string,
  allowZero = false,
): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} uint32 ledger sequence`,
    );
  }
}

export function assessRisk(
  liveUntilLedgerSeq: number | null,
  latestLedger: number,
  config: Pick<
    ToolkitConfig,
    "criticalDays" | "warningDays" | "ledgerCloseSeconds"
  >,
): RiskAssessment {
  validateLedgerSequence(latestLedger, "latest-ledger");
  if (liveUntilLedgerSeq !== null) {
    validateLedgerSequence(liveUntilLedgerSeq, "live-until-ledger", true);
  }
  if (
    !Number.isFinite(config.criticalDays) ||
    config.criticalDays <= 0 ||
    !Number.isFinite(config.warningDays) ||
    config.warningDays <= config.criticalDays
  ) {
    throw new Error(
      "Risk thresholds must be positive and critical-days must be less than warning-days",
    );
  }
  if (
    !Number.isFinite(config.ledgerCloseSeconds) ||
    config.ledgerCloseSeconds <= 0
  ) {
    throw new Error("ledger-close-seconds must be a positive number");
  }
  if (liveUntilLedgerSeq === null) {
    return { risk: "unknown", remainingLedgers: null, remainingDays: null };
  }

  const remainingLedgers = liveUntilLedgerSeq - latestLedger;
  const remainingDays =
    (Math.max(0, remainingLedgers) * config.ledgerCloseSeconds) / 86_400;
  if (!Number.isFinite(remainingDays)) {
    throw new Error(
      "Estimated remaining lifetime is outside the supported numeric range",
    );
  }
  if (remainingLedgers <= 0 || remainingDays <= config.criticalDays) {
    return { risk: "critical", remainingLedgers, remainingDays };
  }
  if (remainingDays <= config.warningDays) {
    return { risk: "warning", remainingLedgers, remainingDays };
  }
  return { risk: "healthy", remainingLedgers, remainingDays };
}

import type {
  InspectionReport,
  MaintenancePlan,
} from "./maintenance-planner.js";

export type OutputFormat = "table" | "json" | "csv";

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (
    typeof value === "string" &&
    /^[\s\u0000-\u001f\ufeff]*[=+\-@]/u.test(value)
  ) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function formatCsv(report: InspectionReport | MaintenancePlan): string {
  const plan = "plan" in report ? report.plan : undefined;
  const columns = [
    "network",
    "networkPassphrase",
    "latestLedger",
    "ledgerCloseSeconds",
    "limitations",
    "criticalDays",
    "warningDays",
    "key",
    "keyType",
    "durability",
    "found",
    "lastModifiedLedgerSeq",
    "liveUntilLedgerSeq",
    "remainingLedgers",
    "remainingDays",
    "risk",
    ...(plan
      ? [
          "mode",
          "targetDays",
          "targetLedger",
          "action",
          "targetLiveUntilLedgerSeq",
          "estimatedCostStroops",
          "estimatedTotalStroops",
          "assumptions",
          "reason",
        ]
      : []),
  ];
  const rows = report.entries.map((entry) => {
    const planned = plan?.actions.find((action) => action.key === entry.key);
    return [
      report.network,
      report.networkPassphrase,
      report.latestLedger,
      report.ledgerCloseSeconds,
      report.limitations.join("; "),
      report.thresholds.criticalDays,
      report.thresholds.warningDays,
      entry.key,
      entry.keyType,
      entry.durability,
      entry.found,
      entry.lastModifiedLedgerSeq,
      entry.liveUntilLedgerSeq,
      entry.remainingLedgers,
      entry.remainingDays,
      entry.risk,
      ...(plan
        ? [
            plan.mode,
            plan.targetDays,
            plan.targetLedger,
            planned?.action,
            planned?.targetLiveUntilLedgerSeq,
            planned?.estimatedCostStroops,
            plan.estimatedTotalStroops,
            plan.assumptions.join("; "),
            planned?.reason,
          ]
        : []),
    ];
  });
  return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function formatTable(report: InspectionReport | MaintenancePlan): string {
  const plan = "plan" in report ? report.plan : undefined;
  const lines = [
    `Network: ${report.network} (${report.networkPassphrase}) | Snapshot ledger: ${report.latestLedger} | Ledger interval: ${report.ledgerCloseSeconds}s`,
    "KEY TYPE | DURABILITY | FOUND | LAST MODIFIED | LIVE UNTIL | DAYS LEFT | RISK" +
      (plan ? " | ACTION | EST. STROOPS" : ""),
  ];
  for (const entry of report.entries) {
    const action = plan?.actions.find((item) => item.key === entry.key);
    lines.push(
      [
        entry.keyType,
        entry.durability ?? "n/a",
        entry.found ? "yes" : "no",
        entry.lastModifiedLedgerSeq ?? "unknown",
        entry.liveUntilLedgerSeq ?? "unknown",
        entry.remainingDays === null
          ? "unknown"
          : entry.remainingDays.toFixed(2),
        entry.risk,
        ...(plan
          ? [
              action?.action ?? "unavailable",
              action?.estimatedCostStroops ?? "unknown",
            ]
          : []),
      ].join(" | "),
    );
    lines.push(`  Key: ${entry.key}`);
  }
  if (plan) {
    lines.push(
      `Dry-run target: ledger ${plan.targetLedger} (${plan.targetDays} days); total estimate: ${plan.estimatedTotalStroops ?? "unavailable"} stroops`,
    );
    lines.push(`Assumptions: ${plan.assumptions.join(" ")}`);
  }
  lines.push(`Limitations: ${report.limitations.join(" ")}`);
  return lines.join("\n");
}

export function formatReport(
  report: InspectionReport | MaintenancePlan,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }
  if (format === "csv") {
    return formatCsv(report);
  }
  if (format === "table") {
    return formatTable(report);
  }
  throw new Error(`Unsupported report format "${String(format)}"`);
}

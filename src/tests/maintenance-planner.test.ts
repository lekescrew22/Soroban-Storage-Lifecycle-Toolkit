import assert from "node:assert/strict";
import test from "node:test";
import {
  createInspectionReport,
  createMaintenancePlan,
} from "../maintenance-planner.js";
import type { ToolkitConfig } from "../config.js";
import type { InspectedEntry } from "../rpc-client.js";
import { formatReport } from "../report.js";
import { assessRisk } from "../risk.js";

const config: ToolkitConfig = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  criticalDays: 7,
  warningDays: 30,
  ledgerCloseSeconds: 86_400,
  rentFeePerByteLedger: "2",
};

function entry(overrides: Partial<InspectedEntry> = {}): InspectedEntry {
  return {
    key: "key-xdr",
    keyType: "contractCode",
    durability: null,
    ttlKey: "ttl-xdr",
    found: true,
    lastModifiedLedgerSeq: 90,
    liveUntilLedgerSeq: 110,
    entryBytes: 100,
    ...overrides,
  };
}

test("classifies ledger lifetimes at the configured risk boundaries", () => {
  const report = createInspectionReport(
    "testnet",
    100,
    [
      entry({ liveUntilLedgerSeq: 107 }),
      entry({ liveUntilLedgerSeq: 108 }),
      entry({ liveUntilLedgerSeq: 131 }),
      entry({ liveUntilLedgerSeq: null }),
      entry({ found: false, liveUntilLedgerSeq: null }),
    ],
    config,
    "Test SDF Network ; September 2015",
  );

  assert.deepEqual(
    report.entries.map((item) => item.risk),
    ["critical", "warning", "healthy", "unknown", "unknown"],
  );
  assert.equal(report.entries[0]?.remainingLedgers, 7);
  assert.equal(report.entries[0]?.remainingDays, 7);
  assert.equal(report.ledgerCloseInterval.source, "configured-fallback");
});

test("validates risk inputs and handles the uint32 ledger boundary", () => {
  assert.equal(assessRisk(0, 100, config).risk, "critical");
  assert.throws(() => assessRisk(1, 0, config), /positive uint32/);
  assert.throws(
    () => assessRisk(10, 10, { ...config, warningDays: 7 }),
    /critical-days must be less than warning-days/,
  );
});

test("builds a dry-run plan and estimates rent only for required extensions", () => {
  const report = createInspectionReport(
    "testnet",
    100,
    [
      entry(),
      entry({
        key: "already-long",
        ttlKey: "ttl-already-long",
        liveUntilLedgerSeq: 200,
      }),
      entry({
        key: "missing",
        ttlKey: "ttl-missing",
        found: false,
        liveUntilLedgerSeq: null,
      }),
    ],
    config,
    "Test SDF Network ; September 2015",
  );
  const plan = createMaintenancePlan(report, config, 30);

  assert.equal(plan.plan.mode, "dry-run");
  assert.equal(plan.plan.targetLedger, 130);
  assert.deepEqual(
    plan.plan.actions.map((action) => action.action),
    ["extend", "no-op", "unavailable"],
  );
  assert.equal(plan.plan.actions[0]?.estimatedCostStroops, "4000");
  assert.equal(plan.plan.actions[1]?.estimatedCostStroops, "0");
  assert.equal(plan.plan.estimatedTotalStroops, null);
  const csv = formatReport(plan, "csv");
  assert.match(csv, /estimatedCostStroops/);
  assert.match(
    csv,
    /"network","networkPassphrase","latestLedger","ledgerCloseSeconds","ledgerCloseIntervalSource","ledgerCloseIntervalSampleStartLedger"/,
  );
  assert.match(csv, /"testnet","Test SDF Network ; September 2015","100"/);
  assert.match(formatReport(plan, "json"), /"mode": "dry-run"/);
  assert.match(
    formatReport(plan, "table"),
    /Limitations: Only the explicitly supplied ledger keys/,
  );
  assert.match(formatReport(plan, "table"), /Cost is an illustrative estimate/);
  assert.throws(
    () => formatReport(plan, "xml" as "table"),
    /Unsupported report format/,
  );
});

test("uses observed cadence for remaining days and target-ledger calculations", () => {
  const report = createInspectionReport(
    "testnet",
    100,
    [entry({ liveUntilLedgerSeq: 110 })],
    config,
    "Test SDF Network ; September 2015",
    {
      seconds: 10,
      source: "observed",
      samplingWindow: {
        startLedger: 90,
        endLedger: 100,
        ledgerCount: 11,
        intervalCount: 10,
      },
    },
  );
  const plan = createMaintenancePlan(report, config, 1);

  assert.equal(report.ledgerCloseSeconds, 10);
  assert.equal(report.entries[0]?.remainingDays, (10 * 10) / 86_400);
  assert.equal(plan.plan.targetLedger, 8_740);
  assert.match(
    plan.plan.assumptions[0] ?? "",
    /observed \(sampled ledgers 90-100, 10 intervals\)/,
  );
  assert.match(
    formatReport(report, "table"),
    /Ledger interval: 10s \(observed; sampled ledgers 90-100 \(10 intervals\)\)/,
  );
});

test("does not claim a cost estimate when no rent rate is configured", () => {
  const { rentFeePerByteLedger: _rentFeePerByteLedger, ...noRate } = config;
  const report = createInspectionReport(
    "testnet",
    100,
    [entry()],
    noRate,
    "Test SDF Network ; September 2015",
  );
  const plan = createMaintenancePlan(report, noRate, 30);
  assert.equal(plan.plan.actions[0]?.action, "extend");
  assert.equal(plan.plan.actions[0]?.estimatedCostStroops, null);
  assert.equal(plan.plan.actions[0]?.reason, "rent-rate-not-configured");
  assert.equal(plan.plan.estimatedTotalStroops, null);
});

test("refuses a plan beyond the protocol ledger-sequence range", () => {
  const report = createInspectionReport(
    "testnet",
    0xffff_ffff,
    [],
    config,
    "Test SDF Network ; September 2015",
  );
  assert.throws(
    () => createMaintenancePlan(report, config, 1),
    /outside the supported uint32 range/,
  );
});

test("does not plan an extension for an already expired entry", () => {
  const report = createInspectionReport(
    "testnet",
    100,
    [entry({ liveUntilLedgerSeq: 90 })],
    config,
    "Test SDF Network ; September 2015",
  );
  const plan = createMaintenancePlan(report, config, 30);
  assert.equal(plan.plan.actions[0]?.action, "unavailable");
  assert.equal(plan.plan.actions[0]?.reason, "entry-expired");
  assert.equal(plan.plan.actions[0]?.estimatedCostStroops, null);
});

test("does not treat an entry live through the current ledger as already expired", () => {
  const report = createInspectionReport(
    "testnet",
    100,
    [entry({ liveUntilLedgerSeq: 100 })],
    config,
    "Test SDF Network ; September 2015",
  );
  const plan = createMaintenancePlan(report, config, 30);
  assert.equal(plan.plan.actions[0]?.action, "extend");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  createInspectionReport,
  createMaintenancePlan,
} from "../maintenance-planner.js";
import { parseStorageKey } from "../ledger-key.js";
import type { ToolkitConfig } from "../config.js";

const config: ToolkitConfig = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  criticalDays: 7,
  warningDays: 30,
  ledgerCloseSeconds: 5,
};

const reportSchema = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL("../../schemas/report-v1.schema.json", import.meta.url),
    ),
    "utf8",
  ),
) as object;
const ajv = new Ajv2020({ allErrors: true });
const validateReport = ajv.compile(reportSchema);

function createReport() {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 8) }),
  ).toXDR("base64");
  const parsed = parseStorageKey(key);
  return createInspectionReport(
    "testnet",
    100,
    [
      {
        key,
        keyType: "contractCode",
        durability: null,
        ttlKey: parsed.ttlKeyXdr,
        found: true,
        lastModifiedLedgerSeq: 90,
        liveUntilLedgerSeq: 100_000,
        entryBytes: 128,
      },
    ],
    config,
    "Test SDF Network ; September 2015",
  );
}

test("validates inspection and dry-run reports against the published schema", () => {
  const report = createReport();
  assert.equal(
    validateReport(report),
    true,
    JSON.stringify(validateReport.errors),
  );
  const plan = createMaintenancePlan(report, config, 30);
  assert.equal(
    validateReport(plan),
    true,
    JSON.stringify(validateReport.errors),
  );
});

test("rejects unknown enum values and report schema versions", () => {
  const report = createReport();
  const invalidRisk = structuredClone(report);
  invalidRisk.entries[0]!.risk = "imminent" as "critical";
  assert.equal(validateReport(invalidRisk), false);

  const invalidVersion = { ...report, schemaVersion: 2 };
  assert.equal(validateReport(invalidVersion), false);
});

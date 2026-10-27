import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import type { ToolkitConfig } from "../config.js";
import { createInspectionReport } from "../maintenance-planner.js";
import { formatReport } from "../report.js";
import { parseStorageKey } from "../ledger-key.js";

const config: ToolkitConfig = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  criticalDays: 7,
  warningDays: 30,
  ledgerCloseSeconds: 5,
};

function createReport(network: string, networkPassphrase: string) {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 9) }),
  ).toXDR("base64");
  return createInspectionReport(
    network,
    100,
    [
      {
        key,
        keyType: "contractCode",
        durability: null,
        ttlKey: parseStorageKey(key).ttlKeyXdr,
        found: true,
        lastModifiedLedgerSeq: 90,
        liveUntilLedgerSeq: 95,
        entryBytes: 128,
      },
    ],
    config,
    networkPassphrase,
  );
}

test("escapes formula-triggering text in CSV without changing JSON or numbers", () => {
  const report = createReport("=1+1", "\t@SUM(1,1)");
  const csv = formatReport(report, "csv");

  assert.match(csv, /"'\u003d1\+1"/);
  assert.match(csv, /"'\t@SUM\(1,1\)"/);
  assert.match(csv, /,"-5",/);
  assert.equal(JSON.parse(formatReport(report, "json")).network, "=1+1");
});

test("escapes all supported formula markers after leading control whitespace", () => {
  const cases: Array<[string, string]> = [
    ["=", "\u0000=1+1"],
    ["+", "\t+SUM(1,1)"],
    ["-", "\r\n-cmd"],
    ["@", " \ufeff@SUM(1,1)"],
  ];
  for (const [marker, input] of cases) {
    const report = createReport(input, "safe");
    const csv = formatReport(report, "csv");
    assert.ok(csv.includes(`"'${input.replaceAll('"', '""')}"`), marker);
  }
});

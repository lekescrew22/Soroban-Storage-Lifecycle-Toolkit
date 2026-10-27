import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import { parseStorageKey } from "../ledger-key.js";

test("CLI writes a complete report atomically with private file permissions", async () => {
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 12) }),
  ).toXDR("base64");
  const entryData = xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: xdr.ContractCodeEntryExt.v0(),
      hash: Buffer.alloc(32, 12),
      code: Buffer.from([1, 2, 3]),
    }),
  ).toXDR("base64");
  const passphrase = "Test SDF Network ; September 2015";
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
      }
      const rpcRequest = JSON.parse(body) as { id: number; method: string };
      response.setHeader("content-type", "application/json");
      if (rpcRequest.method === "getNetwork") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcRequest.id,
            result: { passphrase, protocolVersion: 29 },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcRequest.id,
          result: {
            latestLedger: 100,
            entries: [
              {
                key,
                xdr: entryData,
                lastModifiedLedgerSeq: 90,
                liveUntilLedgerSeq: 200,
              },
            ],
          },
        }),
      );
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "soroban-cli-"));
  const configPath = join(directory, "config.json");
  const outputPath = join(directory, "report.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        network: "custom",
        rpcUrl: `http://127.0.0.1:${address.port}`,
        networkPassphrase: passphrase,
        ledgerCloseSeconds: 86_400,
      }),
    );
    const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            cliPath,
            "--config",
            configPath,
            "inspect",
            "--key",
            key,
            "--format",
            "json",
            "--output",
            outputPath,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await readFile(outputPath, "utf8")) as {
      networkPassphrase: string;
      entries: Array<{
        key: string;
        keyType: string;
        durability: string | null;
        ttlKey: string;
        found: boolean;
        liveUntilLedgerSeq: number | null;
        risk: string;
        remainingLedgers: number | null;
      }>;
    };
    assert.equal(report.networkPassphrase, passphrase);
    assert.deepEqual(report.entries[0], {
      key,
      keyType: "contractCode",
      durability: null,
      ttlKey: parseStorageKey(key).ttlKeyXdr,
      found: true,
      lastModifiedLedgerSeq: 90,
      liveUntilLedgerSeq: 200,
      entryBytes: Buffer.from(entryData, "base64").length,
      risk: "healthy",
      remainingLedgers: 100,
      remainingDays: 100,
    });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

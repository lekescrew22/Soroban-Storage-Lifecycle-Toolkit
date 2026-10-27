import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "soroban-package-smoke-"),
);
const packedDirectory = join(temporaryDirectory, "packed");
const consumerDirectory = join(temporaryDirectory, "consumer");
await Promise.all([
  import("node:fs/promises").then(({ mkdir }) => mkdir(packedDirectory)),
  import("node:fs/promises").then(({ mkdir }) => mkdir(consumerDirectory)),
]);

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  run("npm", ["run", "build"], root);
  const packOutput = run(
    "npm",
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packedDirectory,
    ],
    root,
  );
  const packed = JSON.parse(packOutput);
  assert.equal(packed.length, 1, "npm pack should produce exactly one tarball");
  assert.ok(packed[0].files.some((file) => file.path === "LICENSE"));
  assert.ok(packed[0].files.some((file) => file.path === "dist/index.d.ts"));
  assert.ok(packed[0].files.some((file) => file.path === "dist/cli.js"));
  assert.ok(
    !packed[0].files.some((file) => file.path.startsWith("src/tests/")),
    "test sources must not be published",
  );

  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "soroban-consumer-smoke",
      private: true,
      type: "module",
    }),
  );
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      join(packedDirectory, packed[0].filename),
    ],
    consumerDirectory,
  );

  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { resolveConfig, SorobanRpcClient, parseStorageKeyManifest } from "soroban-storage-lifecycle-toolkit";',
        'import { xdr } from "@stellar/stellar-sdk";',
        'if (typeof SorobanRpcClient !== "function") throw new Error("SDK client export missing");',
        'if (typeof resolveConfig !== "function") throw new Error("config export missing");',
        'const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 1) })).toXDR("base64");',
        'const manifest = parseStorageKeyManifest({ version: 1, entries: [{ name: "wasm", key }] });',
        'if (manifest.entries[0]?.name !== "wasm") throw new Error("manifest export failed");',
        'const config = await resolveConfig({ network: "testnet" });',
        'if (!config.rpcUrl.startsWith("https://")) throw new Error("default config failed");',
      ].join("\n"),
    ],
    consumerDirectory,
  );

  const cliOutput = run(
    process.execPath,
    ["node_modules/soroban-storage-lifecycle-toolkit/dist/cli.js", "--help"],
    consumerDirectory,
  );
  assert.match(cliOutput, /Inspect known Soroban ledger keys/);

  const declarations = await readFile(
    join(
      consumerDirectory,
      "node_modules/soroban-storage-lifecycle-toolkit/dist/index.d.ts",
    ),
    "utf8",
  );
  assert.match(declarations, /SorobanRpcClient/);
  console.log("Clean consumer package smoke test passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

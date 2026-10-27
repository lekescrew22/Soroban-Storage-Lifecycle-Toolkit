import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../config.js";
import { ToolkitError } from "../errors.js";

test("resolves the selected network and its default RPC endpoint", async () => {
  const config = await resolveConfig({ network: "testnet" });
  assert.equal(config.rpcUrl, "https://soroban-testnet.stellar.org");
  assert.equal(config.criticalDays, 7);
  assert.equal(config.warningDays, 30);
  const mainnet = await resolveConfig({ network: "mainnet" });
  assert.equal(mainnet.rpcUrl, "https://mainnet.sorobanrpc.com");
});

test("requires a secure endpoint for a custom network", async () => {
  await assert.rejects(
    resolveConfig({ network: "custom" }),
    /requires an RPC URL/,
  );
  await assert.rejects(
    resolveConfig({ network: "custom", rpcUrl: "http://rpc.example.org" }),
    /must use HTTPS/,
  );
  await assert.rejects(
    resolveConfig({
      network: "custom",
      rpcUrl: "https://user:pass@rpc.example.org",
    }),
    /must not include credentials/,
  );
  const local = await resolveConfig({
    network: "custom",
    rpcUrl: "http://localhost:8000/",
  });

  assert.equal(local.rpcUrl, "http://localhost:8000");
});

test("classifies configuration failures with a stable SDK error code", async () => {
  await assert.rejects(
    resolveConfig({ network: "custom" }),
    (error: unknown) => {
      assert.ok(error instanceof ToolkitError);
      assert.equal(error.code, "CONFIGURATION");
      assert.match(error.message, /requires an RPC URL/);
      return true;
    },
  );
});

test("rejects inverted risk thresholds", async () => {
  await assert.rejects(
    resolveConfig({ network: "testnet", criticalDays: 30, warningDays: 7 }),
    /critical-days must be less than warning-days/,
  );
});

test("rejects misspelled configuration fields", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "soroban-config-"));
  const configPath = join(directory, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({ network: "testnet", criticalDay: 7 }),
    );
    await assert.rejects(
      resolveConfig({ configPath }),
      /Unknown configuration field\(s\): criticalDay/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads an RPC bearer token only from the environment", async () => {
  const previous = process.env.STELLAR_RPC_AUTH_TOKEN;
  process.env.STELLAR_RPC_AUTH_TOKEN = "test-token";
  try {
    const config = await resolveConfig({ network: "testnet" });
    assert.equal(config.rpcAuthToken, "test-token");
  } finally {
    if (previous === undefined) {
      delete process.env.STELLAR_RPC_AUTH_TOKEN;
    } else {
      process.env.STELLAR_RPC_AUTH_TOKEN = previous;
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { Address, Asset, xdr } from "@stellar/stellar-sdk";
import { resolveConfig } from "../config.js";
import { SorobanRpcClient } from "../rpc-client.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const nativeAssetContract = new Address(
  Asset.native().contractId(TESTNET_PASSPHRASE),
).toScAddress();
const knownNativeAssetInstanceKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: nativeAssetContract,
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
  }),
).toXDR("base64");
const key = process.env.STORAGE_LEDGER_KEY_XDR ?? knownNativeAssetInstanceKey;

test("inspects a known contract-data key against Stellar Testnet", async () => {
  const config = await resolveConfig({
    network: "testnet",
    ...(process.env.STELLAR_RPC_URL
      ? { rpcUrl: process.env.STELLAR_RPC_URL }
      : {}),
  });
  const snapshot = await new SorobanRpcClient(config).inspect([key]);
  assert.equal(snapshot.networkPassphrase, TESTNET_PASSPHRASE);
  assert.ok(
    Number.isSafeInteger(snapshot.latestLedger) && snapshot.latestLedger > 0,
  );
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0]?.found, true);
  assert.ok(
    (snapshot.entries[0]?.liveUntilLedgerSeq ?? 0) > snapshot.latestLedger,
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import { ledgerKeyFromEntryData, parseStorageKey } from "../ledger-key.js";

test("validates Soroban ledger keys and derives the TTL key from the key hash", () => {
  const ledgerKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 7) }),
  );
  const parsed = parseStorageKey(ledgerKey.toXDR("base64"));
  const ttlKey = xdr.LedgerKey.fromXDR(parsed.ttlKeyXdr, "base64");

  assert.equal(parsed.type, "contractCode");
  assert.equal(ttlKey.type, "ttl");
  assert.deepEqual(
    Buffer.from(ttlKey.ttl.keyHash.value),
    createHash("sha256").update(ledgerKey.toXDR()).digest(),
  );
});

test("rejects malformed, non-canonical, and non-Soroban ledger keys", () => {
  assert.throws(() => parseStorageKey("%%%"), /base64-encoded XDR/);
  assert.throws(() => parseStorageKey("AA"), /canonical base64/);

  const accountKey = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(32)),
    }),
  );
  assert.throws(
    () => parseStorageKey(accountKey.toXDR("base64")),
    /only Soroban/,
  );
});

test("reconstructs the exact contract-data key from RPC entry data", () => {
  const contract = new Address(
    Address.contract(Buffer.alloc(32, 11)).toString(),
  ).toScAddress();
  const storageKey = xdr.ScVal.scvSymbol("COUNTER");
  const durability = xdr.ContractDataDurability.persistent;
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({ contract, key: storageKey, durability }),
  );
  const entryData = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract,
      key: storageKey,
      durability,
      val: xdr.ScVal.scvU32(1),
    }),
  );

  assert.equal(ledgerKeyFromEntryData(entryData), ledgerKey.toXDR("base64"));
});

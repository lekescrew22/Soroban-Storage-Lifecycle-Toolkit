import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import { parseStorageKeyManifest } from "../manifest.js";

function contractCodeKey(fill: number): string {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, fill) }),
  ).toXDR("base64");
}

test("parses a versioned manifest and canonicalizes its ledger keys", () => {
  const key = contractCodeKey(1);
  const result = parseStorageKeyManifest({
    version: 1,
    entries: [
      {
        name: " wasm ",
        key,
        owner: " platform ",
        notes: " reviewed ",
      },
    ],
  });

  assert.deepEqual(result, {
    version: 1,
    entries: [
      {
        name: "wasm",
        key,
        owner: "platform",
        notes: "reviewed",
      },
    ],
  });
});

test("rejects unsupported versions, duplicate names or keys, and invalid keys", () => {
  const key = contractCodeKey(2);
  assert.throws(
    () =>
      parseStorageKeyManifest({ version: 2, entries: [{ name: "wasm", key }] }),
    /version.*must be 1/,
  );
  assert.throws(
    () =>
      parseStorageKeyManifest({
        version: 1,
        entries: [
          { name: "wasm", key },
          { name: "wasm", key: contractCodeKey(3) },
        ],
      }),
    /duplicate name/,
  );
  assert.throws(
    () =>
      parseStorageKeyManifest({
        version: 1,
        entries: [
          { name: "first", key },
          { name: "second", key },
        ],
      }),
    /duplicate ledger key/,
  );
  assert.throws(
    () =>
      parseStorageKeyManifest({
        version: 1,
        entries: [{ name: "bad key", key: "not-xdr" }],
      }),
    /invalid ledger key/,
  );
});

test("rejects empty and oversized entry lists and unknown fields", () => {
  assert.throws(
    () => parseStorageKeyManifest({ version: 1, entries: [] }),
    /non-empty array/,
  );
  assert.throws(
    () =>
      parseStorageKeyManifest({
        version: 1,
        entries: Array.from({ length: 201 }, (_, index) => ({
          name: `key-${index}`,
          key: contractCodeKey(index),
        })),
      }),
    /at most 200/,
  );
  assert.throws(
    () =>
      parseStorageKeyManifest({
        version: 1,
        entries: [{ name: "wasm", key: contractCodeKey(4), extra: true }],
      }),
    /unknown field/,
  );
});

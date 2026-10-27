import { createHash } from "node:crypto";
import { xdr } from "@stellar/stellar-sdk";
import { errorMessage, isToolkitError, ToolkitError } from "./errors.js";

export interface ParsedStorageKey {
  xdr: string;
  bytes: Buffer;
  type: "contractData" | "contractCode";
  durability: "temporary" | "persistent" | null;
  ttlKeyXdr: string;
}

function decodeBase64(value: string, description: string): Buffer {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error(`${description} must be base64-encoded XDR`);
  }
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.toString("base64") !== trimmed) {
    throw new Error(`${description} must be canonical base64`);
  }
  return bytes;
}

function parseStorageKeyUnchecked(encoded: string): ParsedStorageKey {
  const bytes = decodeBase64(encoded, "Ledger key");
  if (bytes.length > 64 * 1024) {
    throw new Error("Ledger key XDR exceeds the 64 KiB safety limit");
  }
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.fromXDR(bytes);
  } catch (error) {
    throw new Error(`Invalid LedgerKey XDR: ${String(error)}`);
  }
  if (key.toXDR("base64") !== encoded.trim()) {
    throw new Error("Ledger key must contain exactly one canonical XDR value");
  }

  const type = key.type;
  if (type !== "contractData" && type !== "contractCode") {
    throw new Error(
      `Unsupported ledger key type "${type}"; only Soroban contractData and contractCode keys have TTLs`,
    );
  }

  const hash = createHash("sha256").update(bytes).digest();
  const ttlKey = xdr.LedgerKey.ttl(new xdr.LedgerKeyTtl({ keyHash: hash }));
  return {
    xdr: key.toXDR("base64"),
    bytes,
    type,
    durability:
      key.type === "contractData" ? key.contractData.durability.name : null,
    ttlKeyXdr: ttlKey.toXDR("base64"),
  };
}

export function parseStorageKey(encoded: string): ParsedStorageKey {
  try {
    return parseStorageKeyUnchecked(encoded);
  } catch (error) {
    if (isToolkitError(error)) {
      throw error;
    }
    throw new ToolkitError("INVALID_INPUT", errorMessage(error), {
      cause: error,
    });
  }
}

export function decodeLedgerEntryData(encoded: string): xdr.LedgerEntryData {
  const bytes = decodeBase64(encoded, "Ledger entry");
  try {
    const data = xdr.LedgerEntryData.fromXDR(bytes);
    if (data.toXDR("base64") !== encoded.trim()) {
      throw new Error("non-canonical encoding");
    }
    return data;
  } catch (error) {
    throw new Error(`Invalid LedgerEntryData XDR: ${String(error)}`);
  }
}

export function ledgerKeyFromEntryData(data: xdr.LedgerEntryData): string {
  if (data.type === "contractData") {
    const entry = data.contractData;
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: entry.contract,
        key: entry.key,
        durability: entry.durability,
      }),
    ).toXDR("base64");
  }
  if (data.type === "contractCode") {
    return xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: data.contractCode.hash }),
    ).toXDR("base64");
  }
  throw new Error(`Unsupported ledger entry data type "${data.type}"`);
}

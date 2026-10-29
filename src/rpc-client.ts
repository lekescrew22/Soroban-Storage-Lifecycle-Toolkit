import {
  parseStorageKey,
  decodeLedgerEntryData,
  ledgerKeyFromEntryData,
} from "./ledger-key.js";
import type { ToolkitConfig } from "./config.js";
import { xdr } from "@stellar/stellar-sdk";
import { errorMessage, ToolkitError } from "./errors.js";

/** Maximum number of keys one `inspect` call accepts across all RPC requests. */
export const MAX_INSPECT_KEYS = 1_000;
/**
 * Maximum number of keys sent in one `getLedgerEntries` request. This matches
 * the Soroban RPC per-request limit; larger inputs are split into chunks.
 */
export const MAX_KEYS_PER_RPC_REQUEST = 200;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_ENTRY_XDR_BYTES = 10 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_LEDGER_SEQUENCE = 0xffff_ffff;
const LEDGER_INTERVALS_TO_SAMPLE = 10;
const MAX_PLAUSIBLE_LEDGER_INTERVAL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RPC_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 250] as const;
const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
} as const;

interface RpcLedgerEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq: number;
  liveUntilLedgerSeq: number | null;
}

interface RpcLedgerSnapshot {
  latestLedger: number;
  entries: Map<string, RpcLedgerEntry>;
}

export interface LedgerCloseInterval {
  seconds: number;
  source: "observed" | "configured-fallback";
  samplingWindow: {
    startLedger: number;
    endLedger: number;
    ledgerCount: number;
    intervalCount: number;
  } | null;
  fallbackReason?:
    | "not-sampled"
    | "ledger-history-unavailable"
    | "insufficient-ledger-history"
    | "incomplete-ledger-window"
    | "missing-close-time"
    | "invalid-close-time"
    | "non-monotonic-close-time"
    | "implausible-close-time";
}

export interface InspectedEntry {
  key: string;
  name?: string;
  owner?: string;
  notes?: string;
  keyType: "contractData" | "contractCode";
  durability: "temporary" | "persistent" | null;
  ttlKey: string;
  found: boolean;
  lastModifiedLedgerSeq: number | null;
  liveUntilLedgerSeq: number | null;
  entryBytes: number | null;
}

/**
 * Describes how the entries were read. Soroban RPC cannot pin several
 * `getLedgerEntries` requests to one ledger, so when more than one request is
 * needed the entries may come from different ledgers between
 * `oldestLedger` and `latestLedger`.
 */
export interface SnapshotConsistency {
  requestCount: number;
  oldestLedger: number;
  latestLedger: number;
}

export interface RpcSnapshot {
  networkPassphrase: string;
  /** Highest ledger observed across all requests. */
  latestLedger: number;
  ledgerCloseInterval: LedgerCloseInterval;
  entries: InspectedEntry[];
  consistency: SnapshotConsistency;
}

export interface SorobanRpcClientOptions {
  /** Keys per `getLedgerEntries` request, from 1 to MAX_KEYS_PER_RPC_REQUEST. */
  maxKeysPerRequest?: number;
}

export function requireLiveUntilLedgerSeq(
  entry: Pick<InspectedEntry, "key" | "found" | "liveUntilLedgerSeq">,
): number {
  if (entry.liveUntilLedgerSeq === null) {
    const reason = entry.found
      ? "expiration metadata was not returned by the RPC provider"
      : "the ledger entry was not found";
    throw new ToolkitError(
      "TTL_METADATA_UNAVAILABLE",
      `Expiration ledger is unavailable for key ${entry.key}: ${reason}`,
    );
  }
  return entry.liveUntilLedgerSeq;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalLedgerKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("RPC returned a ledger entry without a key");
  }
  try {
    const canonical = xdr.LedgerKey.fromXDR(value, "base64").toXDR("base64");
    if (canonical !== value) {
      throw new Error("non-canonical encoding");
    }
    return canonical;
  } catch (error) {
    throw new Error(`RPC returned an invalid ledger key: ${String(error)}`);
  }
}

export class SorobanRpcClient {
  private readonly maxKeysPerRequest: number;

  constructor(
    private readonly config: ToolkitConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    options: SorobanRpcClientOptions = {},
  ) {
    const chunkSize = options.maxKeysPerRequest ?? MAX_KEYS_PER_RPC_REQUEST;
    if (
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < 1 ||
      chunkSize > MAX_KEYS_PER_RPC_REQUEST
    ) {
      throw new ToolkitError(
        "CONFIGURATION",
        `maxKeysPerRequest must be an integer from 1 to ${MAX_KEYS_PER_RPC_REQUEST}`,
      );
    }
    this.maxKeysPerRequest = chunkSize;
  }

  async inspect(
    keys: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<RpcSnapshot> {
    const { signal } = options;
    try {
      this.throwIfAborted(signal);
      return await this.inspectUnchecked(keys, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw this.abortError();
      }
      if (error instanceof ToolkitError) {
        throw error;
      }
      throw new ToolkitError("RPC_RESPONSE", errorMessage(error), {
        cause: error,
      });
    }
  }

  private async inspectUnchecked(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<RpcSnapshot> {
    if (keys.length === 0) {
      throw new ToolkitError(
        "INVALID_INPUT",
        "Provide at least one ledger key",
      );
    }
    if (keys.length > MAX_INSPECT_KEYS) {
      throw new ToolkitError(
        "INVALID_INPUT",
        `At most ${MAX_INSPECT_KEYS} storage keys can be inspected per call`,
      );
    }
    const parsedKeys = keys.map(parseStorageKey);
    const uniqueStorageKeys = new Set<string>();
    for (const parsed of parsedKeys) {
      if (uniqueStorageKeys.has(parsed.xdr)) {
        throw new ToolkitError(
          "INVALID_INPUT",
          `Duplicate ledger key: ${parsed.xdr}`,
        );
      }
      uniqueStorageKeys.add(parsed.xdr);
    }
    const chunks: string[][] = [];
    for (let i = 0; i < parsedKeys.length; i += this.maxKeysPerRequest) {
      const chunk = parsedKeys
        .slice(i, i + this.maxKeysPerRequest)
        .map((parsed) => parsed.xdr);
      const requestBytes = chunk.reduce(
        (total, key) => total + Buffer.byteLength(key, "utf8"),
        0,
      );
      if (requestBytes > MAX_REQUEST_BYTES) {
        throw new ToolkitError(
          "INVALID_INPUT",
          "Combined ledger key request exceeds the 1 MB safety limit",
        );
      }
      chunks.push(chunk);
    }

    const networkPassphrase = await this.verifyNetwork(signal);
    // Requests run one at a time so a failure stops further requests and no
    // partial result is returned.
    const found = new Map<string, RpcLedgerEntry>();
    let oldestLedger = Number.POSITIVE_INFINITY;
    let latestLedger = 0;
    for (const [index, chunk] of chunks.entries()) {
      let snapshot: RpcLedgerSnapshot;
      try {
        snapshot = await this.getLedgerEntries(chunk, signal);
        const requested = new Set(chunk);
        for (const returnedKey of snapshot.entries.keys()) {
          if (!requested.has(returnedKey)) {
            throw new ToolkitError(
              "RPC_RESPONSE",
              "RPC returned a ledger entry that was not requested",
            );
          }
        }
      } catch (error) {
        if (chunks.length === 1 || signal?.aborted) {
          throw error;
        }
        const prefix = `getLedgerEntries request ${index + 1} of ${chunks.length} failed`;
        if (error instanceof ToolkitError) {
          throw new ToolkitError(error.code, `${prefix}: ${error.message}`, {
            cause: error,
          });
        }
        throw new ToolkitError(
          "RPC_RESPONSE",
          `${prefix}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      for (const [key, entry] of snapshot.entries) {
        found.set(key, entry);
      }
      oldestLedger = Math.min(oldestLedger, snapshot.latestLedger);
      latestLedger = Math.max(latestLedger, snapshot.latestLedger);
    }
    const ledgerCloseInterval = await this.getLedgerCloseInterval(
      latestLedger,
      signal,
    );

    const entries = parsedKeys.map((parsed): InspectedEntry => {
      const storage = found.get(parsed.xdr);
      if (storage) {
        const storageEntry = decodeLedgerEntryData(storage.xdr);
        const actualKey = ledgerKeyFromEntryData(storageEntry);
        if (actualKey !== parsed.xdr) {
          throw new ToolkitError(
            "RPC_RESPONSE",
            `RPC returned ledger data that does not match requested key ${parsed.xdr}`,
          );
        }
      }
      return {
        key: parsed.xdr,
        keyType: parsed.type,
        durability: parsed.durability,
        ttlKey: parsed.ttlKeyXdr,
        found: storage !== undefined,
        lastModifiedLedgerSeq: storage?.lastModifiedLedgerSeq ?? null,
        liveUntilLedgerSeq: storage?.liveUntilLedgerSeq ?? null,
        entryBytes: storage ? Buffer.from(storage.xdr, "base64").length : null,
      };
    });

    return {
      networkPassphrase,
      latestLedger,
      ledgerCloseInterval,
      entries,
      consistency: {
        requestCount: chunks.length,
        oldestLedger,
        latestLedger,
      },
    };
  }

  private async getLedgerCloseInterval(
    latestLedger: number,
    signal?: AbortSignal,
  ): Promise<LedgerCloseInterval> {
    const startLedger = latestLedger - LEDGER_INTERVALS_TO_SAMPLE;
    if (startLedger < 1) {
      return this.fallbackLedgerCloseInterval("insufficient-ledger-history");
    }

    let result: unknown;
    try {
      result = await this.callRpc(
        "getLedgers",
        {
          startLedger,
          pagination: { limit: LEDGER_INTERVALS_TO_SAMPLE + 1 },
          xdrFormat: "base64",
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ToolkitError && error.code === "RPC_ERROR") {
        return this.fallbackLedgerCloseInterval("ledger-history-unavailable");
      }
      throw error;
    }
    if (!isObject(result) || !Array.isArray(result.ledgers)) {
      return this.fallbackLedgerCloseInterval("incomplete-ledger-window");
    }
    if (result.ledgers.length !== LEDGER_INTERVALS_TO_SAMPLE + 1) {
      return this.fallbackLedgerCloseInterval("incomplete-ledger-window");
    }

    const timestamps: number[] = [];
    for (let index = 0; index < result.ledgers.length; index += 1) {
      const ledger = result.ledgers[index];
      if (!isObject(ledger) || ledger.sequence !== startLedger + index) {
        return this.fallbackLedgerCloseInterval("incomplete-ledger-window");
      }
      if (
        ledger.ledgerCloseTime === undefined ||
        ledger.ledgerCloseTime === null
      ) {
        return this.fallbackLedgerCloseInterval("missing-close-time");
      }
      if (
        typeof ledger.ledgerCloseTime !== "string" ||
        !/^\d+$/.test(ledger.ledgerCloseTime)
      ) {
        return this.fallbackLedgerCloseInterval("invalid-close-time");
      }
      const timestamp = Number(ledger.ledgerCloseTime);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
        return this.fallbackLedgerCloseInterval("invalid-close-time");
      }
      timestamps.push(timestamp);
    }

    const intervals: number[] = [];
    for (let index = 1; index < timestamps.length; index += 1) {
      const interval = timestamps[index]! - timestamps[index - 1]!;
      if (interval <= 0) {
        return this.fallbackLedgerCloseInterval("non-monotonic-close-time");
      }
      if (interval > MAX_PLAUSIBLE_LEDGER_INTERVAL_SECONDS) {
        return this.fallbackLedgerCloseInterval("implausible-close-time");
      }
      intervals.push(interval);
    }

    return {
      seconds:
        intervals.reduce((total, interval) => total + interval, 0) /
        intervals.length,
      source: "observed",
      samplingWindow: {
        startLedger,
        endLedger: latestLedger,
        ledgerCount: timestamps.length,
        intervalCount: intervals.length,
      },
    };
  }

  private fallbackLedgerCloseInterval(
    fallbackReason: NonNullable<LedgerCloseInterval["fallbackReason"]>,
  ): LedgerCloseInterval {
    return {
      seconds: this.config.ledgerCloseSeconds,
      source: "configured-fallback",
      samplingWindow: null,
      fallbackReason,
    };
  }

  private async verifyNetwork(signal?: AbortSignal): Promise<string> {
    const result = await this.callRpc("getNetwork", {}, signal);
    if (
      !isObject(result) ||
      typeof result.passphrase !== "string" ||
      result.passphrase.length === 0 ||
      !Number.isSafeInteger(result.protocolVersion) ||
      (result.protocolVersion as number) < 1
    ) {
      throw new Error("RPC returned an invalid getNetwork response");
    }
    const expectedPassphrase =
      this.config.expectedNetworkPassphrase ??
      (this.config.network === "custom"
        ? undefined
        : NETWORK_PASSPHRASES[this.config.network]);
    if (
      expectedPassphrase !== undefined &&
      result.passphrase !== expectedPassphrase
    ) {
      throw new ToolkitError(
        "NETWORK_MISMATCH",
        `RPC network passphrase does not match the configured expectation for "${this.config.network}"`,
      );
    }
    return result.passphrase;
  }

  private async getLedgerEntries(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<RpcLedgerSnapshot> {
    const result = await this.callRpc(
      "getLedgerEntries",
      {
        keys,
        xdrFormat: "base64",
      },
      signal,
    );
    if (
      !isObject(result) ||
      !Number.isSafeInteger(result.latestLedger) ||
      (result.latestLedger as number) < 1 ||
      (result.latestLedger as number) > MAX_LEDGER_SEQUENCE ||
      !Array.isArray(result.entries)
    ) {
      throw new Error("RPC returned an invalid getLedgerEntries response");
    }
    const latestLedger = result.latestLedger as number;
    const entries = new Map<string, RpcLedgerEntry>();
    for (const value of result.entries) {
      if (
        !isObject(value) ||
        typeof value.xdr !== "string" ||
        Buffer.byteLength(value.xdr, "utf8") > MAX_ENTRY_XDR_BYTES ||
        !Number.isSafeInteger(value.lastModifiedLedgerSeq) ||
        (value.lastModifiedLedgerSeq as number) < 0 ||
        (value.lastModifiedLedgerSeq as number) > MAX_LEDGER_SEQUENCE ||
        (value.lastModifiedLedgerSeq as number) > latestLedger ||
        (value.liveUntilLedgerSeq !== undefined &&
          (!Number.isSafeInteger(value.liveUntilLedgerSeq) ||
            (value.liveUntilLedgerSeq as number) < 0 ||
            (value.liveUntilLedgerSeq as number) > MAX_LEDGER_SEQUENCE))
      ) {
        throw new Error("RPC returned an invalid ledger entry");
      }
      const key = canonicalLedgerKey(value.key);
      if (entries.has(key)) {
        throw new Error(`RPC returned a duplicate ledger entry for ${key}`);
      }
      entries.set(key, {
        key,
        xdr: value.xdr,
        lastModifiedLedgerSeq: value.lastModifiedLedgerSeq as number,
        liveUntilLedgerSeq:
          typeof value.liveUntilLedgerSeq === "number"
            ? value.liveUntilLedgerSeq
            : null,
      });
    }
    return { latestLedger, entries };
  }

  private async callRpc(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_RPC_ATTEMPTS; attempt += 1) {
      this.throwIfAborted(signal);
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.rpcUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.rpcAuthToken
              ? { authorization: `Bearer ${this.config.rpcAuthToken}` }
              : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted) {
          throw this.abortError();
        }
        if (attempt + 1 < MAX_RPC_ATTEMPTS) {
          await this.delay(RETRY_DELAYS_MS[attempt]!, signal);
          continue;
        }
        throw new ToolkitError(
          "RPC_TRANSPORT",
          `Soroban RPC request failed after ${MAX_RPC_ATTEMPTS} attempts; check the endpoint, connectivity, or ${REQUEST_TIMEOUT_MS} ms timeout`,
          { cause: error },
        );
      }
      this.throwIfAborted(signal);
      if (!response.ok) {
        if (
          [429, 500, 502, 503, 504].includes(response.status) &&
          attempt + 1 < MAX_RPC_ATTEMPTS
        ) {
          await response.body?.cancel();
          await this.delay(this.retryDelay(response, attempt), signal);
          continue;
        }
        throw new ToolkitError(
          "RPC_HTTP",
          `Soroban RPC returned HTTP ${response.status}`,
        );
      }
      const result = await this.parseResponse(response);
      this.throwIfAborted(signal);
      return result;
    }
    throw new ToolkitError(
      "RPC_TRANSPORT",
      "Soroban RPC request failed after exhausting retries",
    );
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw this.abortError();
    }
  }

  private abortError(): ToolkitError {
    return new ToolkitError("ABORTED", "Inspection was cancelled");
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      return Math.min(Number(retryAfter) * 1_000, 2_000);
    }
    if (retryAfter) {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) {
        return Math.max(0, Math.min(retryAt - Date.now(), 2_000));
      }
    }
    return RETRY_DELAYS_MS[attempt]!;
  }

  private delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.throwIfAborted(signal);
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(this.abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_RPC_RESPONSE_BYTES
    ) {
      throw new Error(
        `Soroban RPC response exceeds the ${MAX_RPC_RESPONSE_BYTES}-byte safety limit`,
      );
    }
    if (!response.body) {
      throw new Error("Soroban RPC returned an empty response body");
    }
    let responseText: string;
    try {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RPC_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(
            `Soroban RPC response exceeds the ${MAX_RPC_RESPONSE_BYTES}-byte safety limit`,
          );
        }
        chunks.push(value);
      }
      responseText = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (error instanceof Error && error.message.includes("safety limit")) {
        throw error;
      }
      throw new Error(`Unable to read Soroban RPC response: ${String(error)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch (error) {
      throw new Error(`Soroban RPC returned invalid JSON: ${String(error)}`);
    }
    if (!isObject(payload)) {
      throw new Error("Soroban RPC returned an invalid JSON-RPC response");
    }
    if (payload.jsonrpc !== "2.0" || payload.id !== 1) {
      throw new Error(
        "Soroban RPC returned a mismatched JSON-RPC version or request ID",
      );
    }
    if (isObject(payload.error)) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : "unknown RPC error";
      throw new ToolkitError("RPC_ERROR", `Soroban RPC error: ${message}`);
    }
    if (!("result" in payload)) {
      throw new Error("Soroban RPC response did not contain a result");
    }
    return payload.result;
  }
}

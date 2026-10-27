import { readFile } from "node:fs/promises";
import { errorMessage, isToolkitError, ToolkitError } from "./errors.js";

export type Network = "testnet" | "mainnet" | "futurenet" | "custom";

export interface ToolkitConfig {
  network: Network;
  rpcUrl: string;
  rpcAuthToken?: string;
  expectedNetworkPassphrase?: string;
  criticalDays: number;
  warningDays: number;
  ledgerCloseSeconds: number;
  rentFeePerByteLedger?: string;
}

export interface ConfigOverrides {
  configPath?: string;
  network?: Network;
  rpcUrl?: string;
  expectedNetworkPassphrase?: string;
  criticalDays?: number;
  warningDays?: number;
  ledgerCloseSeconds?: number;
  rentFeePerByteLedger?: string;
}

const RPC_URLS: Record<Exclude<Network, "custom">, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORKS = new Set<Network>([
  "testnet",
  "mainnet",
  "futurenet",
  "custom",
]);
const NETWORK_PASSPHRASES: Record<Exclude<Network, "custom">, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function parseConfigFile(value: unknown): Partial<ToolkitConfig> {
  if (!isObject(value)) {
    throw new Error("Configuration file must contain a JSON object");
  }
  const allowedFields = new Set([
    "network",
    "rpcUrl",
    "networkPassphrase",
    "criticalDays",
    "warningDays",
    "ledgerCloseSeconds",
    "rentFeePerByteLedger",
  ]);
  const unknownFields = Object.keys(value).filter(
    (key) => !allowedFields.has(key),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Unknown configuration field(s): ${unknownFields.join(", ")}`,
    );
  }
  const parsed: Partial<ToolkitConfig> = {};

  if (value.network !== undefined) {
    if (
      typeof value.network !== "string" ||
      !NETWORKS.has(value.network as Network)
    ) {
      throw new Error(
        "Configuration network must be testnet, mainnet, futurenet, or custom",
      );
    }
    parsed.network = value.network as Network;
  }
  if (value.rpcUrl !== undefined) {
    if (typeof value.rpcUrl !== "string") {
      throw new Error("Configuration rpcUrl must be a string");
    }
    parsed.rpcUrl = value.rpcUrl;
  }
  if (value.networkPassphrase !== undefined) {
    if (
      typeof value.networkPassphrase !== "string" ||
      value.networkPassphrase.trim() === ""
    ) {
      throw new Error(
        "Configuration networkPassphrase must be a non-empty string",
      );
    }
    parsed.expectedNetworkPassphrase = value.networkPassphrase;
  }
  if (value.criticalDays !== undefined) {
    parsed.criticalDays = positiveNumber(value.criticalDays, "criticalDays");
  }
  if (value.warningDays !== undefined) {
    parsed.warningDays = positiveNumber(value.warningDays, "warningDays");
  }
  if (value.ledgerCloseSeconds !== undefined) {
    parsed.ledgerCloseSeconds = positiveNumber(
      value.ledgerCloseSeconds,
      "ledgerCloseSeconds",
    );
  }
  if (value.rentFeePerByteLedger !== undefined) {
    if (
      typeof value.rentFeePerByteLedger !== "string" ||
      !/^\d+$/.test(value.rentFeePerByteLedger)
    ) {
      throw new Error(
        "Configuration rentFeePerByteLedger must be a non-negative integer string",
      );
    }
    parsed.rentFeePerByteLedger = value.rentFeePerByteLedger;
  }
  return parsed;
}

function validateRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RPC URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("RPC URL must use HTTP or HTTPS");
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Non-local RPC endpoints must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("RPC URL must not include credentials");
  }
  return url.toString().replace(/\/$/, "");
}

async function resolveConfigUnchecked(
  overrides: ConfigOverrides,
): Promise<ToolkitConfig> {
  let fileConfig: Partial<ToolkitConfig> = {};
  if (overrides.configPath) {
    let content: string;
    try {
      content = await readFile(overrides.configPath, "utf8");
    } catch (error) {
      throw new Error(
        `Unable to read config file "${overrides.configPath}": ${String(error)}`,
      );
    }

    try {
      fileConfig = parseConfigFile(JSON.parse(content) as unknown);
    } catch (error) {
      throw new Error(
        `Invalid config file "${overrides.configPath}": ${String(error)}`,
      );
    }
  }

  const networkValue =
    overrides.network ??
    fileConfig.network ??
    process.env.STELLAR_NETWORK ??
    "testnet";
  if (
    typeof networkValue !== "string" ||
    !NETWORKS.has(networkValue as Network)
  ) {
    throw new Error("network must be testnet, mainnet, futurenet, or custom");
  }
  const network = networkValue as Network;
  const envUrl = process.env.STELLAR_RPC_URL;
  const rpcUrl =
    overrides.rpcUrl ??
    fileConfig.rpcUrl ??
    envUrl ??
    (network === "custom" ? undefined : RPC_URLS[network]);
  const rpcAuthToken = process.env.STELLAR_RPC_AUTH_TOKEN;
  const expectedNetworkPassphrase =
    overrides.expectedNetworkPassphrase ?? fileConfig.expectedNetworkPassphrase;

  if (!rpcUrl) {
    throw new Error(
      "A custom network requires an RPC URL (--rpc-url or config rpcUrl)",
    );
  }
  const criticalDays = overrides.criticalDays ?? fileConfig.criticalDays ?? 7;
  const warningDays = overrides.warningDays ?? fileConfig.warningDays ?? 30;
  const ledgerCloseSeconds =
    overrides.ledgerCloseSeconds ?? fileConfig.ledgerCloseSeconds ?? 5;
  const rentFeePerByteLedger =
    overrides.rentFeePerByteLedger ?? fileConfig.rentFeePerByteLedger;

  positiveNumber(criticalDays, "critical-days");
  positiveNumber(warningDays, "warning-days");
  positiveNumber(ledgerCloseSeconds, "ledger-close-seconds");
  if (criticalDays >= warningDays) {
    throw new Error("critical-days must be less than warning-days");
  }
  if (
    expectedNetworkPassphrase !== undefined &&
    (typeof expectedNetworkPassphrase !== "string" ||
      expectedNetworkPassphrase.trim() === "")
  ) {
    throw new Error("network-passphrase must be a non-empty string");
  }
  if (rpcAuthToken !== undefined && rpcAuthToken.trim() === "") {
    throw new Error("STELLAR_RPC_AUTH_TOKEN must not be empty");
  }
  if (
    network !== "custom" &&
    expectedNetworkPassphrase !== undefined &&
    expectedNetworkPassphrase !== NETWORK_PASSPHRASES[network]
  ) {
    throw new Error(
      `network-passphrase does not match the selected "${network}" network`,
    );
  }
  if (
    rentFeePerByteLedger !== undefined &&
    !/^\d+$/.test(rentFeePerByteLedger)
  ) {
    throw new Error("rent-fee-per-byte-ledger must be a non-negative integer");
  }

  return {
    network,
    rpcUrl: validateRpcUrl(rpcUrl),
    ...(rpcAuthToken === undefined ? {} : { rpcAuthToken }),
    ...(expectedNetworkPassphrase === undefined
      ? {}
      : { expectedNetworkPassphrase }),
    criticalDays,
    warningDays,
    ledgerCloseSeconds,
    ...(rentFeePerByteLedger === undefined ? {} : { rentFeePerByteLedger }),
  };
}

export async function resolveConfig(
  overrides: ConfigOverrides,
): Promise<ToolkitConfig> {
  try {
    return await resolveConfigUnchecked(overrides);
  } catch (error) {
    if (isToolkitError(error)) {
      throw error;
    }
    throw new ToolkitError("CONFIGURATION", errorMessage(error), {
      cause: error,
    });
  }
}

#!/usr/bin/env node
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { resolveConfig, type ConfigOverrides, type Network } from "./config.js";
import {
  createInspectionReport,
  createMaintenancePlan,
} from "./maintenance-planner.js";
import { SorobanRpcClient } from "./rpc-client.js";
import { formatReport, type OutputFormat } from "./report.js";

interface CommandOptions {
  key?: string[];
  keysFile?: string;
  format?: OutputFormat;
  output?: string;
  targetDays?: number;
}

const MAX_KEYS_FILE_BYTES = 1_000_000;

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive number`);
  }
  return parsed;
}

function nonNegativeInteger(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      "rent-fee-per-byte-ledger must be a non-negative integer",
    );
  }
  return value;
}

async function loadKeys(options: CommandOptions): Promise<string[]> {
  const keys = [...(options.key ?? [])];
  if (options.keysFile) {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(options.keysFile);
    } catch (error) {
      throw new Error(
        `Unable to inspect keys file "${options.keysFile}": ${String(error)}`,
      );
    }
    if (!fileStat.isFile()) {
      throw new Error(`Keys file "${options.keysFile}" is not a regular file`);
    }
    if (fileStat.size > MAX_KEYS_FILE_BYTES) {
      throw new Error(
        `Keys file exceeds the ${MAX_KEYS_FILE_BYTES}-byte safety limit`,
      );
    }
    let text: string;
    try {
      text = await readFile(options.keysFile, "utf8");
    } catch (error) {
      throw new Error(
        `Unable to read keys file "${options.keysFile}": ${String(error)}`,
      );
    }
    keys.push(
      ...text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  }
  if (keys.length === 0) {
    throw new Error("Provide one or more --key values or a --keys-file");
  }
  if (keys.length > 200) {
    throw new Error("Provide at most 200 ledger keys per command");
  }
  return keys;
}

function configOverrides(options: Record<string, unknown>): ConfigOverrides {
  return {
    ...(typeof options.config === "string"
      ? { configPath: options.config }
      : {}),
    ...(typeof options.network === "string"
      ? { network: options.network as Network }
      : {}),
    ...(typeof options.rpcUrl === "string" ? { rpcUrl: options.rpcUrl } : {}),
    ...(typeof options.networkPassphrase === "string"
      ? { expectedNetworkPassphrase: options.networkPassphrase }
      : {}),
    ...(typeof options.criticalDays === "number"
      ? { criticalDays: options.criticalDays }
      : {}),
    ...(typeof options.warningDays === "number"
      ? { warningDays: options.warningDays }
      : {}),
    ...(typeof options.ledgerCloseSeconds === "number"
      ? { ledgerCloseSeconds: options.ledgerCloseSeconds }
      : {}),
    ...(typeof options.rentFeePerByteLedger === "string"
      ? { rentFeePerByteLedger: options.rentFeePerByteLedger }
      : {}),
  };
}

async function writeReportAtomically(
  path: string,
  content: string,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(`${content}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    const cleanupOperations: Promise<unknown>[] = [
      rm(temporaryPath, { force: true }),
    ];
    if (temporaryFile) {
      cleanupOperations.push(temporaryFile.close());
    }
    const cleanupResults = await Promise.allSettled(cleanupOperations);
    const cleanupErrors = cleanupResults
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Unable to write report "${path}" and temporary-file cleanup failed`,
      );
    }
    throw new Error(`Unable to write report "${path}": ${String(error)}`);
  }
}

async function run(
  kind: "inspect" | "plan",
  options: CommandOptions,
  globalOptions: Record<string, unknown>,
): Promise<void> {
  const config = await resolveConfig(configOverrides(globalOptions));
  const keys = await loadKeys(options);
  const { networkPassphrase, latestLedger, entries } =
    await new SorobanRpcClient(config).inspect(keys);
  const report = createInspectionReport(
    config.network,
    latestLedger,
    entries,
    config,
    networkPassphrase,
  );
  const result =
    kind === "plan"
      ? createMaintenancePlan(report, config, options.targetDays ?? 30)
      : report;
  const output = formatReport(result, options.format ?? "table");
  if (options.output) {
    await writeReportAtomically(options.output, output);
  } else {
    console.log(output);
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("soroban-storage")
    .description("Inspect known Soroban ledger keys and plan TTL maintenance.")
    .option("--config <path>", "JSON configuration file")
    .addOption(
      new Option("--network <network>", "Stellar network").choices([
        "testnet",
        "mainnet",
        "futurenet",
        "custom",
      ]),
    )
    .option("--rpc-url <url>", "Soroban RPC endpoint")
    .option(
      "--network-passphrase <passphrase>",
      "Expected network passphrase (useful for custom RPC endpoints)",
    )
    .option(
      "--critical-days <days>",
      "Critical risk threshold in days",
      (value) => positiveNumber(value, "critical-days"),
    )
    .option(
      "--warning-days <days>",
      "Warning risk threshold in days",
      (value) => positiveNumber(value, "warning-days"),
    )
    .option(
      "--ledger-close-seconds <seconds>",
      "Average ledger close time used for estimates",
      (value) => positiveNumber(value, "ledger-close-seconds"),
    )
    .option(
      "--rent-fee-per-byte-ledger <stroops>",
      "Optional illustrative rent rate for estimates",
      nonNegativeInteger,
    );

  const inspect = program
    .command("inspect")
    .description("Inspect explicitly supplied contract storage keys.")
    .option(
      "--key <base64-xdr>",
      "Contract storage LedgerKey XDR; repeat for multiple keys",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--keys-file <path>",
      "Text file containing one base64 LedgerKey XDR per line",
    )
    .addOption(
      new Option("--format <format>", "Output format")
        .choices(["table", "json", "csv"])
        .default("table"),
    )
    .option("--output <path>", "Write the report to a file");

  inspect.action(async (options: CommandOptions) =>
    run("inspect", options, program.opts()),
  );

  const plan = program
    .command("plan")
    .description(
      "Create a dry-run TTL extension plan; no transaction is submitted.",
    )
    .option(
      "--key <base64-xdr>",
      "Contract storage LedgerKey XDR; repeat for multiple keys",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--keys-file <path>",
      "Text file containing one base64 LedgerKey XDR per line",
    )
    .option(
      "--target-days <days>",
      "Desired remaining TTL in days",
      (value) => positiveNumber(value, "target-days"),
      30,
    )
    .addOption(
      new Option("--format <format>", "Output format")
        .choices(["table", "json", "csv"])
        .default("table"),
    )
    .option("--output <path>", "Write the report to a file");

  plan.action(async (options: CommandOptions) =>
    run("plan", options, program.opts()),
  );

  await program.parseAsync(process.argv);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

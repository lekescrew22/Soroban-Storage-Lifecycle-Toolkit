#!/usr/bin/env node
import { Address, xdr } from "@stellar/stellar-sdk";

const [contractId, storageKey, durability = "persistent"] =
  process.argv.slice(2);
if (
  !contractId ||
  !storageKey ||
  !["persistent", "temporary"].includes(durability)
) {
  console.error(
    "Usage: node examples/contract-data-key.mjs <contract-id> <symbol-key> [persistent|temporary]",
  );
  process.exitCode = 1;
} else {
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvSymbol(storageKey),
      durability:
        durability === "persistent"
          ? xdr.ContractDataDurability.persistent
          : xdr.ContractDataDurability.temporary,
    }),
  );
  console.log(ledgerKey.toXDR("base64"));
}

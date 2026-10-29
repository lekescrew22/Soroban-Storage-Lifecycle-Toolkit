# Operations runbook

This toolkit performs read-only Soroban RPC inspection and produces reports or
dry-run extension plans. It does not discover every storage key, guarantee
expiration, construct transactions, sign, or submit transactions. Treat this
runbook as guidance for operating the inspection workflow, not authorization
to automate contract changes.

## Before scheduling inspections

1. Maintain the known-key manifest in a reviewed change. Record the source and
   owner for each key. A contract ID does not enumerate its full storage.
2. Select an RPC provider appropriate for the network, confirm its rate limits,
   retention policy, and availability commitments, and configure the expected
   network passphrase for custom endpoints.
3. Store provider tokens in the runtime secret manager and expose them only as
   `STELLAR_RPC_AUTH_TOKEN`. Do not put credentials in the RPC URL, a manifest,
   a config file, a report, or CI logs.
4. Choose risk thresholds and `ledgerCloseSeconds` deliberately. Remaining
   days are approximations based on this interval, not a time guarantee.
5. Test the exact manifest, endpoint, and report destination in a non-production
   environment before scheduling a production read.

## Running and reviewing

- Keep reports access-controlled; CLI file output uses mode `0600` on supported
  platforms. Avoid publishing reports if they reveal private operational
  metadata.
- Alert on failed inspections separately from TTL risk. A failed RPC call or
  missing entry is not evidence that an entry is healthy.
- Treat `unknown` risk, missing `liveUntilLedgerSeq`, and a missing ledger entry
  as conditions requiring investigation. Do not silently substitute an
  expiration value.
- Review `networkPassphrase`, `latestLedger`, and the assumptions in each report.
  Reports are snapshots and become stale as the ledger advances. Inspections of
  more than 200 keys use several RPC requests that may observe different
  ledgers; the report's limitations list the observed ledger range.
- Re-inspect immediately before acting on a plan. The dry-run cost estimate is
  only illustrative and must not be used as a transaction fee quote.

## Provider failures and recovery

- The client retries a bounded set of transient transport and HTTP failures.
  Avoid wrapping it in aggressive retries that multiply provider load.
- On repeated timeouts, HTTP 429s, or server failures, check provider status and
  rate-limit guidance, reduce inspection frequency, and retry after recovery.
- A network-passphrase mismatch is a stop condition: verify the configured
  network and endpoint before proceeding.
- If an RPC provider omits TTL metadata or returns inconsistent data, preserve
  the failed/unknown result, record the provider and time, and compare with a
  separately configured trusted endpoint if policy allows. Do not infer TTL.
- Keep known-key manifests and prior reports versioned or stored in an
  access-controlled system so changes can be reviewed and reports compared.

## Incident response

If credentials may have been exposed, revoke or rotate the RPC token in the
provider console and secret manager, inspect CI logs and artifacts, then rerun
with the rotated token. Do not commit credentials while investigating.

If a report indicates critical risk or an entry is missing, verify the key,
network passphrase, provider, and latest ledger with a fresh inspection. Escalate
to the contract owner for any remediation. This toolkit does not guarantee that
an entry can be restored or extended, and it must not be used as an
authorization or safety control.

## Release and maintenance

Merge only reviewed changes with passing CI. Review dependency and GitHub Actions
updates, check the package from a clean consumer install before release, and
publish only through a separately reviewed release process. The repository
currently has no automatic npm publishing workflow.

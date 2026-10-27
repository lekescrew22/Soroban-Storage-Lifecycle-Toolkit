# Contributing

## Development setup

Use Node.js 20 or newer. Install the lockfile dependencies and run the local checks:

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run format:check
```

The build output is generated in `dist/` and should not be committed.

## Project layout

- `src/config.ts` — network and risk configuration
- `src/ledger-key.ts` — XDR validation and TTL-key derivation
- `src/rpc-client.ts` — Soroban RPC inspection
- `src/risk.ts` — expiration risk classification
- `src/maintenance-planner.ts` — reports and dry-run plans
- `src/report.ts` — table, JSON, and CSV serialization
- `src/cli.ts` — CLI commands
- `src/tests/` — unit tests and opt-in Testnet integration test
- `examples/` — key-encoding example

## Guidelines

- Keep inspection limited to explicitly supplied keys; never imply that a contract ID enumerates all storage.
- Do not add transaction signing or automatic extension to the read-only MVP.
- Cost estimates must expose their assumptions and must not be presented as authoritative RPC quotes.
- Add focused tests for behavior changes. Live Testnet coverage is opt-in through `npm run test:integration`; it uses a known native-asset contract key by default. `STORAGE_LEDGER_KEY_XDR` can override that key.
- Run `npm run format` before submitting changes; CI verifies formatting, unit tests, dependency advisories, and type safety.
- Keep RPC errors visible to callers and avoid logging credentials or private keys.

# OnchainDiligence Sanctions Screen — GitHub Action

Screen the wallet addresses in your repo against sanctions lists on every push or PR, and **fail the build if any address is sanctioned**. Compliance as a build step.

Catches a sanctioned payout/treasury/vendor address *before* it merges — instead of after money moves.

## Quick start

Add `.github/workflows/sanctions.yml`:

```yaml
name: Sanctions screen
on: [pull_request]

jobs:
  screen:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Qazza1/onchaindiligence-action@v1
        with:
          payer-key: ${{ secrets.PAYER_KEY }}
```

That scans your config files for addresses, screens each one, and fails the job if any is sanctioned.

## Real vs sandbox mode

Screening is a paid per-call check, so real screening needs a funded key:

- **With `payer-key`** (a funded viem private key, passed as a secret) → **real screening**. Add it under *Settings → Secrets and variables → Actions* as `PAYER_KEY`.
- **Without `payer-key`** → **sandbox mode**: only the documented [test vectors](https://onchaindiligence.com/docs#sandbox) return a result; real addresses are reported as *not screened*. Use this to wire the action up and confirm it runs before funding it. It never pretends a real address was screened.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `files` | `**/*.json,**/*.env,**/*.yml,**/*.yaml,**/*.toml` | Globs of files to scan for addresses |
| `addresses` | `''` | Extra addresses to screen directly (comma/newline separated) |
| `payer-key` | `''` | Funded viem key for real screening. Pass as `${{ secrets.PAYER_KEY }}` |
| `fail-on-sanctioned` | `true` | Fail the build when a sanctioned address is found |
| `base-url` | `''` | Override the API base URL (advanced) |

## Outputs

| Output | Description |
|--------|-------------|
| `screened-count` | Unique addresses screened |
| `sanctioned-count` | Addresses that came back sanctioned |

## What it does

1. Lists tracked files matching `files`, plus any `addresses` you pass in.
2. Extracts `0x…` (40-hex) addresses from them.
3. Screens each unique address — real (with a key) or sandbox (without).
4. Writes a summary table, annotates any sanctioned hits, and — if `fail-on-sanctioned` — exits non-zero to block the merge.

Every result comes from the [OnchainDiligence](https://onchaindiligence.com) API; the sanctions data is the free Chainalysis on-chain oracle plus the public OFAC SDN list. This action adds no screening logic of its own — it wraps the published [`@onchaindiligence/cli`](https://www.npmjs.com/package/@onchaindiligence/cli).

## Try it without a key first

Leave `payer-key` out and put a test vector in a file to see the fail path:

```json
{ "vendor": "0x00000000000000000000000000000000000000ba" }
```

That address is the sandbox "always sanctioned" vector — the action will screen it (free) and, with `fail-on-sanctioned: true`, fail the build. Swap in `payer-key` when you're ready to screen real addresses.

## License

MIT

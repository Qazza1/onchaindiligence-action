#!/usr/bin/env node
/**
 * scan.mjs — the OnchainDiligence GitHub Action.
 *
 * Finds Ethereum-style addresses in the repo (config/payout files), screens
 * each against sanctions data via the OnchainDiligence API, and fails the build
 * if any is sanctioned. Compliance as a build step.
 *
 * Payment model (honest by construction):
 *   - With a funded PAYER_KEY secret  -> REAL screening (paid per address).
 *   - Without PAYER_KEY               -> SANDBOX mode: only documented test
 *     vectors return a result; real addresses are reported as "not screened
 *     (no payer key)". This lets you wire the action up and prove it runs
 *     before funding it — but it NEVER pretends a real address was screened.
 */

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const BASE = (process.env.OCD_BASE_URL || 'https://api.onchaindiligence.com').replace(/\/$/, '')
const PAYER_KEY = (process.env.PAYER_KEY || '').trim()
const FAIL_ON_SANCTIONED = (process.env.OCD_FAIL_ON_SANCTIONED || 'true') === 'true'
const REAL_MODE = PAYER_KEY.length > 0

// ---- output helpers (GitHub Actions annotations + summary) ----
function log(s) { process.stdout.write(s + '\n') }
function ghError(s) { log(`::error::${s}`) }
function ghWarn(s) { log(`::warning::${s}`) }
function setOutput(name, val) {
  const f = process.env.GITHUB_OUTPUT
  if (f) appendFileSync(f, `${name}=${val}\n`)
}
function summary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (f) appendFileSync(f, md + '\n')
}

// ---- collect files to scan ----
function globToFiles(patterns) {
  // Use git to list tracked files, then filter by simple glob suffix matching.
  // Avoids a glob dependency; works in the Actions checkout.
  let tracked = []
  try {
    tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    // not a git repo (unlikely in Actions) — fall back to nothing
    tracked = []
  }
  const pats = patterns
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const matched = new Set()
  for (const p of pats) {
    // support "**/*.json" style — reduce to an extension test
    const extMatch = p.match(/\*\.([a-zA-Z0-9]+)$/)
    if (extMatch) {
      const ext = '.' + extMatch[1]
      tracked.forEach((f) => { if (f.endsWith(ext)) matched.add(f) })
    } else if (existsSync(p)) {
      matched.add(p)
    }
  }
  return [...matched]
}

// ---- extract addresses ----
const ADDR_RE = /0x[a-fA-F0-9]{40}/g
function extractAddresses(files) {
  const found = new Map() // address -> Set(files)
  for (const file of files) {
    let content
    try { content = readFileSync(file, 'utf8') } catch { continue }
    const matches = content.match(ADDR_RE)
    if (!matches) continue
    for (const m of matches) {
      const a = m.toLowerCase()
      if (!found.has(a)) found.set(a, new Set())
      found.get(a).add(file)
    }
  }
  return found
}

// ---- screen one address ----
async function screenReal(address) {
  // Use the CLI via npx so we don't reimplement payment. The CLI reads PAYER_KEY
  // from the environment (already set). --json for parseable output.
  const cmd = `npx --yes @onchaindiligence/cli screen ${address} --json`
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      env: { ...process.env, OCD_BASE_URL: BASE },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(out)
  } catch (e) {
    // CLI prints errors to stderr and exits non-zero on failure.
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim()
    return { __error: msg || 'screening failed' }
  }
}

async function screenSandbox(address) {
  // Free sandbox endpoint. Only test vectors return a result; a real address
  // is refused (400), which we surface honestly as "not screened".
  try {
    const res = await fetch(`${BASE}/sandbox/screen/${address}`)
    const d = await res.json()
    if (!res.ok || d.error) return { __sandbox_refused: true, detail: d.detail || d.error }
    return d
  } catch (e) {
    return { __error: e.message }
  }
}

async function main() {
  const fileList = globToFiles(process.env.OCD_FILES || '')
  const found = extractAddresses(fileList)

  // add explicit addresses
  const explicit = (process.env.OCD_ADDRESSES || '')
    .split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter((s) => /^0x[a-f0-9]{40}$/.test(s))
  for (const a of explicit) {
    if (!found.has(a)) found.set(a, new Set(['(input)']))
  }

  const addresses = [...found.keys()]

  log(`OnchainDiligence — scanning ${fileList.length} file(s), found ${addresses.length} unique address(es).`)
  log(REAL_MODE
    ? 'Mode: REAL screening (PAYER_KEY provided) — paid per address.'
    : 'Mode: SANDBOX (no PAYER_KEY) — only test vectors are screened; real addresses are reported as not screened.')

  if (addresses.length === 0) {
    log('No addresses found. Nothing to screen.')
    setOutput('screened_count', '0')
    setOutput('sanctioned_count', '0')
    summary('### OnchainDiligence\nNo addresses found to screen.')
    return
  }

  let sanctioned = []
  let screened = 0
  let notScreened = []
  let errors = []
  const rows = []

  for (const address of addresses) {
    const result = REAL_MODE ? await screenReal(address) : await screenSandbox(address)
    const where = [...found.get(address)].join(', ')

    if (result.__error) {
      errors.push({ address, msg: result.__error })
      rows.push(`| \`${address}\` | error | ${where} |`)
      continue
    }
    if (result.__sandbox_refused) {
      notScreened.push(address)
      rows.push(`| \`${address}\` | not screened (sandbox) | ${where} |`)
      continue
    }
    screened++
    const isSanctioned = result?.data?.sanctioned === true
    if (isSanctioned) {
      sanctioned.push({ address, where })
      rows.push(`| \`${address}\` | 🔴 SANCTIONED | ${where} |`)
      ghError(`Sanctioned address found: ${address} (in ${where})`)
    } else {
      rows.push(`| \`${address}\` | ✓ clean | ${where} |`)
    }
  }

  // ---- summary table ----
  summary('### OnchainDiligence — sanctions screen')
  summary(REAL_MODE ? '_Real screening._' : '_Sandbox mode (no PAYER_KEY set) — real addresses were not screened._')
  summary('')
  summary('| Address | Result | Found in |')
  summary('|---|---|---|')
  rows.forEach((r) => summary(r))

  setOutput('screened_count', String(screened))
  setOutput('sanctioned_count', String(sanctioned.length))

  if (errors.length) {
    ghWarn(`${errors.length} address(es) could not be screened due to errors.`)
  }
  if (notScreened.length && !REAL_MODE) {
    ghWarn(`${notScreened.length} real address(es) were NOT screened because no PAYER_KEY is set. Add a funded PAYER_KEY secret to screen real addresses.`)
  }

  // ---- verdict ----
  if (sanctioned.length > 0) {
    log(`\n❌ ${sanctioned.length} sanctioned address(es) found.`)
    if (FAIL_ON_SANCTIONED) {
      ghError(`Build failed: ${sanctioned.length} sanctioned address(es) found in the repo.`)
      process.exit(1)
    }
  } else {
    log(`\n✓ No sanctioned addresses among ${screened} screened.`)
  }
}

main().catch((e) => {
  ghError('OnchainDiligence action failed: ' + (e && e.message ? e.message : e))
  process.exit(1)
})

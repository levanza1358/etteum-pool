# Project Structure

Root is kept for runtime entrypoints and project-wide configuration only.

## Root

- `src/` — backend API, proxy routing, providers, database, websocket code
- `dashboard/` — React/Vite dashboard
- `scripts/` — runtime/startup/auth helper scripts
- `test/` — tests and manual verification scripts
- `docs/` — setup guides and implementation notes
- `plans/` — planning documents
- `data/` — local runtime data (SQLite, generated runtime files)
- `package.json`, `tsconfig.json`, `drizzle.config.ts` — project configuration
- `etteum`, `etteum.cmd`, `etteum.ps1` — local service control wrappers
- `install.sh`, `install.ps1` — installer scripts

## Test and debug files

Manual one-off scripts should go under:

- `test/manual/`

Examples:

- `test/manual/test-opus.ts`
- `test/manual/check-qoder-quota.ts`
- `test/manual/debug-byok.ts`

## Notes and implementation docs

Non-user-facing implementation notes should go under:

- `docs/notes/`

Examples:

- `docs/notes/QODER_OPENAI_FIX_SUMMARY.md`
- `docs/notes/VCC_POOL_UPGRADE.md`

## Generated helper artifacts

Generated helper blobs or build artifacts used by scripts should go under:

- `scripts/generated/`

Example:

- `scripts/generated/serve-dashboard.b64`

## Keep root clean

Avoid adding new loose files to the repository root unless they are:

- a runtime entrypoint
- a package/build config
- a top-level README/license
- an installer/service file

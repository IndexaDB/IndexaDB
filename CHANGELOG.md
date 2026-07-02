# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Live-tail resilience: a transient error in one stream during `watch()` is logged
  and retried on the next poll instead of crashing the indexer. The checkpoint only
  advances with committed writes, so retries never skip or double-write.
- The CSV connector now picks up appended rows during live tail (re-reads on change,
  skipping the re-parse when the file's mtime is unchanged).
- The query API reads through a dedicated connection (`store.openReader()`), so it
  never observes the engine's in-flight write transaction. For SQLite this is a
  second read-only WAL connection with a committed-only snapshot; for Postgres the
  pool already isolates reads from the transaction client.
- Structured JSON logging via `INDEXA_LOG_FORMAT=json` (BigInt-safe), for shipping
  logs into an aggregator; `setFormat()` is exported alongside `setLevel()`.
- SQLite pragmas tuned for a live indexer: `busy_timeout=5000` and
  `synchronous=NORMAL` (durable against app crashes, faster) in addition to WAL.
- Query filter operators over both the store API and HTTP: `_ne`, `_gt`, `_gte`,
  `_lt`, `_lte`, `_in` (comma list) and `_like`, in addition to equality. ISO-8601
  `Timestamp` ranges sort correctly.
- List responses now include a `total` (full match count) alongside the page
  `count`, plus the effective `limit`/`offset`, for real pagination.
- CORS support on the query API (permissive by default, configurable via
  `api.cors`) with `OPTIONS` preflight handling.
- `/_health` now reports app name, uptime and per-stream checkpoints, and returns
  `503` when the store is unreachable.
- `store.count()` and `store.allCheckpoints()`.
- Full `node:test` unit suite (schema, config, CSV, store, API, engine) run via
  `npm test`; GitHub Actions CI across Node 22 and 24; example-config validation.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `.editorconfig`, and richer `package.json`
  metadata (`license`, `author`, `repository`, `keywords`, `files`).

### Fixed
- **EVM reorg-hash leak:** block hashes for the reorg window are stored in a
  single, self-pruning kv value per event instead of one kv row per block, so a
  long-running EVM indexer no longer grows `_indexa_meta` without bound.
- Graceful shutdown (`SIGINT`/`SIGTERM`) now drains the in-flight pump and awaits
  `server.close()` before closing the store, so a container stop can't interrupt
  a transaction. Repeated signals are ignored.
- `indexa validate` now catches source-specific mistakes up front (missing csv
  `file`, postgres `tables`, evm `contracts`/`abi`) and non-positive `batchSize`
  / negative `pollIntervalMs`, instead of failing later at connector init.
- **Security:** `orderBy` (and any filter column) is now validated against the
  entity schema before being interpolated into SQL, closing a SQL-injection vector
  via the `?orderBy=` query param. Invalid columns return `400` instead of `500`.
- Query filter values are coerced to their declared type, so `?active=true` matches
  a SQLite Boolean stored as `1` and `?items=3` matches an Int reliably.
- `limit`/`offset` are clamped to non-negative values, preventing a negative
  `LIMIT` from becoming an unbounded scan in SQLite.

### Changed
- The API now returns a generic `Internal server error` on unexpected `500`s and
  logs the real error server-side, instead of returning internal messages to clients.
- Non-`GET` methods on the API return `405`.
- WHERE-clause construction is centralized in a shared `buildWhere()` used by both
  `query()` and `count()` in each store.

## [0.1.0]

Initial release: declarative YAML config, CSV/Postgres/EVM connectors, SQLite and
Postgres targets, incremental sync with transactional checkpointing, automatic EVM
reorg handling with an undo journal, and an auto-generated REST query API.

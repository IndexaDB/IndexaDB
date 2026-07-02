# Contributing to Indexa

Thanks for helping improve Indexa. This project stays deliberately small and
dependency-light — contributions that keep it that way are the easiest to merge.

## Development setup

```bash
npm install        # js-yaml + optional pg/ethers
npm test           # node --test — should be green before you start
```

Indexa targets **Node.js >= 22.5** and uses the built-in `node:sqlite`, so no
database install is needed for the default path.

## Guidelines

- **Add a test with every behaviour change.** Tests live in `test/*.test.mjs` and
  use the built-in `node:test` runner. `npm test` must stay green.
- **Keep the core lean.** `js-yaml` is the only required runtime dependency; `pg`
  and `ethers` are optional and lazy-loaded only when their connector/target is
  used. New heavyweight dependencies need a strong justification.
- **Match the surrounding style.** 2-space indent, LF line endings, ES modules,
  small focused functions. `.editorconfig` codifies the basics.
- **Never interpolate untrusted input into SQL.** Column names (filters, orderBy)
  must be validated against the schema; values must be bound as parameters. See
  `buildWhere`/`assertField` in `src/store.js`.
- **Document user-facing changes** in `README.md` and add an entry to
  `CHANGELOG.md` under `Unreleased`.

## Adding a connector

Implement `init(cfg, ctx)` / `streams()` / `close()` (see
`src/connectors/base.js` and `examples/custom-connector/`). Each stream exposes an
ordered, monotonic **cursor**; the engine persists the last written cursor inside
the same transaction as the writes, which is what makes resumption idempotent.
Register it with `registerConnector('mytype', MyConnector)`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`) with a short imperative
subject and a body explaining the *why*.

## Pull requests

CI runs the test suite on Node 22 and 24 and validates the example configs. Make
sure both pass locally (`npm test`) before opening a PR.

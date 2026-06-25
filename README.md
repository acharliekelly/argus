# Argus

Argus is a deterministic CLI for evaluating one WordPress plugin or theme update against a local Docker staging site. It inventories the site, captures a functional and visual baseline, snapshots the database and `wp-content`, applies the update, reruns the checks, and writes a machine-readable report.

Argus does not deploy changes or automatically restore snapshots.

## Requirements

- Node.js 22 or newer; Node.js 24 is the primary CI runtime.
- Docker with Compose v2.
- Playwright Chromium.

## Install

```bash
npm install
npx playwright install chromium
docker compose up -d
```

Install WordPress on the first run:

```bash
docker compose run --rm wpcli wp core install \
  --url=http://localhost:8093 \
  --title=Argus \
  --admin_user=argus \
  --admin_password=argus-local-password \
  --admin_email=argus@example.test \
  --skip-email \
  --allow-root

docker compose run --rm wpcli wp plugin activate argus-demo --allow-root
```

The default configuration is [`argus.config.ts`](argus.config.ts). Secrets should be declared there as environment-variable names and supplied through the process environment.

## Commands

```bash
npm run argus -- inventory
npm run argus -- check
npm run argus -- update --type plugin --slug argus-demo
npm run argus -- rollback --run <run-id>
```

`inventory` reports core, plugin, and theme versions. Core updates are visible but intentionally unsupported because the Compose image owns the WordPress core version.

`check` creates a non-mutating run under `.argus/runs/check-<timestamp>/`.

`update` exits:

- `0` when every gate passes.
- `1` when the baseline, functional, update, or visual result fails.
- `2` when configuration or preflight validation prevents a safe run.

`rollback` restores both the database and `wp-content` snapshot from the selected run and then validates the restored site.

## Deterministic regression demo

The Compose environment installs `argus-demo` v1 and serves an update package for v2 from the local `fixture-server` service. Version 2 deliberately overlays the entire page.

```bash
docker compose up -d
npm run argus -- inventory
npm run argus -- update --type plugin --slug argus-demo
```

The update should complete, functional checks should still load the page, the pixel comparison should fail, and the report should recommend `rollback`. Use the printed run ID:

```bash
npm run argus -- rollback --run <run-id>
```

## Artifacts

Every update run writes:

```text
.argus/runs/<run-id>/
├── report.json
├── snapshot/
│   ├── database.sql
│   └── wp-content.tar.gz
└── screenshots/
    ├── baseline/
    ├── after/
    ├── diff/
    └── rollback/
```

Reports are written atomically and redact configured secret values. Interrupted runs are not resumed automatically.

## Development

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run check
```

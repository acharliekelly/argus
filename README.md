# Argus

Argus is a deterministic CLI for evaluating one WordPress plugin or theme update against a local Docker staging site. It inventories the site, captures a functional and visual baseline, snapshots the database and `wp-content`, applies the update, reruns the checks, and writes a machine-readable report.

Argus does not deploy changes or automatically restore snapshots.

## Requirements

- Node.js 22 or newer; Node.js 24 is the primary CI runtime.
- Docker with Compose v2.
- Playwright Chromium.

## Install Argus

```bash
npm install
npx playwright install chromium
```

## Test an existing local WordPress instance

Argus can save local Docker Compose WordPress sites by name, then reuse them without editing the target repository or maintaining a target-specific Argus config file. The site does not need to use port `8093`; Argus discovers the running WordPress container, host URL, network, database settings, and WordPress mount from Docker.

Use a staging or disposable local copy. An update run changes the selected plugin or theme, and rollback replaces the database and the complete `wp-content` directory with the saved versions.

### Compatibility requirements

The existing site must provide:

- A Docker Compose file accessible from the Argus host process.
- A running WordPress service reachable by Playwright from the host.
- WordPress files mounted at `/var/www/html` as either a bind mount or named Docker volume.
- Standard `WORDPRESS_DB_HOST`, `WORDPRESS_DB_NAME`, `WORDPRESS_DB_USER`, and `WORDPRESS_DB_PASSWORD` environment variables on the WordPress container.
- A database host reachable from an ephemeral helper container on the same Compose network.
- Docker permission to run short-lived helper containers with `--volumes-from <wordpress-container>`.

Argus uses ephemeral `wordpress:cli` and `alpine:3.22` helper containers. Existing sites do not need a WP-CLI service, `/argus` mount, or `ARGUS_DIR` environment variable.

Argus currently supports plugin and theme updates. It inventories WordPress core updates but does not apply them because Docker images should control the installed core version.

### 1. Connect once

From the Argus repository:

```bash
npm run argus -- connect wp-melroseuu \
  --compose ~/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml
```

The profile is saved under `~/.config/argus/sites/<name>.json`. Artifacts are saved under `~/.local/share/argus/sites/<name>/`.

If discovery is ambiguous, provide overrides:

```bash
npm run argus -- connect my-site \
  --compose /absolute/path/to/docker-compose.yml \
  --wordpress-service wordpress \
  --url http://localhost:8090 \
  --helper-image wordpress:cli \
  --force
```

### 2. Verify compatibility without changing WordPress

```bash
npm run argus -- inventory --site wp-melroseuu
npm run argus -- check --site wp-melroseuu
```

Do not run an update until both commands succeed. `inventory` verifies helper access, WP-CLI connectivity, and WordPress installation. `check` verifies browser access and creates baseline screenshots without changing WordPress.

### 3. Test one update

Choose a slug reported by `inventory` with an available update:

```bash
npm run argus -- update --site wp-melroseuu --type plugin --slug plugin-slug
# or
npm run argus -- update --site wp-melroseuu --type theme --slug theme-slug
```

Review the printed status and `~/.local/share/argus/sites/<name>/runs/<run-id>/report.json`. If Argus recommends rollback:

```bash
npm run argus -- rollback --site wp-melroseuu --run <run-id>
```

Rollback is always explicit. Argus never deploys to another environment and never restores automatically.

### 4. Manage saved sites

```bash
npm run argus -- site list
npm run argus -- site show wp-melroseuu
npm run argus -- site edit wp-melroseuu
npm run argus -- site disconnect wp-melroseuu
```

`disconnect` removes only the saved profile. Existing run artifacts remain for inspection.

## Run the bundled demo

The repository includes a disposable WordPress site and a plugin update that intentionally causes a visual regression.

```bash
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

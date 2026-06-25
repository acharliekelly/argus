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

Argus can test an existing WordPress site when it runs in Docker Compose and meets the compatibility requirements below. The site does not need to use port `8093`; its URL and Compose service names are configurable.

Use a staging or disposable local copy. An update run changes the selected plugin or theme, and rollback replaces the database and the complete `wp-content` directory with the saved versions.

### Compatibility requirements

The existing site must provide:

- A Docker Compose file accessible from the Argus host process.
- A running WordPress service reachable by Playwright from the host.
- A WP-CLI service that shares the same complete WordPress filesystem as the WordPress service.
- WordPress files mounted at `/var/www/html` in both services.
- The Argus artifact directory mounted at `/argus` in both services.
- `tar` in the WordPress container.
- `wp` and `mariadb` in the WP-CLI container. The `wordpress:cli` image provides both.
- Working `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` values available through `wp config get`.
- A database host reachable from the WP-CLI service.

Argus currently supports plugin and theme updates. It inventories WordPress core updates but does not apply them because Docker images should control the installed core version.

### 1. Add or adapt a WP-CLI service

In the existing site's Compose file, ensure WordPress and WP-CLI share the full WordPress volume. Replace service names, database settings, and the volume name as needed:

```yaml
services:
  wordpress:
    # Keep the site's existing image, ports, environment, and dependencies.
    volumes:
      - wp_data:/var/www/html
      - ${ARGUS_DIR}/.argus:/argus

  wpcli:
    image: wordpress:cli
    profiles: ["tools"]
    user: "0:0"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wp_user
      WORDPRESS_DB_PASSWORD: wp_password
      WORDPRESS_DB_NAME: wp_database
    volumes:
      - wp_data:/var/www/html
      - ${ARGUS_DIR}/.argus:/argus
    working_dir: /var/www/html
```

If the existing site bind-mounts WordPress instead of using `wp_data`, mount the same host directory into `/var/www/html` in both services.

Set `ARGUS_DIR` to this repository's absolute path before using either Compose or Argus:

```bash
export ARGUS_DIR=/absolute/path/to/wp-argus
mkdir -p "$ARGUS_DIR/.argus"
```

### 2. Configure the target site

Copy `argus.config.ts` if you want to preserve the demo configuration, then change:

```ts
export default defineConfig({
  baseUrl: 'http://localhost:8080',
  artifactDir: '.argus',
  compose: {
    file: '/absolute/path/to/existing-site/docker-compose.yml',
    wordpressService: 'wordpress',
    wpCliService: 'wpcli',
    profiles: ['tools']
  },
  visualThreshold: 0.01,
  viewports: [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 }
  ],
  scenarios: [
    {
      name: 'home',
      path: '/',
      run: async (page) => {
        await page.locator('body').waitFor({ state: 'visible' });
      }
    }
  ]
});
```

Use the URL exposed to the host, not the WordPress container's internal hostname. Add important routes as scenarios and mask timestamps, rotating banners, or other dynamic elements before relying on visual results.

If the WP-CLI service does not use a profile, set `profiles: []`.

### 3. Verify compatibility without changing WordPress

From the Argus repository:

```bash
npm run argus -- inventory
npm run argus -- check
```

Do not run an update until both commands succeed. `inventory` verifies Docker, required Compose services, WP-CLI access, and WordPress installation. `check` verifies browser access and creates baseline screenshots without changing WordPress.

### 4. Test one update

Choose a slug reported by `inventory` with an available update:

```bash
npm run argus -- update --type plugin --slug plugin-slug
# or
npm run argus -- update --type theme --slug theme-slug
```

Review the printed status and `.argus/runs/<run-id>/report.json`. If Argus recommends rollback:

```bash
npm run argus -- rollback --run <run-id>
```

Rollback is always explicit. Argus never deploys to another environment and never restores automatically.

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

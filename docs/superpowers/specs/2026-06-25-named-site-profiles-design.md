# Argus Named Site Profiles Design

## Summary

Argus will connect to an existing local Docker Compose WordPress site without requiring changes to the target repository. A successful connection is saved under a user-chosen name and reused by inventory, check, update, and rollback commands.

Profiles are stored user-wide under `~/.config/argus/sites/`. Reports, screenshots, and snapshots are stored under `~/.local/share/argus/sites/`. Profiles contain target metadata but no database credentials.

## User Interface

Connect a site:

```bash
argus connect wp-melroseuu \
  --compose ~/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml
```

`connect` discovers the target and prints the resolved values before saving them. Optional flags override ambiguous or incorrect discoveries:

```bash
argus connect wp-melroseuu \
  --compose /path/to/docker-compose.yml \
  --wordpress-service wordpress \
  --url http://localhost:8090
```

Routine commands use the saved name:

```bash
argus inventory --site wp-melroseuu
argus check --site wp-melroseuu
argus update --site wp-melroseuu --type plugin --slug example
argus rollback --site wp-melroseuu --run <run-id>
```

Site management commands are:

```bash
argus site list
argus site show wp-melroseuu
argus site edit wp-melroseuu
argus site disconnect wp-melroseuu
```

`site edit` opens the profile in `$VISUAL`, then `$EDITOR`, and fails with a clear message if neither is configured. The edited profile must pass schema and live-target validation before replacing the saved profile. `disconnect` removes only the profile; artifacts remain unless the user separately requests their removal.

## Discovery and Connection

Argus resolves the Compose file to an absolute path and uses Docker Compose configuration plus live container inspection.

It identifies the WordPress service using these signals:

1. A running Compose service container.
2. A WordPress image or WordPress environment variables.
3. A mount targeting `/var/www/html`.

If one service matches, Argus selects it. If none or several match, connection fails and requests `--wordpress-service`.

Argus derives the base URL from the WordPress service’s published port 80 mapping. If exactly one host port is published, the default is `http://localhost:<port>`. If discovery is ambiguous or the site uses HTTPS, a reverse proxy, or another hostname, connection fails and requests `--url`.

Argus records:

- Profile name and schema version.
- Absolute Compose file path and Compose project directory.
- Compose project and WordPress service names.
- Running WordPress container ID.
- Compose network name.
- WordPress filesystem mount information.
- Base URL.
- Helper image version.
- Default browser scenarios, masks, viewports, and thresholds.

Container IDs are refreshed from Compose before each command, so recreating the WordPress container does not invalidate the profile.

Before saving, Argus launches an ephemeral helper container and verifies:

- The Compose project and WordPress service are running.
- The WordPress filesystem is visible at `/var/www/html`.
- `wp core is-installed` succeeds.
- The database is reachable using the WordPress configuration.
- The host can load the configured base URL.
- User-wide artifact storage is writable.

## Ephemeral Helper Containers

Argus runs a pinned `wordpress:cli` helper container directly through Docker. It joins the discovered Compose network and mounts the same WordPress filesystem sources at the same container destinations as the WordPress service.

The helper also receives a temporary read-only copy of the target WordPress container’s relevant WordPress environment variables. Secrets are passed through the helper environment at runtime and are never stored in the profile, logs, command records, or reports.

The helper is removed after every operation. Argus does not:

- Edit the target Compose file.
- Create a persistent WP-CLI service.
- Mount Argus storage into the target WordPress container.
- Leave an agent or helper container running.

The first release supports bind mounts and named volumes that Docker can mount into another local container. Unsupported mount drivers or inaccessible host paths fail during `connect` with a compatibility explanation.

## Snapshot and Rollback Data Flow

Run artifacts are stored under:

```text
~/.local/share/argus/sites/<site-name>/runs/<run-id>/
```

Database export runs in the ephemeral helper and streams SQL to the host. Database restore streams the saved SQL from the host into the helper’s MariaDB client. Database passwords are supplied only through the helper environment.

`wp-content` snapshot and restore run in an ephemeral utility container with the WordPress filesystem mounted. Archives stream between the utility container and user-wide storage; the target WordPress container does not need `/argus` mounts.

Rollback retains the existing safety contract:

- Snapshot both database and complete `wp-content` before mutation.
- Restore only through an explicit rollback command.
- Validate snapshot ownership against the selected site and run.
- Rerun browser checks after restoration.
- Never deploy or automatically roll back.

Each report records the site profile name and a fingerprint of the connected Compose project, WordPress service, filesystem mount, and database identity. Rollback fails if the current target fingerprint differs in a way that could restore into another site.

## Site Profile Schema

The JSON profile contains:

```json
{
  "schemaVersion": 1,
  "name": "wp-melroseuu",
  "composeFile": "/home/user/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml",
  "projectDirectory": "/home/user/Code/DOCKER-WP/wp-melroseuu",
  "projectName": "wp-melroseuu",
  "wordpressService": "wordpress",
  "baseUrl": "http://localhost:8090",
  "helperImage": "wordpress:cli",
  "scenarios": [
    {
      "name": "home",
      "path": "/",
      "mask": ["#wpadminbar"],
      "visualThreshold": 0.01
    }
  ],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 1000 },
    { "name": "mobile", "width": 390, "height": 844 }
  ]
}
```

Profiles do not allow executable TypeScript scenario callbacks. Named-site profiles use declarative checks: page load, HTTP success, visible body, optional visible selectors, masks, and screenshot thresholds. The existing TypeScript configuration remains available as an advanced mode for custom Playwright logic.

Site names must match `^[a-z0-9][a-z0-9_-]*$`. `connect` refuses to overwrite an existing profile unless `--force` is supplied.

## Compatibility and Failure Handling

Named-site mode supports local Docker Compose targets where:

- WordPress is running in a Compose-managed container.
- WordPress files are mounted at `/var/www/html`.
- The mount can be reused by a local helper container.
- The database is reachable from the Compose network.
- WordPress exposes standard database constants.
- The site is reachable from the host browser.

Connection and command failures use actionable reason codes, including:

- `compose_file_missing`
- `wordpress_service_ambiguous`
- `wordpress_service_not_running`
- `base_url_ambiguous`
- `unsupported_wordpress_mount`
- `helper_start_failed`
- `wordpress_not_installed`
- `database_unreachable`
- `site_unreachable`
- `target_fingerprint_mismatch`

If discovery fails, Argus prints the values it found and the exact override flag required. It never modifies the target to make discovery succeed.

## Existing Workflow and Migration

The current `--config argus.config.ts` workflow remains supported for the bundled demo and advanced executable Playwright scenarios.

Named profiles become the recommended existing-site workflow. `--site` and `--config` are mutually exclusive. Commands without either continue using `argus.config.ts` for backward compatibility.

The temporary `argus.melroseuu.config.ts` file and the WP-CLI service added to `wp-melroseuu` are no longer required after reconnecting through named-site mode and can be removed manually.

## Testing

Unit coverage will include:

- XDG config/data path resolution and profile-name validation.
- Profile schema validation, atomic writes, overwrite protection, listing, editing, and disconnect behavior.
- Compose service, port, network, and mount discovery.
- Ambiguous and unsupported discovery results.
- Helper command construction without credential persistence.
- Declarative scenario conversion into browser checks.
- Site/run fingerprint validation.

Integration coverage will use disposable Compose fixtures for:

- Bind-mounted WordPress.
- Named-volume WordPress.
- Automatic URL and service discovery.
- Explicit discovery overrides.
- Inventory and checks without target-file changes.
- Plugin update, visual regression, host-streamed snapshot, and explicit rollback.
- Recreated WordPress containers using a saved profile.

Acceptance for `wp-melroseuu` is:

```bash
argus connect wp-melroseuu \
  --compose ~/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml
argus inventory --site wp-melroseuu
argus check --site wp-melroseuu
```

These commands must work after removing its added WP-CLI service and `/argus` mounts, and without creating a target-specific TypeScript configuration.

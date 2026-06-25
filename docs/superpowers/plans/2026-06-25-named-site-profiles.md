# Argus Named Site Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable user-wide site profiles and zero-touch Docker Compose discovery so Argus can test existing local WordPress sites without modifying their repositories.

**Architecture:** Keep the existing TypeScript-config runtime for the bundled demo. Add a named-site runtime that loads an XDG profile, refreshes the live Compose target through Docker inspection, and implements the existing WordPress/snapshot interfaces with ephemeral helper containers. Both runtimes continue using the same browser runner, orchestrator, report writer, and safety gates.

**Tech Stack:** Node.js 22+, TypeScript ESM, Commander, Zod, Execa, Playwright, Docker Engine/Compose CLI, Vitest.

---

## File Structure

- `src/sites/profile.ts`: profile schema, defaults, validation, and declarative browser conversion.
- `src/sites/paths.ts`: XDG config/data path resolution.
- `src/sites/store.ts`: atomic profile CRUD and overwrite protection.
- `src/sites/discovery.ts`: Compose service, container, URL, network, environment, and mount discovery.
- `src/sites/helper.ts`: ephemeral Docker helper execution with secret-safe command records and streamed binary I/O.
- `src/sites/runtime.ts`: named-site adapter assembly and live fingerprint validation.
- `src/sites/commands.ts`: connect and site-management command handlers.
- `src/wordpress/docker-adapter.ts`: inventory/update operations through the ephemeral helper.
- `src/wordpress/docker-snapshot.ts`: host-streamed database and `wp-content` snapshot/restore.
- Existing `src/config.ts`, `src/wordpress/adapter.ts`, and `src/wordpress/snapshot.ts` remain the advanced config-mode implementation.

### Task 1: Add XDG Paths and Profile Persistence

**Files:**
- Create: `src/sites/paths.ts`
- Create: `src/sites/profile.ts`
- Create: `src/sites/store.ts`
- Create: `tests/site-profile.test.ts`

- [ ] **Step 1: Write failing path, schema, and persistence tests**

Cover:

```ts
expect(resolveSitePaths('melrose', {
  XDG_CONFIG_HOME: '/tmp/config',
  XDG_DATA_HOME: '/tmp/data',
  HOME: '/home/test'
})).toEqual({
  profilePath: '/tmp/config/argus/sites/melrose.json',
  dataRoot: '/tmp/data/argus/sites/melrose'
});

expect(() => siteProfileSchema.parse({ name: '../escape' })).toThrow();
await expect(store.save(profile, false)).rejects.toThrow(/already exists/);
await expect(store.list()).resolves.toEqual(['melrose', 'other']);
```

Also verify fallback paths use `~/.config/argus/sites` and `~/.local/share/argus/sites`, JSON writes are atomic, `disconnect` preserves the data directory, and profile JSON never accepts credential fields.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/site-profile.test.ts
```

Expected: FAIL because `src/sites/*` does not exist.

- [ ] **Step 3: Implement profile schema and stores**

Define:

```ts
export const SITE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const siteProfileSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(SITE_NAME_PATTERN),
  composeFile: z.string().min(1),
  projectDirectory: z.string().min(1),
  projectName: z.string().min(1),
  wordpressService: z.string().min(1),
  baseUrl: z.string().url(),
  helperImage: z.string().default('wordpress:cli'),
  wordpressMount: z.object({
    type: z.enum(['bind', 'volume']),
    source: z.string().min(1),
    destination: z.literal('/var/www/html')
  }),
  networkName: z.string().min(1),
  scenarios: z.array(declarativeScenarioSchema).min(1),
  viewports: z.array(viewportSchema).min(1)
}).strict();
```

Default scenarios are homepage with `#wpadminbar` masked and visible `body`; default viewports are desktop `1440x1000` and mobile `390x844`.

`SiteStore.save(profile, force)` writes `<profile>.tmp`, validates it, then renames it. `list()` returns sorted names. `disconnect()` removes only the profile file.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npm test -- tests/site-profile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sites/paths.ts src/sites/profile.ts src/sites/store.ts tests/site-profile.test.ts
git commit -m "feat: add named site profile storage"
```

### Task 2: Discover a Running Compose WordPress Target

**Files:**
- Create: `src/sites/discovery.ts`
- Create: `tests/site-discovery.test.ts`
- Modify: `src/process.ts`

- [ ] **Step 1: Write failing discovery tests**

Use a fake `ProcessRunnerLike` to provide Compose and inspect JSON. Verify:

- A single running service with WordPress environment and `/var/www/html` is selected.
- Published container port `80` at host port `8090` becomes `http://localhost:8090`.
- `--wordpress-service` and `--url` override discovery.
- Multiple matches produce `wordpress_service_ambiguous`.
- No unique port produces `base_url_ambiguous`.
- Missing/running-state failures use the design’s reason codes.
- Bind and named-volume mounts are accepted; other mount types produce `unsupported_wordpress_mount`.

Use this returned shape:

```ts
type DiscoveredSite = {
  composeFile: string;
  projectDirectory: string;
  projectName: string;
  wordpressService: string;
  containerId: string;
  baseUrl: string;
  networkName: string;
  wordpressMount: {
    type: 'bind' | 'volume';
    source: string;
    destination: '/var/www/html';
  };
  wordpressEnvironment: Record<string, string>;
};
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- tests/site-discovery.test.ts
```

Expected: FAIL because discovery is not implemented.

- [ ] **Step 3: Implement Compose and Docker inspection**

Resolve `--compose` to an absolute path and reject missing files as `compose_file_missing`.

Run:

```text
docker compose -f <file> ps --format json
docker inspect <candidate-container-id>
```

Parse Compose JSON whether emitted as one JSON array or newline-delimited objects. Match services using running state plus WordPress image/environment and `/var/www/html` mount. Read project/service labels from:

```text
com.docker.compose.project
com.docker.compose.service
```

Choose the Compose network attached to both WordPress and its configured database host when possible; otherwise require a single attached Compose network. Copy only `WORDPRESS_DB_HOST`, `WORDPRESS_DB_NAME`, `WORDPRESS_DB_USER`, and `WORDPRESS_DB_PASSWORD` into the in-memory environment map.

- [ ] **Step 4: Run discovery tests and typecheck**

```bash
npm test -- tests/site-discovery.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sites/discovery.ts tests/site-discovery.test.ts src/process.ts
git commit -m "feat: discover local compose wordpress sites"
```

### Task 3: Add Secret-Safe Ephemeral Helper Execution

**Files:**
- Create: `src/sites/helper.ts`
- Create: `tests/site-helper.test.ts`
- Modify: `src/process.ts`

- [ ] **Step 1: Write failing helper tests**

Verify helper commands use:

```text
docker run --rm --network <network> --volumes-from <container-id>
```

and pass WordPress database variables with `-e NAME` while values exist only in the subprocess environment. Assert command records and thrown errors never contain password values.

Add binary execution tests:

```ts
await helper.runUtilityBuffer(['tar', '-czf', '-', '-C', '/var/www/html', 'wp-content']);
await helper.runUtility(['tar', '-xzf', '-', '-C', '/var/www/html'], archive);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- tests/site-helper.test.ts
```

Expected: FAIL because helper execution does not exist.

- [ ] **Step 3: Extend the process boundary for binary output**

Add:

```ts
export type BinaryCommandResult = Omit<CommandRecord, 'stdout' | 'stderr'> & {
  stdout: Buffer;
  stderr: string;
};

runBuffer(command: string, args: string[], options?: RunOptions): Promise<BinaryCommandResult>;
```

Implement `encoding: null` in Execa for `runBuffer`. Keep the existing text `run()` unchanged.

- [ ] **Step 4: Implement `DockerSiteHelper`**

Expose:

```ts
runWp(args: string[]): Promise<CommandRecord>;
runUtility(args: string[], input?: Buffer): Promise<CommandRecord>;
runUtilityBuffer(args: string[]): Promise<BinaryCommandResult>;
```

The WP helper uses the profile’s pinned `wordpress:cli` image. Utility operations use `alpine:3.22`. Every call includes `--rm`, target network, `--volumes-from`, and working directory `/var/www/html`. Redact all environment values before returning command records or errors.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- tests/site-helper.test.ts tests/process.test.ts
npm run typecheck
git add src/sites/helper.ts src/process.ts tests/site-helper.test.ts tests/process.test.ts
git commit -m "feat: run ephemeral site helpers"
```

### Task 4: Validate and Save Connections

**Files:**
- Create: `src/sites/connect.ts`
- Create: `tests/site-connect.test.ts`
- Modify: `src/sites/profile.ts`
- Modify: `src/sites/store.ts`

- [ ] **Step 1: Write failing connection tests**

Test that `connectSite()`:

- Discovers the target.
- Runs `wp core is-installed`.
- Runs `wp db check --skip-ssl`.
- Fetches the base URL and requires a successful response.
- Verifies the site data directory is writable.
- Prints/supplies the discovered values.
- Saves only after every check passes.
- Honors `force`.

Expected API:

```ts
const result = await connectSite({
  name: 'wp-melroseuu',
  composeFile: '/site/docker-compose.yml',
  wordpressService: undefined,
  baseUrl: undefined,
  force: false
}, dependencies);
```

- [ ] **Step 2: Run RED**

```bash
npm test -- tests/site-connect.test.ts
```

- [ ] **Step 3: Implement connection validation**

Use dependency-injected discovery, helper, `fetch`, and store boundaries. Build the v1 profile with default checks only after validation succeeds. Return a printable summary containing profile path, artifact root, Compose project, service, URL, mount, network, and helper image.

Do not persist `containerId` or `wordpressEnvironment`; both are runtime-only values refreshed before each command.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- tests/site-connect.test.ts
npm run typecheck
git add src/sites/connect.ts src/sites/profile.ts src/sites/store.ts tests/site-connect.test.ts
git commit -m "feat: connect and validate named sites"
```

### Task 5: Implement Named-Site WordPress and Snapshot Adapters

**Files:**
- Create: `src/wordpress/docker-adapter.ts`
- Create: `src/wordpress/docker-snapshot.ts`
- Create: `src/sites/fingerprint.ts`
- Create: `tests/docker-wordpress-adapter.test.ts`
- Create: `tests/docker-snapshot.test.ts`
- Create: `tests/site-fingerprint.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write failing adapter and fingerprint tests**

Reuse the inventory normalization expectations from `tests/wordpress-adapter.test.ts`. Verify update calls run only plugin/theme WP commands.

Snapshot tests must assert:

- Database export uses `wp db export - --skip-ssl --allow-root` and writes SQL to the host.
- `wp-content` uses binary `tar -czf -`.
- Restore streams the archive through an Alpine helper and SQL through `mariadb --skip-ssl`.
- No target `/argus` mount is referenced.

Fingerprint tests should hash canonical JSON containing:

```ts
{
  projectName,
  wordpressService,
  wordpressMount,
  databaseHost,
  databaseName
}
```

and reject rollback when the current value differs.

- [ ] **Step 2: Run RED**

```bash
npm test -- \
  tests/docker-wordpress-adapter.test.ts \
  tests/docker-snapshot.test.ts \
  tests/site-fingerprint.test.ts
```

- [ ] **Step 3: Implement adapters**

`DockerWordPressAdapter` implements the same `preflight`, `inventory`, and `update` contract used by `MaintenanceOrchestrator`.

`DockerSnapshotService` writes:

```text
<site-data-root>/runs/<run-id>/snapshot/database.sql
<site-data-root>/runs/<run-id>/snapshot/wp-content.tar.gz
```

using atomic temporary files. Restore reads these host files and streams them to helpers. Validate all snapshot paths through `RunStore.runPath`.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- \
  tests/docker-wordpress-adapter.test.ts \
  tests/docker-snapshot.test.ts \
  tests/site-fingerprint.test.ts
npm run typecheck
git add src/wordpress/docker-adapter.ts src/wordpress/docker-snapshot.ts src/sites/fingerprint.ts src/types.ts tests/docker-wordpress-adapter.test.ts tests/docker-snapshot.test.ts tests/site-fingerprint.test.ts
git commit -m "feat: operate named sites through docker helpers"
```

### Task 6: Add Declarative Browser Checks and Report Site Identity

**Files:**
- Modify: `src/types.ts`
- Modify: `src/browser/runner.ts`
- Modify: `src/report.ts`
- Modify: `src/orchestrator.ts`
- Modify: `tests/browser-runner.test.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/orchestrator.test.ts`

- [ ] **Step 1: Write failing declarative-check and report tests**

Extend scenarios with:

```ts
visibleSelectors?: string[];
```

Verify named profiles execute default checks without a callback:

```ts
await page.locator('body').waitFor({ state: 'visible' });
```

and require every configured selector to be visible before screenshot capture.

Define report schema v2 with:

```ts
site: {
  name: string;
  fingerprint: string;
} | null;
```

The parser must still accept legacy schema-v1 reports. Named-site rollback rejects v1 reports and v2 reports whose site name/fingerprint differs.

- [ ] **Step 2: Run RED**

```bash
npm test -- tests/browser-runner.test.ts tests/report.test.ts tests/orchestrator.test.ts
```

- [ ] **Step 3: Implement browser and report changes**

Add a `siteIdentity` constructor option to the orchestrator. New reports use schema v2. Config mode writes `site: null`; named mode writes the selected profile identity.

Before named rollback mutation, refresh discovery, recompute the fingerprint, and fail with `target_fingerprint_mismatch` when it differs.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- tests/browser-runner.test.ts tests/report.test.ts tests/orchestrator.test.ts
npm run typecheck
git add src/types.ts src/browser/runner.ts src/report.ts src/orchestrator.ts tests/browser-runner.test.ts tests/report.test.ts tests/orchestrator.test.ts
git commit -m "feat: bind reports and checks to named sites"
```

### Task 7: Resolve Config Mode or Named-Site Mode at Runtime

**Files:**
- Create: `src/sites/runtime.ts`
- Create: `tests/site-runtime.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli-support.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1: Write failing runtime-selection tests**

Verify:

- `--site` and explicit `--config` are mutually exclusive.
- No option preserves default `argus.config.ts` behavior.
- `--site wp-melroseuu` loads the profile, refreshes discovery, constructs user-wide `RunStore`/`RunLock`, helper adapters, declarative browser settings, and site identity.
- Recreated container IDs are accepted when the target fingerprint remains stable.

- [ ] **Step 2: Run RED**

```bash
npm test -- tests/site-runtime.test.ts tests/cli.test.ts
```

- [ ] **Step 3: Implement runtime resolution**

Add global CLI option:

```text
--site <name>
```

Track whether `--config` was explicitly supplied so default config mode remains backward compatible. Extract the existing config assembly from `src/cli.ts` into `createConfigRuntime()`. Add `createSiteRuntime()` and return a shared runtime shape:

```ts
{
  config,
  store,
  lock,
  wordpress,
  snapshots,
  browser,
  orchestrator
}
```

Use profile-specific artifact and lock roots under `~/.local/share/argus/sites/<name>`.

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- tests/site-runtime.test.ts tests/cli.test.ts
npm run typecheck
git add src/sites/runtime.ts src/cli.ts src/cli-support.ts tests/site-runtime.test.ts tests/cli.test.ts
git commit -m "feat: run commands against saved sites"
```

### Task 8: Add Connect and Site Management Commands

**Files:**
- Create: `src/sites/commands.ts`
- Create: `tests/site-commands.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/process.ts`

- [ ] **Step 1: Write failing CLI command tests**

Test:

```text
argus connect <name> --compose <file>
argus site list
argus site show <name>
argus site edit <name>
argus site disconnect <name>
```

Verify `connect` supports `--wordpress-service`, `--url`, `--helper-image`, and `--force`. `show` prints validated JSON. `disconnect` removes only profile JSON.

For `edit`, copy the profile to a temporary file, launch `$VISUAL` then `$EDITOR`, validate schema and live connectivity, and atomically replace the profile only on success. Preserve the original profile when editing or validation fails.

- [ ] **Step 2: Run RED**

```bash
npm test -- tests/site-commands.test.ts
```

- [ ] **Step 3: Implement commands**

Use Commander subcommands and dependency-injected handlers. Launch the editor through `/bin/sh -c 'exec "$0" "$1"' <editor> <temp-file>` only after confirming the environment value is non-empty; this preserves editor arguments without interpolating the profile path into shell text.

Print connection results in this stable format:

```text
Connected site: wp-melroseuu
URL: http://localhost:8090
Compose project: wp-melroseuu
WordPress service: wordpress
Profile: /home/user/.config/argus/sites/wp-melroseuu.json
Artifacts: /home/user/.local/share/argus/sites/wp-melroseuu
```

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test -- tests/site-commands.test.ts tests/cli.test.ts
npm run typecheck
git add src/sites/commands.ts src/cli.ts src/process.ts tests/site-commands.test.ts tests/cli.test.ts
git commit -m "feat: manage named site connections"
```

### Task 9: Add Disposable Integration Coverage

**Files:**
- Create: `tests/integration/named-site.test.ts`
- Create: `tests/fixtures/named-site/docker-compose.yml`
- Create: `tests/fixtures/named-site/wordpress/`
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Add an opt-in integration suite**

Gate the suite with:

```ts
const integration = process.env.ARGUS_DOCKER_INTEGRATION === '1' ? describe : describe.skip;
```

Cover bind-mounted and named-volume target variants. Assert the target Compose file hash and Git status do not change.

- [ ] **Step 2: Add the end-to-end scenarios**

The suite must:

1. Start the fixture.
2. Connect using only name and Compose path.
3. Run inventory and check.
4. Update the deterministic regression plugin.
5. Confirm report schema v2, site fingerprint, screenshots, and diffs.
6. Roll back.
7. Confirm the original plugin version.
8. Recreate the WordPress container and confirm the saved profile still works.
9. Disconnect and confirm artifacts remain.

- [ ] **Step 3: Add scripts and run**

Add:

```json
"test:integration": "ARGUS_DOCKER_INTEGRATION=1 vitest run tests/integration"
```

Run:

```bash
npm test
npm run test:integration
```

Expected: unit suite passes; Docker integration suite passes with no target-repository mutation.

- [ ] **Step 4: Commit**

```bash
git add tests/integration tests/fixtures vitest.config.ts package.json package-lock.json
git commit -m "test: cover named site docker workflow"
```

### Task 10: Document Migration and Verify `wp-melroseuu`

**Files:**
- Modify: `README.md`
- Modify: `PROJECT_OVERVIEW.md`
- Delete after verification if still untracked: `argus.melroseuu.config.ts`

- [ ] **Step 1: Replace existing-site setup documentation**

Document the new minimum-fuss workflow:

```bash
npm run argus -- connect wp-melroseuu \
  --compose ~/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml
npm run argus -- inventory --site wp-melroseuu
npm run argus -- check --site wp-melroseuu
```

Keep compatibility requirements and override examples, but remove instructions requiring target Compose edits, `ARGUS_DIR`, `/argus` mounts, or a target-specific config.

- [ ] **Step 2: Restore the manual-test target to its original shape**

In `/home/charlie/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml`, remove only the previously added `/argus` mount and `wpcli` service. Do not alter any pre-existing service setting.

Delete the untracked `argus.melroseuu.config.ts` after named-site verification succeeds.

- [ ] **Step 3: Run acceptance commands**

```bash
npm run argus -- connect wp-melroseuu \
  --compose /home/charlie/Code/DOCKER-WP/wp-melroseuu/docker-compose.yml \
  --force
npm run argus -- inventory --site wp-melroseuu
npm run argus -- check --site wp-melroseuu
```

Expected: all commands succeed with no WP-CLI service or Argus mount in the target.

- [ ] **Step 4: Run complete verification**

```bash
npm run check
docker compose config --quiet
git diff --check
```

Expected: all exit `0`; unit tests report no failures.

- [ ] **Step 5: Commit**

```bash
git add README.md PROJECT_OVERVIEW.md
git commit -m "docs: adopt named site workflow"
```

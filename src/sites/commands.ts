import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCommandPassed, ProcessRunner, type ProcessRunnerLike } from '../process.js';
import { connectSite as defaultConnectSite, type ConnectSiteInput } from './connect.js';
import { siteProfileSchema, type SiteProfile } from './profile.js';
import { SiteStore } from './store.js';

export type ConnectSiteCommandInput = ConnectSiteInput;

export type SiteCommandDependencies = {
  connectSite: typeof defaultConnectSite;
  store: SiteStore;
  process: Pick<ProcessRunnerLike, 'run'>;
  environment: NodeJS.ProcessEnv;
  validateConnectivity(profile: SiteProfile): Promise<SiteProfile | void>;
};

export async function connectSiteCommand(
  input: ConnectSiteCommandInput,
  dependencies: Partial<Pick<SiteCommandDependencies, 'connectSite'>> = {}
): Promise<string> {
  const connectSite = dependencies.connectSite ?? defaultConnectSite;
  const result = await connectSite(input);

  return [
    `Connected site: ${result.profile.name}`,
    `URL: ${result.summary.baseUrl}`,
    `Compose project: ${result.summary.composeProject}`,
    `WordPress service: ${result.summary.wordpressService}`,
    `Profile: ${result.summary.profilePath}`,
    `Artifacts: ${result.summary.artifactRoot}`
  ].join('\n');
}

export async function listSitesCommand(
  dependencies: Partial<Pick<SiteCommandDependencies, 'store'>> = {}
): Promise<string> {
  return (await resolveStore(dependencies).list()).join('\n');
}

export async function showSiteCommand(
  name: string,
  dependencies: Partial<Pick<SiteCommandDependencies, 'store'>> = {}
): Promise<string> {
  return JSON.stringify(await resolveStore(dependencies).load(name), null, 2);
}

export async function disconnectSiteCommand(
  name: string,
  dependencies: Partial<Pick<SiteCommandDependencies, 'store'>> = {}
): Promise<string> {
  await resolveStore(dependencies).disconnect(name);
  return `Disconnected site: ${name}`;
}

export async function editSiteCommand(
  name: string,
  dependencies: Partial<SiteCommandDependencies> = {}
): Promise<string> {
  const store = resolveStore(dependencies);
  const environment = dependencies.environment ?? process.env;
  const editor = selectEditor(environment);
  const processRunner = dependencies.process ?? new ProcessRunner();
  const connectSite = dependencies.connectSite ?? defaultConnectSite;
  const validateConnectivity =
    dependencies.validateConnectivity ??
    ((profile: SiteProfile) => defaultValidateConnectivity(profile, connectSite));
  const paths = store.paths(name);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'argus-site-edit-'));
  const temporaryProfilePath = join(temporaryDirectory, `${name}.json`);

  try {
    await store.load(name);
    await copyFile(paths.profilePath, temporaryProfilePath);
    assertCommandPassed(
      await processRunner.run('/bin/sh', [
        '-c',
        'eval "set -- $ARGUS_EDITOR"; exec "$@" "$ARGUS_PROFILE"'
      ], {
        env: {
          ...environment,
          ARGUS_EDITOR: editor,
          ARGUS_PROFILE: temporaryProfilePath
        }
      }),
      'site_profile_editor'
    );

    const editedProfile = siteProfileSchema.parse(
      JSON.parse(await readFile(temporaryProfilePath, 'utf8'))
    );
    if (editedProfile.name !== name) {
      throw new Error(`Edited profile name must remain ${name}`);
    }

    const validatedProfile = await validateConnectivity(editedProfile);
    if (validatedProfile !== undefined) {
      assertDiscoveredFieldsMatch(editedProfile, validatedProfile);
    }
    await store.save(editedProfile, true);
    return `Updated site: ${name}`;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function resolveStore(
  dependencies: Partial<Pick<SiteCommandDependencies, 'store'>>
): SiteStore {
  return dependencies.store ?? new SiteStore();
}

function selectEditor(environment: NodeJS.ProcessEnv): string {
  const visual = environment.VISUAL?.trim();
  if (visual) {
    return visual;
  }

  const editor = environment.EDITOR?.trim();
  if (editor) {
    return editor;
  }

  throw new Error('Set VISUAL or EDITOR to edit site profiles');
}

async function defaultValidateConnectivity(
  profile: SiteProfile,
  connectSite: SiteCommandDependencies['connectSite']
): Promise<SiteProfile> {
  const temporaryHome = await mkdtemp(join(tmpdir(), 'argus-site-validation-'));
  try {
    const result = await connectSite(
      {
        name: profile.name,
        composeFile: profile.composeFile,
        wordpressService: profile.wordpressService,
        baseUrl: profile.baseUrl,
        helperImage: profile.helperImage,
        force: true
      },
      { store: new SiteStore({ HOME: temporaryHome }) }
    );
    return result.profile;
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

function assertDiscoveredFieldsMatch(editedProfile: SiteProfile, validatedProfile: SiteProfile): void {
  if (editedProfile.networkName !== validatedProfile.networkName) {
    throw new Error(
      `Edited profile networkName ${editedProfile.networkName} does not match discovered networkName ${validatedProfile.networkName}`
    );
  }

  if (JSON.stringify(editedProfile.wordpressMount) !== JSON.stringify(validatedProfile.wordpressMount)) {
    throw new Error('Edited profile wordpressMount does not match the discovered WordPress mount');
  }
}

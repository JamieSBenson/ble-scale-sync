import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the Home Assistant add-on changelog from the project changelog.
 *
 * The add-on file used to be maintained by hand and drifted 16 releases behind
 * (#294): Home Assistant renders it verbatim in the add-on page, so users saw
 * release notes that stopped at 1.10.2 while running 1.21.1. The add-on version
 * always equals the application version, so every entry in the root changelog
 * applies to the add-on and a generated copy is the honest representation.
 *
 * Run `npm run sync:addon-changelog` after the root changelog changes.
 * `npm run sync:addon-changelog:check` (and a vitest guard) fails when the copy
 * is stale, so it cannot silently fall behind again.
 */
export const ADDON_CHANGELOG_HEADER = `# Changelog

<!-- GENERATED FILE. Do not edit by hand. Produced from the root CHANGELOG.md by
     src/tools/sync-addon-changelog.ts. Run \`npm run sync:addon-changelog\` after
     the root changelog changes. -->

The add-on version always matches the application version, so every entry below
applies to this add-on.
`;

export const ROOT_CHANGELOG_PATH = 'CHANGELOG.md';
export const ADDON_CHANGELOG_PATH = path.join('ble-scale-sync-addon', 'CHANGELOG.md');

/** Strip the Keep a Changelog preamble and keep every release section verbatim. */
export function buildAddonChangelog(rootChangelog: string): string {
  const match = /^## \[/m.exec(rootChangelog);
  if (!match) {
    throw new Error('Root CHANGELOG.md has no "## [x.y.z]" release heading');
  }
  const body = rootChangelog.slice(match.index).replace(/\r\n/g, '\n').trimEnd();
  return `${ADDON_CHANGELOG_HEADER}\n${body}\n`;
}

function main(argv: string[]): void {
  const root = readFileSync(path.resolve(process.cwd(), ROOT_CHANGELOG_PATH), 'utf8');
  const generated = buildAddonChangelog(root);
  const addonPath = path.resolve(process.cwd(), ADDON_CHANGELOG_PATH);

  if (argv.includes('check')) {
    const current = readFileSync(addonPath, 'utf8').replace(/\r\n/g, '\n');
    if (current !== generated) {
      console.error(`${ADDON_CHANGELOG_PATH} is stale. Run: npm run sync:addon-changelog`);
      process.exitCode = 1;
      return;
    }
    console.log(`${ADDON_CHANGELOG_PATH} is up to date`);
    return;
  }

  writeFileSync(addonPath, generated, 'utf8');
  console.log(`Wrote ${ADDON_CHANGELOG_PATH}`);
}

// Only run as a CLI, so importing this module in tests has no side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ADDON_CHANGELOG_PATH,
  ROOT_CHANGELOG_PATH,
  buildAddonChangelog,
} from '../src/tools/sync-addon-changelog.js';

/**
 * Guard for #294. The add-on changelog is what Home Assistant shows on the
 * add-on page, and while it was maintained by hand it fell 16 releases behind
 * without anything failing. It is now generated, and this test is what keeps it
 * that way: a release that updates CHANGELOG.md without regenerating the copy
 * fails CI instead of shipping stale notes.
 *
 * Line endings are normalized on both sides: Windows checkouts have core.autocrlf
 * on, so the working-tree files are CRLF while the generator emits LF.
 */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

const root = lf(readFileSync(ROOT_CHANGELOG_PATH, 'utf8'));
const addon = lf(readFileSync(ADDON_CHANGELOG_PATH, 'utf8'));

describe('add-on changelog sync (#294)', () => {
  it('is the generated copy of the root changelog', () => {
    expect(addon, `${ADDON_CHANGELOG_PATH} is stale. Run: npm run sync:addon-changelog`).toBe(
      buildAddonChangelog(root),
    );
  });

  it('documents the version the add-on config reports', () => {
    const config = lf(readFileSync('ble-scale-sync-addon/config.yaml', 'utf8'));
    const version = /^version:\s*["']?([\d.]+)["']?\s*$/m.exec(config)?.[1];
    expect(version, 'no version in ble-scale-sync-addon/config.yaml').toBeDefined();
    const escaped = version!.replace(/\./g, '\\.');
    expect(addon).toMatch(new RegExp(`^## \\[${escaped}\\]`, 'm'));
  });

  it('keeps every release heading', () => {
    const rootHeadings = root.match(/^## \[/gm)?.length ?? 0;
    const generated = buildAddonChangelog(root).match(/^## \[/gm)?.length ?? 0;
    expect(rootHeadings).toBeGreaterThan(0);
    expect(generated).toBe(rootHeadings);
  });

  it('drops the Keep a Changelog preamble', () => {
    const generated = buildAddonChangelog(root);
    expect(generated.startsWith('# Changelog')).toBe(true);
    expect(generated).not.toContain('All notable changes to this project');
    expect(generated).not.toContain('keepachangelog.com');
  });

  it('throws when the root changelog has no release heading', () => {
    expect(() => buildAddonChangelog('# Changelog\n\nnothing here\n')).toThrow(/release heading/);
  });
});

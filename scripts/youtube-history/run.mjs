/**
 * Entry: scrape YouTube history, then update README section and youtube-watch-history.md.
 * Requires YOUTUBE_COOKIES env (JSON array of cookie objects) for authenticated scrape.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(__dirname);
const REPO_ROOT = resolve(__dirname, '../..');
const HISTORY_JSON = resolve(REPO_ROOT, '.youtube-history.json');

const scraper = resolve(SCRIPTS_DIR, 'scraper.mjs');
const updateDocs = resolve(SCRIPTS_DIR, 'update-docs.mjs');

const out = spawnSync(process.execPath, [scraper], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: { ...process.env, YOUTUBE_COOKIES: process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_SESSION_COOKIES || '[]' },
});

if (out.status !== 0) {
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.status ?? 1);
}

const json = out.stdout;
if (!json || !json.trim()) {
  process.stderr.write('Scraper produced no output.\n');
  process.exit(1);
}

writeFileSync(HISTORY_JSON, json, 'utf8');
try {
  const upd = spawnSync(process.execPath, [updateDocs, HISTORY_JSON], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (upd.status !== 0) {
    if (upd.stderr) process.stderr.write(upd.stderr);
    process.exit(upd.status ?? 1);
  }
} finally {
  if (existsSync(HISTORY_JSON)) unlinkSync(HISTORY_JSON);
}

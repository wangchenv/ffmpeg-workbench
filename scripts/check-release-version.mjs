import { appendFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const lock = JSON.parse(read('package-lock.json'));
assert.equal(lock.version, version, 'npm lock version differs');
assert.equal(lock.packages[''].version, version, 'npm root package version differs');
assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, version, 'Tauri version differs');
assert.equal(read('src-tauri/Cargo.toml').match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)[1], version, 'Cargo version differs');
assert.equal(read('src-tauri/Cargo.lock').match(/name = "ffmpeg-workbench"\nversion = "([^"]+)"/)[1], version, 'Cargo lock version differs');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, 'v' + version, 'Tag and application version differ');
  assert.ok(read(`docs/releases/v${version}.md`).trim(), 'Release notes are required');
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`Release version: ${version}`);

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
const cargo = join(root, '.tools', 'cargo');
const rustup = join(root, '.tools', 'rustup');
if (existsSync(join(cargo, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  env.CARGO_HOME = cargo;
  env.RUSTUP_HOME = rustup;
  env.PATH = join(cargo, 'bin') + delimiter + (env.PATH || '');
}
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

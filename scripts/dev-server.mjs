import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let reuse = false;
try {
  const response = await fetch('http://127.0.0.1:1420/', { signal: AbortSignal.timeout(1500) });
  reuse = response.ok && (await response.text()).includes('<title>FFmpeg Workbench</title>');
} catch { /* Start Vite when no matching development server exists. */ }
if (reuse) console.log('Using the existing FFmpeg Workbench development server on 127.0.0.1:1420.');
else {
  const child = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '1420'], { cwd: root, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
}

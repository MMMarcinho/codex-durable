import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const timestamp = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const json = (value) => JSON.stringify(value);

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function command(argv, options = {}) {
  invariant(Array.isArray(argv) && argv.length > 0, 'command requires argv');
  const { cwd, input, timeoutMs = 0, maxOutputBytes = 256 * 1024, signal } = options;
  const child = spawn(argv[0], argv.slice(1), {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    signal, env: options.env ?? process.env,
  });
  if (input === undefined) child.stdin.end();
  else child.stdin.end(input);
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let truncated = false;
  const capture = (target) => (chunk) => {
    const remaining = Math.max(0, maxOutputBytes - outputBytes);
    const part = chunk.subarray(0, remaining).toString('utf8');
    if (target === 'stdout') stdout += part;
    else stderr += part;
    outputBytes += Buffer.byteLength(part);
    if (chunk.length > remaining) truncated = true;
  };
  child.stdout.on('data', capture('stdout'));
  child.stderr.on('data', capture('stderr'));
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    killProcess(child);
  }, timeoutMs) : undefined;
  try {
    const { code, exitSignal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, exitSignal) => resolve({ code, exitSignal }));
    });
    return { code, signal: exitSignal, stdout, stderr, truncated, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function killProcess(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export async function atomicWrite(path, data) {
  const temporary = join(dirname(path), `.${id('write')}.tmp`);
  try {
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

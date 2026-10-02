import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { command, id, invariant, json, sha256 } from './util.js';

function validateSpec(spec) {
  invariant(spec && typeof spec === 'object' && !Array.isArray(spec), 'scene spec must be an object');
  invariant(typeof spec.prompt === 'string' && spec.prompt.trim(), 'scene prompt is required');
  invariant(typeof spec.model === 'string' && spec.model.trim(), 'scene model is required');
  invariant(spec.codexVersion === undefined ||
    (typeof spec.codexVersion === 'string' && spec.codexVersion.trim()),
  'codexVersion must be a nonempty string');
  const checks = spec.checks ?? [];
  invariant(Array.isArray(checks), 'checks must be an array');
  for (const check of checks) {
    invariant(typeof check.name === 'string' && check.name.trim(), 'check name is required');
    invariant(Array.isArray(check.argv) && check.argv.length > 0 &&
      check.argv.every((arg) => typeof arg === 'string' && arg.length > 0),
    `check ${check.name} needs argv strings`);
    invariant(check.timeoutMs === undefined || (Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0),
      `invalid timeout for check ${check.name}`);
  }
  const timeoutMs = spec.timeoutMs ?? 20 * 60 * 1000;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeoutMs must be positive');
  return { version: 1, prompt: spec.prompt, model: spec.model,
    codexVersion: spec.codexVersion ?? null, timeoutMs,
    checks: checks.map((check) => ({ name: check.name, argv: check.argv,
      timeoutMs: check.timeoutMs ?? 2 * 60 * 1000 })) };
}

async function git(repo, ...args) {
  const result = await command(['git', '-C', repo, ...args]);
  invariant(result.code === 0, `git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function archive(repo, commit, path) {
  const child = spawn('git', ['-C', repo, 'archive', '--format=tar', commit],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk.slice(0, 8192); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`git archive failed: ${stderr}`)));
  });
  await Promise.all([pipeline(child.stdout, createWriteStream(path, { flags: 'wx' })), exited]);
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return fileHash(path);
}

export async function createScene(store, repoPath, inputSpec, requestId, revision) {
  const spec = validateSpec(inputSpec);
  const repo = await git(resolve(repoPath), 'rev-parse', '--show-toplevel');
  if (!revision) {
    const status = await git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
    invariant(!status, 'source repository must be clean; commit or move uncommitted files first');
  }
  const commit = await git(repo, 'rev-parse', `${revision ?? 'HEAD'}^{commit}`);
  const tree = await git(repo, 'rev-parse', `${commit}^{tree}`);
  const sceneId = id('scn');
  const directory = join(store.root, 'assets', 'scenes', sceneId);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, 'base.tar.tmp');
  try {
    const archiveSha256 = await archive(repo, commit, temporary);
    const manifest = { ...spec, source: { repo, commit, tree, name: basename(repo) }, archiveSha256 };
    const digest = sha256(json(manifest));
    const prior = requestId && store.sceneByRequestId(requestId);
    if (prior) {
      invariant(prior.digest === digest, `scene requestId ${requestId} already has different content`);
      await rm(directory, { recursive: true, force: true });
      return prior;
    }
    await rename(temporary, join(directory, 'base.tar'));
    const dirHandle = await open(directory, 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    return store.addScene({ id: sceneId, requestId, digest, manifest });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreScene(store, scene, workspace) {
  invariant(scene, 'scene is required');
  const archivePath = join(store.root, 'assets', 'scenes', scene.id, 'base.tar');
  invariant((await fileHash(archivePath)) === scene.manifest.archiveSha256,
    `scene archive checksum mismatch: ${scene.id}`);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const extracted = await command(['tar', '-xf', archivePath, '-C', workspace]);
  invariant(extracted.code === 0, `could not extract scene: ${extracted.stderr}`);
  await git(workspace, 'init', '-q');
  await git(workspace, 'add', '-A');
  await git(workspace, '-c', 'user.name=Codex Durable', '-c', 'user.email=codex-durable@local',
    'commit', '-q', '-m', 'Scene baseline');
}

export async function readSceneSpec(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

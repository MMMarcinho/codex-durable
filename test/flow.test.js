import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexDurable, createScene, importCodexTrace, Store } from '../src/index.js';

const fake = fileURLToPath(new URL('./fake-codex.js', import.meta.url));
const runGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function fixture(t, prompt = 'Fix this bug') {
  const root = await mkdtemp(join(tmpdir(), 'codex-durable-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  runGit(repo, 'init', '-q');
  await writeFile(join(repo, 'README.md'), 'A reproducible coding task.\n');
  runGit(repo, 'add', '-A');
  runGit(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'baseline');
  const store = new Store(join(root, 'store'));
  t.after(() => store.close());
  const spec = { prompt, model: 'fake-model', checks: [{ name: 'solution exists',
    argv: [process.execPath, '-e', 'if(!require("fs").existsSync("solution.txt")) process.exit(1)'] }] };
  return { root, repo, store, spec };
}

test('freezes a clean repo, runs Codex once, and retains independent evidence', async (t) => {
  const { repo, store, spec } = await fixture(t);
  const scene = await createScene(store, repo, spec, 'case-1');
  assert.equal((await createScene(store, repo, spec, 'case-1')).id, scene.id);
  const durable = new CodexDurable(store, { codexCommand: [process.execPath, fake] });
  const admitted = durable.submit(scene.id, { requestId: 'run-1' });
  assert.equal(durable.submit(scene.id, { requestId: 'run-1' }).id, admitted.id);
  const result = await durable.run(admitted.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.passed, true);
  assert.equal(result.result.execution.threadId, 'fake-thread');
  assert.equal(eventsVersion(store, result.id), 'fake-codex 1.0');
  assert.match(await readFile(result.result.patch.path, 'utf8'), /solution\.txt/);
  assert.match(await readFile(join(store.root, 'runs', result.id, 'events.jsonl'), 'utf8'), /thread.started/);
  assert.equal(runGit(repo, 'status', '--porcelain'), '');
  const events = store.events(result.id);
  assert.ok(events.some((event) => event.type === 'grader.result'));
  assert.deepEqual(events.map((event) => event.seq), [...events.map((event) => event.seq)].sort((a, b) => a - b));
  await rm(join(store.root, 'runs', result.id, 'report.json'));
  await rm(join(store.root, 'runs', result.id, 'events.jsonl'));
  await durable.resume();
  assert.match(await readFile(join(store.root, 'runs', result.id, 'report.json'), 'utf8'), /"completed"/);
  assert.match(await readFile(join(store.root, 'runs', result.id, 'events.jsonl'), 'utf8'), /thread.started/);
  assert.throws(() => durable.submit(scene.id, { requestId: 'run-1', extra: true }), /different input/);
});

function eventsVersion(store, attemptId) {
  return store.events(attemptId).find((event) => event.type === 'attempt.running')?.data.codexVersion;
}

test('recover replays preparation but never re-executes an uncertain Codex effect', async (t) => {
  const { repo, store, spec } = await fixture(t);
  const scene = await createScene(store, repo, spec);
  const durable = new CodexDurable(store, { codexCommand: [process.execPath, fake] });
  const safe = durable.submit(scene.id);
  store.transition(safe.id, ['queued'], 'preparing', 'restore_scene');
  const unsafe = durable.submit(scene.id);
  store.transition(unsafe.id, ['queued'], 'preparing', 'restore_scene');
  store.transition(unsafe.id, ['preparing'], 'running', 'codex_spawn_intent');
  const resumed = await durable.resume();
  assert.equal(resumed.results.length, 1);
  assert.equal(store.attempt(safe.id).status, 'completed');
  assert.equal(store.attempt(unsafe.id).status, 'interrupted');
  assert.equal(store.events(unsafe.id).filter((event) => event.type === 'codex.event').length, 0);
});

test('rejects an uncommitted source and does not create a scene', async (t) => {
  const { repo, store, spec } = await fixture(t);
  await writeFile(join(repo, 'untracked.txt'), 'not frozen');
  await assert.rejects(createScene(store, repo, spec), /must be clean/);
  assert.equal(store.scenes().length, 0);
});

test('timeout preserves the partial patch and classifies execution as interrupted', async (t) => {
  const { repo, store, spec } = await fixture(t, 'FAKE:delay');
  const scene = await createScene(store, repo, { ...spec, timeoutMs: 300 });
  const durable = new CodexDurable(store, { codexCommand: [process.execPath, fake] });
  const result = await durable.run(durable.submit(scene.id).id);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.result.reason, 'timeout');
  assert.match(await readFile(result.result.patch.path, 'utf8'), /solution\.txt/);
  assert.equal(result.result.passed, undefined);
});

test('imports a historical Codex trace while freezing its original commit', async (t) => {
  const { root, repo, store, spec } = await fixture(t);
  const original = runGit(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'Later changes that must not enter the Scene.\n');
  const scene = await createScene(store, repo, spec, undefined, original);
  const tracePath = join(root, 'source.jsonl');
  await writeFile(tracePath, [
    JSON.stringify({ type: 'thread.started', thread_id: 'real-thread' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reference solution' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n') + '\n');
  const source = await importCodexTrace(store, scene.id, tracePath, 'source-1');
  assert.equal(source.metadata.threadId, 'real-thread');
  assert.equal(source.metadata.completed, true);
  assert.equal((await importCodexTrace(store, scene.id, tracePath, 'source-1')).id, source.id);
  const durable = new CodexDurable(store, { codexCommand: [process.execPath, fake] });
  const result = await durable.run(durable.submit(scene.id).id);
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(join(result.workspace, 'README.md'), 'utf8'), 'A reproducible coding task.\n');
  await assert.rejects(readFile(join(result.workspace, 'source.jsonl')));
});

test('a second runner cannot recover an active store', async (t) => {
  const { root, store } = await fixture(t);
  const other = new Store(join(root, 'store'));
  t.after(() => other.close());
  store.acquireRunnerLease();
  assert.throws(() => other.acquireRunnerLease(), /runner already active/);
  store.releaseRunnerLease();
  other.acquireRunnerLease();
  other.releaseRunnerLease();
});

test('a Codex failure is not graded as a failed solution', async (t) => {
  const { repo, store, spec } = await fixture(t, 'FAKE:fail');
  const scene = await createScene(store, repo, spec);
  const durable = new CodexDurable(store, { codexCommand: [process.execPath, fake] });
  const result = await durable.run(durable.submit(scene.id).id);
  assert.equal(result.status, 'failed');
  assert.equal(result.result.reason, 'codex_exit_nonzero');
  assert.equal(result.result.passed, undefined);
  assert.equal(store.events(result.id).filter((event) => event.type === 'grader.result').length, 0);
});

test('pinned Codex CLI version is checked before executing the candidate', async (t) => {
  const { repo, store, spec } = await fixture(t);
  const scene = await createScene(store, repo, { ...spec, codexVersion: 'different-cli' });
  const durable = new CodexDurable(store, { codexCommand: [process.execPath, fake] });
  const result = await durable.run(durable.submit(scene.id).id);
  assert.equal(result.status, 'failed');
  assert.match(result.result.message, /version mismatch/);
  assert.equal(store.events(result.id).filter((event) => event.type === 'codex.event').length, 0);
});

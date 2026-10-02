import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { atomicWrite, command, invariant, json, killProcess, sha256 } from './util.js';
import { restoreScene } from './scene.js';

const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;

async function patchEvidence(workspace, artifactDir) {
  const prepared = await command(['git', 'add', '-N', '.'], { cwd: workspace });
  invariant(prepared.code === 0, `git add -N failed: ${prepared.stderr}`);
  const diff = await command(['git', 'diff', '--binary', 'HEAD'],
    { cwd: workspace, maxOutputBytes: 32 * 1024 * 1024 });
  invariant(diff.code === 0 && !diff.truncated, 'candidate patch could not be captured completely');
  const patchPath = join(artifactDir, 'candidate.patch');
  await atomicWrite(patchPath, diff.stdout);
  return { path: patchPath, sha256: sha256(diff.stdout), bytes: Buffer.byteLength(diff.stdout) };
}

async function runCheck(check, workspace) {
  try {
    const result = await command(check.argv, { cwd: workspace,
      timeoutMs: check.timeoutMs, maxOutputBytes: 256 * 1024 });
    return { name: check.name, argv: check.argv, exitCode: result.code,
      timedOut: result.timedOut, passed: result.code === 0 && !result.timedOut,
      stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
  } catch (error) {
    return { name: check.name, argv: check.argv, passed: false, error: String(error) };
  }
}

export class CodexDurable {
  constructor(store, options = {}) {
    this.store = store;
    this.codexCommand = options.codexCommand ?? ['codex'];
    invariant(Array.isArray(this.codexCommand) && this.codexCommand.length > 0,
      'codexCommand must be a nonempty argv array');
    this.active = new Map();
    this.stopping = false;
  }

  submit(sceneId, { requestId, ...config } = {}) {
    return this.store.submit(sceneId, config, requestId);
  }

  async resume() {
    this.store.acquireRunnerLease();
    try {
      const recovered = this.store.recover();
      const pending = this.store.attempts().filter((attempt) => attempt.status === 'queued');
      const results = [];
      for (const attempt of pending) {
        if (this.stopping) break;
        results.push(await this.#run(attempt.id));
      }
      for (const attempt of this.store.attempts()) {
        if (TERMINAL.has(attempt.status)) await this.#materialize(attempt.id);
      }
      return { recovered, results };
    } finally {
      this.store.releaseRunnerLease();
    }
  }

  async run(id) {
    this.store.acquireRunnerLease();
    try { return await this.#run(id); }
    finally { this.store.releaseRunnerLease(); }
  }

  async #run(id) {
    invariant(!this.stopping, 'runner is stopping');
    const attempt = this.store.attempt(id);
    invariant(attempt, `unknown attempt ${id}`);
    invariant(attempt.status === 'queued', `attempt ${id} is ${attempt.status}, expected queued`);
    const scene = this.store.scene(attempt.sceneId);
    const artifactDir = join(this.store.root, 'runs', id);
    const workspace = join(artifactDir, 'workspace');
    const controller = new AbortController();
    this.active.set(id, controller);
    this.store.transition(id, ['queued'], 'preparing', 'restore_scene', {}, { workspace });
    try {
      await mkdir(artifactDir, { recursive: true });
      await restoreScene(this.store, scene, workspace);
      controller.signal.throwIfAborted();
      const versionCheck = await command([...this.codexCommand, '--version'],
        { cwd: workspace, timeoutMs: 10_000 });
      invariant(versionCheck.code === 0, `Codex version check failed: ${versionCheck.stderr}`);
      const codexVersion = versionCheck.stdout.trim();
      if (scene.manifest.codexVersion) {
        invariant(codexVersion === scene.manifest.codexVersion,
          `Codex version mismatch: expected ${scene.manifest.codexVersion}, found ${codexVersion}`);
      }
      const finalPath = join(artifactDir, 'final.md');
      const args = [
        ...this.codexCommand.slice(1), '-a', 'never', 'exec', '--cd', workspace,
        '--sandbox', 'workspace-write', '--json', '--ephemeral', '--ignore-user-config',
        '--model', scene.manifest.model, '--output-last-message', finalPath, '-',
      ];
      const launch = { argv: [this.codexCommand[0], ...args], cwd: workspace,
        model: scene.manifest.model, codexVersion, timeoutMs: scene.manifest.timeoutMs };
      this.store.transition(id, ['preparing'], 'running', 'codex_spawn_intent', launch);
      const execution = await this.#executeCodex(id, launch.argv, workspace,
        scene.manifest.prompt, finalPath, scene.manifest.timeoutMs, controller.signal);
      const patch = await patchEvidence(workspace, artifactDir);
      const final = await readFile(finalPath, 'utf8').catch(() => execution.lastMessage ?? '');
      await atomicWrite(finalPath, final);
      const base = { execution: { exitCode: execution.exitCode, signal: execution.signal,
        timedOut: execution.timedOut, stderr: execution.stderr,
        stderrTruncated: execution.stderrTruncated, threadId: execution.threadId },
      patch, finalPath, final };
      await atomicWrite(join(artifactDir, 'stderr.log'), execution.stderr);
      if (execution.timedOut || execution.aborted) {
        const result = { ...base, reason: execution.timedOut ? 'timeout' : 'cancelled' };
        await this.#finish(id, 'interrupted', 'codex_interrupted', result, artifactDir);
        return this.store.attempt(id);
      }
      if (execution.exitCode !== 0) {
        const result = { ...base, reason: 'codex_exit_nonzero' };
        await this.#finish(id, 'failed', 'codex_failed', result, artifactDir);
        return this.store.attempt(id);
      }
      this.store.transition(id, ['running'], 'grading', 'checks');
      const checks = [];
      for (const check of scene.manifest.checks) {
        const result = await runCheck(check, workspace);
        checks.push(result);
        this.store.event(id, 'grader.result', result);
      }
      const result = { ...base, checks, passed: checks.every((check) => check.passed) };
      await this.#finish(id, 'completed', 'done', result, artifactDir);
      return this.store.attempt(id);
    } catch (error) {
      const current = this.store.attempt(id);
      if (!TERMINAL.has(current.status)) {
        const result = { reason: 'runner_error', message: String(error), workspace };
        await this.#finish(id, controller.signal.aborted ? 'interrupted' : 'failed',
          'runner_error', result, artifactDir);
      }
      return this.store.attempt(id);
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id) {
    const controller = this.active.get(id);
    if (controller) controller.abort();
    return Boolean(controller);
  }

  cancelAll() {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
  }

  async #finish(id, status, phase, result, artifactDir) {
    this.store.transition(id, ['preparing', 'running', 'grading'], status, phase,
      { passed: result.passed ?? null, reason: result.reason ?? null }, { result, pid: null });
    await this.#materialize(id, artifactDir);
  }

  async #materialize(id, artifactDir = join(this.store.root, 'runs', id)) {
    await mkdir(artifactDir, { recursive: true });
    await this.#exportEvents(id, artifactDir);
    await atomicWrite(join(artifactDir, 'report.json'), `${json(this.store.attempt(id))}\n`);
  }

  async #exportEvents(id, artifactDir) {
    let after = 0;
    const rows = [];
    while (true) {
      const page = this.store.events(id, after, 1000);
      if (page.length === 0) break;
      for (const event of page) rows.push(json(event));
      after = page.at(-1).seq;
    }
    await atomicWrite(join(artifactDir, 'events.jsonl'), `${rows.join('\n')}\n`);
  }

  async #executeCodex(id, argv, cwd, prompt, finalPath, timeoutMs, signal) {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, exitSignal) => resolve({ code, exitSignal }));
    });
    child.stdin.on('error', () => {});
    try {
      this.store.transition(id, ['running'], 'running', 'codex_spawned', { pid: child.pid ?? null }, { pid: child.pid ?? null });
    } catch (error) {
      killProcess(child);
      throw error;
    }
    child.stdin.end(prompt);
    let threadId = null;
    let lastMessage = null;
    const stdout = (async () => {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
          this.store.event(id, 'codex.event_oversize',
            { bytes: Buffer.byteLength(line), sha256: sha256(line) });
          continue;
        }
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started') threadId = event.thread_id ?? null;
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            lastMessage = event.item.text ?? null;
          }
          this.store.event(id, 'codex.event', event);
        } catch {
          this.store.event(id, 'codex.unparsed', { line });
        }
      }
    })();
    let stderr = '';
    let stderrTruncated = false;
    const errors = (async () => {
      for await (const chunk of child.stderr) {
        const available = Math.max(0, MAX_STDERR_BYTES - Buffer.byteLength(stderr));
        stderr += chunk.subarray(0, available).toString('utf8');
        if (chunk.length > available) stderrTruncated = true;
      }
    })();
    let timedOut = false;
    let aborted = false;
    const onAbort = () => { aborted = true; killProcess(child); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; killProcess(child); }, timeoutMs);
    try {
      const [status] = await Promise.all([exited, stdout, errors]);
      return { exitCode: status.code, signal: status.exitSignal, timedOut, aborted,
        threadId, lastMessage, stderr, stderrTruncated, finalPath };
    } catch (error) {
      killProcess(child);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

#!/usr/bin/env node
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createScene, readSceneSpec } from './scene.js';
import { CodexDurable } from './runner.js';
import { Store } from './store.js';
import { importCodexTrace } from './source.js';

function usage() {
  return `codex-durable [--store DIR] COMMAND

  scene create --repo DIR --spec FILE [--rev COMMIT] [--request-id ID]
  scene list | scene show ID
  source import SCENE_ID --events FILE [--request-id ID]
  source list [SCENE_ID] | source show SOURCE_ID
  attempt submit SCENE_ID [--request-id ID]
  attempt run ID | attempt retry ID [--request-id ID] | attempt resume
  attempt list | attempt show ID | attempt events ID [--after SEQ]
  attempt watch ID [--after SEQ]

The store defaults to ./.codex-durable. Output is JSON/JSONL.`;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function watch(store, attemptId, after) {
  if (!store.attempt(attemptId)) throw new Error(`unknown attempt ${attemptId}`);
  let cursor = after;
  for (;;) {
    const page = store.events(attemptId, cursor);
    for (const event of page) {
      print(event);
      cursor = event.seq;
    }
    const status = store.attempt(attemptId).status;
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(status) && page.length < 1000) break;
    await delay(300);
  }
}

async function main(raw) {
  const args = [...raw];
  const storeRoot = resolve(option(args, '--store', '.codex-durable'));
  const [kind, action, target] = args;
  if (!kind || kind === 'help' || kind === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const store = new Store(storeRoot);
  const durable = new CodexDurable(store);
  const stop = () => durable.cancelAll();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    if (kind === 'scene' && action === 'create') {
      const repo = option(args, '--repo');
      const specPath = option(args, '--spec');
      const requestId = option(args, '--request-id');
      const revision = option(args, '--rev');
      if (!repo || !specPath) throw new Error('scene create needs --repo and --spec');
      print(await createScene(store, repo, await readSceneSpec(specPath), requestId, revision));
    } else if (kind === 'scene' && action === 'list') print(store.scenes());
    else if (kind === 'scene' && action === 'show') print(store.scene(target));
    else if (kind === 'source' && action === 'import') {
      const events = option(args, '--events');
      const requestId = option(args, '--request-id');
      if (!events) throw new Error('source import needs --events FILE');
      print(await importCodexTrace(store, target, events, requestId));
    } else if (kind === 'source' && action === 'list') print(store.sources(target));
    else if (kind === 'source' && action === 'show') print(store.source(target));
    else if (kind === 'attempt' && action === 'submit') {
      const requestId = option(args, '--request-id');
      print(durable.submit(target, { requestId }));
    } else if (kind === 'attempt' && action === 'run') print(await durable.run(target));
    else if (kind === 'attempt' && action === 'retry') {
      const requestId = option(args, '--request-id');
      const previous = store.attempt(target);
      if (!previous) throw new Error(`unknown attempt ${target}`);
      const next = durable.submit(previous.sceneId, { requestId });
      print(next.status === 'queued' ? await durable.run(next.id) : next);
    } else if (kind === 'attempt' && action === 'resume') print(await durable.resume());
    else if (kind === 'attempt' && action === 'list') print(store.attempts());
    else if (kind === 'attempt' && action === 'show') print(store.attempt(target));
    else if (kind === 'attempt' && action === 'events') {
      let after = Number(option(args, '--after', '0'));
      do {
        const page = store.events(target, after);
        for (const event of page) { print(event); after = event.seq; }
        if (page.length < 1000) break;
      } while (true);
    } else if (kind === 'attempt' && action === 'watch') {
      await watch(store, target, Number(option(args, '--after', '0')));
    } else throw new Error(usage());
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    store.close();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

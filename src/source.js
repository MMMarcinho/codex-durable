import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { id, invariant } from './util.js';

async function inspect(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  let eventCount = 0;
  let threadId = null;
  let completed = false;
  const types = new Set();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`invalid JSONL at line ${eventCount + 1}`); }
    invariant(event && typeof event.type === 'string', `invalid Codex event at line ${eventCount + 1}`);
    eventCount += 1;
    types.add(event.type);
    if (event.type === 'thread.started') threadId = event.thread_id ?? threadId;
    if (event.type === 'turn.completed') completed = true;
  }
  invariant(eventCount > 0, 'source trace is empty');
  invariant(types.has('thread.started'), 'source trace has no thread.started event');
  return { digest: hash.digest('hex'), metadata: { eventCount, threadId, completed,
    eventTypes: [...types].sort() } };
}

export async function importCodexTrace(store, sceneId, path, requestId) {
  invariant(store.scene(sceneId), `unknown scene ${sceneId}`);
  const { digest, metadata } = await inspect(path);
  const prior = requestId && store.sourceByRequestId(requestId);
  if (prior) {
    invariant(prior.sceneId === sceneId && prior.digest === digest,
      `source requestId ${requestId} already has different input`);
    return prior;
  }
  const sourceId = id('src');
  const directory = join(store.root, 'assets', 'sources', sourceId);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, 'events.jsonl.tmp');
  try {
    await copyFile(path, temporary);
    invariant((await inspect(temporary)).digest === digest, 'source trace changed while importing');
    const file = await open(temporary, 'r');
    try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(directory, 'events.jsonl'));
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
    return store.addSource({ id: sourceId, sceneId, requestId, digest, metadata });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

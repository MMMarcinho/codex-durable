import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { id, invariant, json, timestamp } from './util.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY, request_id TEXT UNIQUE, digest TEXT NOT NULL,
    manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id),
    request_id TEXT UNIQUE, config_json TEXT NOT NULL, status TEXT NOT NULL,
    phase TEXT NOT NULL, workspace TEXT, pid INTEGER, result_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL REFERENCES attempts(id),
    type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_attempt_seq ON events(attempt_id, seq);
  CREATE TABLE IF NOT EXISTS source_traces (
    id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id), request_id TEXT UNIQUE,
    digest TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runner_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, acquired_at TEXT NOT NULL
  );
`;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function decodeScene(row) {
  return row && { id: row.id, requestId: row.request_id, digest: row.digest,
    manifest: JSON.parse(row.manifest_json), createdAt: row.created_at };
}
function decodeAttempt(row) {
  return row && { id: row.id, sceneId: row.scene_id, requestId: row.request_id,
    config: JSON.parse(row.config_json), status: row.status, phase: row.phase,
    workspace: row.workspace, pid: row.pid,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function decodeSource(row) {
  return row && { id: row.id, sceneId: row.scene_id, requestId: row.request_id,
    digest: row.digest, metadata: JSON.parse(row.metadata_json), createdAt: row.created_at };
}

export class Store {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(join(this.root, 'state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    this.leaseToken = null;
  }

  close() { this.db.close(); }

  acquireRunnerLease() {
    invariant(!this.leaseToken, 'this store already owns the runner lease');
    const token = id('lease');
    this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM runner_lease WHERE singleton=1').get();
      if (current && (current.host !== hostname() || processAlive(current.pid))) {
        throw new Error(`runner already active: pid ${current.pid} on ${current.host}`);
      }
      this.db.prepare('INSERT OR REPLACE INTO runner_lease VALUES (1,?,?,?,?)')
        .run(token, process.pid, hostname(), timestamp());
    });
    this.leaseToken = token;
  }

  releaseRunnerLease() {
    if (!this.leaseToken) return;
    this.transaction(() => {
      this.db.prepare('DELETE FROM runner_lease WHERE singleton=1 AND token=?').run(this.leaseToken);
    });
    this.leaseToken = null;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  scene(id) {
    return decodeScene(this.db.prepare('SELECT * FROM scenes WHERE id=?').get(id));
  }

  sceneByRequestId(requestId) {
    return decodeScene(this.db.prepare('SELECT * FROM scenes WHERE request_id=?').get(requestId));
  }

  addScene({ id, requestId, digest, manifest }) {
    return this.transaction(() => {
      const prior = requestId && this.sceneByRequestId(requestId);
      if (prior) {
        invariant(prior.digest === digest, `scene requestId ${requestId} already has different content`);
        return prior;
      }
      this.db.prepare('INSERT INTO scenes VALUES (?,?,?,?,?)').run(id, requestId ?? null, digest, json(manifest), timestamp());
      return this.scene(id);
    });
  }

  scenes() {
    return this.db.prepare('SELECT * FROM scenes ORDER BY created_at DESC').all().map(decodeScene);
  }

  source(id) {
    return decodeSource(this.db.prepare('SELECT * FROM source_traces WHERE id=?').get(id));
  }

  sourceByRequestId(requestId) {
    return decodeSource(this.db.prepare('SELECT * FROM source_traces WHERE request_id=?').get(requestId));
  }

  sources(sceneId) {
    const rows = sceneId
      ? this.db.prepare('SELECT * FROM source_traces WHERE scene_id=? ORDER BY created_at DESC').all(sceneId)
      : this.db.prepare('SELECT * FROM source_traces ORDER BY created_at DESC').all();
    return rows.map(decodeSource);
  }

  addSource({ id, sceneId, requestId, digest, metadata }) {
    invariant(this.scene(sceneId), `unknown scene ${sceneId}`);
    return this.transaction(() => {
      const prior = requestId && this.sourceByRequestId(requestId);
      if (prior) {
        invariant(prior.sceneId === sceneId && prior.digest === digest,
          `source requestId ${requestId} already has different input`);
        return prior;
      }
      this.db.prepare('INSERT INTO source_traces VALUES (?,?,?,?,?,?)')
        .run(id, sceneId, requestId ?? null, digest, json(metadata), timestamp());
      return this.source(id);
    });
  }

  attempt(id) {
    return decodeAttempt(this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id));
  }

  attempts() {
    return this.db.prepare('SELECT * FROM attempts ORDER BY created_at DESC').all().map(decodeAttempt);
  }

  submit(sceneId, config = {}, requestId) {
    invariant(this.scene(sceneId), `unknown scene ${sceneId}`);
    return this.transaction(() => {
      const prior = requestId && decodeAttempt(this.db.prepare('SELECT * FROM attempts WHERE request_id=?').get(requestId));
      if (prior) {
        invariant(prior.sceneId === sceneId && json(prior.config) === json(config),
          `attempt requestId ${requestId} already has different input`);
        return prior;
      }
      const attemptId = id('att');
      const now = timestamp();
      this.db.prepare('INSERT INTO attempts (id,scene_id,request_id,config_json,status,phase,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(attemptId, sceneId, requestId ?? null, json(config), 'queued', 'admitted', now, now);
      this._event(attemptId, 'attempt.queued', { sceneId, requestId });
      return this.attempt(attemptId);
    });
  }

  _event(attemptId, type, data) {
    this.db.prepare('INSERT INTO events (attempt_id,type,data_json,created_at) VALUES (?,?,?,?)')
      .run(attemptId, type, json(data), timestamp());
  }

  event(attemptId, type, data) {
    invariant(this.attempt(attemptId), `unknown attempt ${attemptId}`);
    this.transaction(() => this._event(attemptId, type, data));
  }

  transition(id, from, to, phase, data = {}, fields = {}) {
    return this.transaction(() => {
      const before = this.attempt(id);
      invariant(before, `unknown attempt ${id}`);
      invariant(from.includes(before.status), `cannot transition ${id} from ${before.status} to ${to}`);
      const workspace = fields.workspace ?? before.workspace;
      const pid = fields.pid === undefined ? before.pid : fields.pid;
      const result = fields.result === undefined ? before.result : fields.result;
      this.db.prepare('UPDATE attempts SET status=?,phase=?,workspace=?,pid=?,result_json=?,updated_at=? WHERE id=?')
        .run(to, phase, workspace, pid, result === null ? null : json(result), timestamp(), id);
      this._event(id, `attempt.${to}`, { from: before.status, phase, ...data });
      return this.attempt(id);
    });
  }

  events(attemptId, after = 0, limit = 1000) {
    return this.db.prepare('SELECT * FROM events WHERE attempt_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(attemptId, after, limit).map((row) => ({ seq: row.seq, attemptId: row.attempt_id,
        type: row.type, data: JSON.parse(row.data_json), createdAt: row.created_at }));
  }

  recover() {
    invariant(this.leaseToken, 'recover requires the runner lease');
    return this.transaction(() => {
      const stale = this.db.prepare("SELECT * FROM attempts WHERE status IN ('preparing','running','grading')").all().map(decodeAttempt);
      for (const attempt of stale) {
        const safe = attempt.status === 'preparing';
        const status = safe ? 'queued' : 'interrupted';
        this.db.prepare('UPDATE attempts SET status=?,phase=?,updated_at=? WHERE id=?')
          .run(status, safe ? 'recovered_preparation' : 'uncertain_codex_effect', timestamp(), attempt.id);
        this._event(attempt.id, `attempt.${status}`, { recovery: true, previous: attempt.status,
          previousPid: attempt.pid,
          reason: safe ? 'preparation can be rebuilt' : 'Codex may have partially changed the workspace' });
      }
      return stale.map((attempt) => this.attempt(attempt.id));
    });
  }
}

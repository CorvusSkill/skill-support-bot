import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'support.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);`);
  }
  get(kind, id) { const r = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id); return r ? JSON.parse(r.value) : null; }
  put(kind, id, value) { this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)').run(kind, id, JSON.stringify(value)); return value; }
  list(kind) { return this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.value)); }
  delete(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  log(value) { this.db.prepare('INSERT INTO logs (at,value) VALUES (?,?)').run(Date.now(), JSON.stringify(value)); }
  prune(days) { this.db.prepare('DELETE FROM logs WHERE at<?').run(Date.now() - days * 86400000); }
  history(threadId) { return this.get('history', threadId) || []; }
  append(message) {
    const h = this.history(message.threadId);
    if (!h.some(m => m.id === message.id)) {
      h.push(message);
      h.sort((a,b) => a.at - b.at || a.id.localeCompare(b.id));
      this.put('history', message.threadId, h.slice(-60));
    }
  }
  close() { this.db.close(); }
}

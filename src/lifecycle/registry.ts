import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { emptyState } from './model.ts';
import type { State } from './model.ts';

export function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}
export class Registry {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  private open(readOnly = false): DatabaseSync {
    if (!readOnly) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new Error('Registry cannot be a symlink');
    const parent = realpathSync(dirname(this.path));
    // Never place lifecycle state in any Git checkout or a disposable tree.
    for (let p = parent; ; p = dirname(p)) {
      if (existsSync(resolve(p, '.git')) || p.includes('/.task-runner-worktrees/')) {
        throw new Error('Lifecycle registry must be outside Git worktrees');
      }
      if (dirname(p) === p) break;
    }
    const db = new DatabaseSync(this.path, { readOnly });
    db.exec('PRAGMA busy_timeout=5000');
    if (!readOnly) {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      db.exec('CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
      db.prepare('INSERT OR IGNORE INTO lifecycle VALUES (1, ?)').run(JSON.stringify(emptyState()));
    }
    return db;
  }
  read(): State {
    if (!existsSync(this.path)) return emptyState();
    const db = this.open(true);
    try { return this.decode(db); } finally { db.close(); }
  }
  private decode(db: DatabaseSync): State {
    const state = JSON.parse((db.prepare('SELECT state FROM lifecycle WHERE id=1').get() as { state: string }).state);
    if (state.version !== 1 || !state.tickets || !state.checkouts) throw new Error('Invalid lifecycle registry; preserve it for recovery');
    return state;
  }
  update<T>(fn: (state: State) => T): T {
    const db = this.open();
    try {
      db.exec('BEGIN IMMEDIATE');
      const state = this.decode(db);
      const result = fn(state);
      if (result instanceof Promise) throw new Error('Registry transactions must be synchronous');
      db.prepare('UPDATE lifecycle SET state=? WHERE id=1').run(JSON.stringify(state));
      db.exec('COMMIT');
      return result;
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
  }
}

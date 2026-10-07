import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { emptyState } from './model.ts';
import type { State } from './model.ts';

export function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

export function assertRegistryLocation(path: string): void {
  const parent = dirname(resolve(path));
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Registry cannot be a symlink');
  // Inspect both names: a symlink must not hide either a disposable source
  // path or a destination inside a checkout. No Git file contents are needed.
  for (const start of new Set([parent, realpathSync(parent)])) {
    for (let p = start; ; p = dirname(p)) {
      const marker = resolve(p, '.git');
      const stat = lstatSync(marker, { throwIfNoEntry: false });
      // Empty ordinary directories are non-repository discovery boundaries.
      // Any contents, gitfile, symlink (including dangling), or unknown type
      // remain unsafe, even if Git cannot recognize the damaged repository.
      const unsafeMarker = stat && (!stat.isDirectory() || readdirSync(marker).length !== 0);
      const parts = p.split(sep);
      const bareMetadata = existsSync(resolve(p, 'HEAD')) &&
        ['objects', 'refs', 'commondir'].some(name => existsSync(resolve(p, name)));
      if (unsafeMarker || bareMetadata || parts.includes('.git') || parts.includes('.task-runner-worktrees')) {
        throw new Error('Lifecycle registry must be outside Git worktrees and repository metadata');
      }
      if (dirname(p) === p) break;
    }
  }
}

export class Registry {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  private open(readOnly = false): DatabaseSync {
    if (!readOnly) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    assertRegistryLocation(this.path);
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
    if (!lstatSync(this.path, { throwIfNoEntry: false })) return emptyState();
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

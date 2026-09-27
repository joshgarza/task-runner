import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import type { Identity } from './model.ts';
import { inside } from './registry.ts';

export function identity(pid = process.pid): Identity {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}
export function alive(owner: Identity): boolean | 'unknown' {
  try { const current = identity(owner.pid); return current.boot === owner.boot && current.start === owner.start; }
  catch (e: any) { return e.code === 'ENOENT' || e.code === 'ESRCH' ? false : 'unknown'; }
}
/** Metadata only: never read process environments, command lines, or file contents. */
export function checkoutActivity(path: string): string[] {
  if (process.platform !== 'linux') return ['Process reconciliation requires Linux /proc'];
  const blockers: string[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      if (statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (inside(cwd, path)) { blockers.push(`Process ${pid} has checkout cwd`); continue; }
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (inside(readlinkSync(`/proc/${pid}/fd/${fd}`), path)) { blockers.push(`Process ${pid} has open checkout file`); break; }
        } catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT' && e.code !== 'ESRCH') blockers.push(`Cannot verify process ${pid}: ${e.code}`);
    }
  }
  return blockers;
}

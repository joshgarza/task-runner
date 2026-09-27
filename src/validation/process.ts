import { spawn } from 'node:child_process';

/** Run validation in a cancellable process group, retaining only bounded diagnostics. */
export function runValidationCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Validation cancelled by disk safety')); return; }
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let cancelled = false; let timedOut = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (name: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); }
      catch (e: any) { if (e.code !== 'ESRCH') throw e; }
    };
    const stop = () => { cancelled = true; kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 1000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      // A shell can exit before a descendant which ignored SIGTERM.
      if (cancelled) kill('SIGKILL');
      cleanup();
      if (cancelled) reject(new Error(timedOut ? 'Validation timed out' : 'Validation cancelled by disk safety'));
      else if (code !== 0) reject(new Error(output || `Validation exited ${code}`));
      else resolve(output);
    });
  });
}

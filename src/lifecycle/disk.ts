import { statfs, stat } from 'node:fs/promises';
import { release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { LifecycleConfig, TaskRunnerConfig } from '../types.ts';
import type { State } from './model.ts';

export interface DiskSample { path: string; freeBytes?: number; error?: string }
const GiB = 1024 ** 3;

// Only WSL installation metadata is read. No credential or VHD contents are opened.
const backingScript = `
$ErrorActionPreference = 'Stop'
$name = [Console]::In.ReadToEnd().Trim()
$distros = @(Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | Where-Object { $_.GetValue('DistributionName') -eq $name })
if ($distros.Count -ne 1) { throw 'Cannot identify WSL backing directory' }
$base = $distros[0].GetValue('BasePath')
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RunnerDisk { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free); }'
[UInt64]$available = 0; [UInt64]$total = 0; [UInt64]$free = 0
if (![RunnerDisk]::GetDiskFreeSpaceEx($base, [ref]$available, [ref]$total, [ref]$free)) { throw 'Cannot query Windows backing filesystem' }
@{ path = 'windows-backing:' + $base; freeBytes = $available } | ConvertTo-Json -Compress
`;
export async function windowsBackingSample(): Promise<DiskSample> {
  return new Promise(resolveResult => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(backingScript, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let finished = false;
    const finish = (sample: DiskSample) => { if (!finished) { finished = true; clearTimeout(timer); resolveResult(sample); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ path: 'windows-backing', error: 'Windows disk probe timed out' }); }, 5000);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 16384) { child.kill(); finish({ path: 'windows-backing', error: 'Invalid Windows disk response' }); } });
    child.stderr.resume();
    child.on('error', () => finish({ path: 'windows-backing', error: 'Windows disk probe unavailable' }));
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error();
        const parsed = JSON.parse(output.trim());
        if (!Number.isFinite(parsed.freeBytes) || parsed.freeBytes < 0 || typeof parsed.path !== 'string') throw new Error();
        finish(parsed);
      } catch { finish({ path: 'windows-backing', error: 'Cannot verify Windows backing filesystem headroom' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(process.env.WSL_DISTRO_NAME ?? '');
  });
}
export async function sampleDisks(config: TaskRunnerConfig): Promise<DiskSample[]> {
  const paths = [...new Set([dirname(config.lifecycle.registryPath), process.cwd(), ...config.lifecycle.diskPaths,
    ...Object.values(config.projects).map(p => p.repoPath)])];
  const samples = await Promise.all(paths.map(async path => {
    try {
      let existing = resolve(path);
      while (true) {
        try { await stat(existing); break; }
        catch (e: any) { if (e.code !== 'ENOENT' || dirname(existing) === existing) throw e; existing = dirname(existing); }
      }
      const info = await statfs(existing);
      return { path, freeBytes: info.bavail * info.bsize };
    } catch { return { path, error: 'Cannot verify filesystem headroom' }; }
  }));
  if (/microsoft/i.test(release())) samples.push(await windowsBackingSample());
  return samples;
}
export function applyDiskSamples(state: State, samples: DiskSample[], config: LifecycleConfig): void {
  const unknown = samples.length === 0 || samples.some(s => s.error || s.freeBytes === undefined || !Number.isFinite(s.freeBytes));
  const belowStop = samples.some(s => s.freeBytes! < config.diskStopGiB * GiB);
  const aboveResume = !unknown && samples.every(s => s.freeBytes! > config.diskResumeGiB * GiB);
  const held = unknown || belowStop || (state.disk.held && !aboveResume);
  state.disk = { held, reasons: held ? samples.filter(s => s.error || s.freeBytes === undefined || s.freeBytes <= config.diskResumeGiB * GiB)
    .map(s => `${s.path}: ${s.error ?? `${(s.freeBytes! / GiB).toFixed(2)} GiB free; resume above ${config.diskResumeGiB} GiB`}`) : [] };
  if (unknown && !state.disk.reasons.length) state.disk.reasons.push('Disk evidence unavailable');
}

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sendControlEval } from '../../src/control/client';
import { getDefaultControlEndpoint } from '../../src/control/transport';
import type { StepUnion } from '../../src/runner/steps/types';
import type { Action } from '../../src/actions/action_protocol';

export type AgentHandle = { endpoint: string; close: () => Promise<void> };

export const startAgent = async (opts?: { headed?: boolean }): Promise<AgentHandle> => {
  const headed = opts?.headed ?? false;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-e2e-'));
  const userDataDir = path.join(tempRoot, 'user-data');
  await fs.mkdir(userDataDir, { recursive: true });
  const endpoint = getDefaultControlEndpoint();
  const keepTemp = process.env.RPA_E2E_KEEP_TEMP === '1';

  const proc = spawn('pnpm', [headed ? 'dev' : 'dev:headless'], {
    cwd: path.resolve(process.cwd()),
    env: { ...process.env, RPA_CONTROL_EVAL: '1', RPA_USER_DATA_DIR: userDataDir, RPA_WORKFLOW_ROOT: path.join(tempRoot, 'workflow') },
    stdio: 'pipe',
  });

  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

  {
    const dl = Date.now() + 30_000;
    while (Date.now() < dl) {
      if (proc.exitCode !== null) throw new Error(`agent exited: ${proc.exitCode} ${stderr}`);
      try { const r = await sendControlEval({ source: 'return { ready: true }', timeoutMs: 2000 }, { endpoint, timeoutMs: 2000 }); if (r.ok) break; } catch {}
    }
  }

  {
    const dl = Date.now() + 30_000;
    while (Date.now() < dl) {
      if (proc.exitCode !== null) throw new Error(`agent exited: ${proc.exitCode}`);
      try { const r = await sendControlEval({ source: 'const d=await ctx.deps.pageRegistry.debugPageBindings("__p__");return Array.isArray(d?.knownBindings)&&d.knownBindings.length>0;', timeoutMs: 2000 }, { endpoint, timeoutMs: 2000 }); if (r.ok && r.result === true) break; } catch {}
    }
  }

  return {
    endpoint,
    close: async () => {
      try {
        if (!proc.killed) { proc.kill('SIGTERM'); await new Promise<void>((r) => { const t = setTimeout(r, 2000); proc.once('exit', () => { clearTimeout(t); r(); }); }); }
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } finally {
        if (keepTemp) console.log(`[e2e] temp kept at ${tempRoot}`);
        else await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
};

export const runStep = async (ep: string, ws: string, step: StepUnion) => {
  const r = await sendControlEval(
    { source: 'return await ctx.runStep(input.s,input.w);', input: { s: step, w: ws }, timeoutMs: 25_000 },
    { endpoint: ep, timeoutMs: 25_000 },
  );
  if (!r.ok) throw new Error(`runStep failed: ${r.error?.message}`);
  return r.result as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
};

export const dispatch = async (ep: string, action: Action) => {
  const r = await sendControlEval(
    { source: 'return await ctx.dispatch(input.a);', input: { a: action }, timeoutMs: 20_000 },
    { endpoint: ep, timeoutMs: 20_000 },
  );
  if (!r.ok) throw new Error(`dispatch failed: ${r.error?.message}`);
  return r.result as Action;
};

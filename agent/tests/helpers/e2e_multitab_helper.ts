import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sendControlEval } from '../../src/control/client';
import { getDefaultControlEndpoint } from '../../src/control/transport';
import type { StepUnion } from '../../src/runner/steps/types';
import type { Action } from '../../src/actions/action_protocol';

export type AgentHandle = { endpoint: string; close: () => Promise<void> };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const envHeaded = () => process.env.RPA_E2E_HEADED === '1';

const resolveStepDelayMs = () => {
  const raw = process.env.RPA_E2E_STEP_DELAY_MS;
  if (raw && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
    return Math.floor(Number(raw));
  }
  return process.env.RPA_E2E_HEADED === '1' ? 600 : 0;
};

export const startAgent = async (opts?: { headed?: boolean }): Promise<AgentHandle> => {
  const headed = opts?.headed ?? envHeaded();
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
  const waitAgentReady = async () => {
    const dl = Date.now() + 30_000;
    while (Date.now() < dl) {
      if (proc.exitCode !== null) throw new Error(`agent exited: ${proc.exitCode} ${stderr}`);
      try {
        const r = await sendControlEval({ source: 'return { ready: !!ctx?.deps?.pageRegistry };', timeoutMs: 2000 }, { endpoint, timeoutMs: 2000 });
        if (r.ok && (r.result as { ready?: boolean })?.ready) return;
      } catch {}
      await sleep(100);
    }
    throw new Error(`agent startup timeout after 30000ms: control endpoint not ready ${stderr}`);
  };

  await waitAgentReady();

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
  const stepDelayMs = resolveStepDelayMs();
  const dl = Date.now() + 10_000;
  let lastErr = '';
  while (true) {
    const r = await sendControlEval(
      { source: 'return await ctx.runStep(input.s,input.w);', input: { s: step, w: ws }, timeoutMs: 25_000 },
      { endpoint: ep, timeoutMs: 25_000 },
    );
    if (r.ok) {
      if (stepDelayMs > 0) await sleep(stepDelayMs);
      return r.result as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
    }
    lastErr = String(r.error?.message || '');
    if (!lastErr.includes('page binding timeout') || Date.now() >= dl) {
      throw new Error(`runStep failed: ${lastErr}`);
    }
    await sleep(200);
  }
};

export const dispatch = async (ep: string, action: Action) => {
  const r = await sendControlEval(
    { source: 'return await ctx.dispatch(input.a);', input: { a: action }, timeoutMs: 20_000 },
    { endpoint: ep, timeoutMs: 20_000 },
  );
  if (!r.ok) throw new Error(`dispatch failed: ${r.error?.message}`);
  return r.result as Action;
};

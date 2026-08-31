import type {IncomingMessage, ServerResponse} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type {Plugin} from 'vite';
import {chromium} from 'playwright';
import {
  buildEntityRuleComponentSnapshots,
  buildSnapshotProjection,
  captureControlSnapshot,
  PageSnapshotSessionStore,
} from '../../../src/automation/snapshot';

type SnapshotRequest = {url?: string; mode?: 'overview' | 'interaction' | 'annotation' | 'debug' | 'full'};
type CaptureEnvelope = {
  id: string;
  label: string;
  capturedAt: string;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  raw?: unknown;
  snapshot?: unknown;
  meta?: Record<string, unknown>;
};
type CaptureIngestRequest = Omit<CaptureEnvelope, 'id' | 'capturedAt' | 'label'> & {
  label?: string;
  capturedAt?: string;
};

const CAPTURE_STORE_DIR = process.env.RPA_SNAPSHOT_CAPTURE_DIR
  || path.join(os.tmpdir(), 'rpa-snapshot-viewer-captures');

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
};

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const ensureCaptureStore = async (): Promise<void> => {
  await fs.mkdir(CAPTURE_STORE_DIR, {recursive: true});
};

const captureFilePath = (id: string): string => path.join(CAPTURE_STORE_DIR, `${id}.json`);

const readCaptureEnvelope = async (id: string): Promise<CaptureEnvelope | null> => {
  const safeId = id.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) {return null;}
  try {
    return JSON.parse(await fs.readFile(captureFilePath(safeId), 'utf8')) as CaptureEnvelope;
  } catch {
    return null;
  }
};

const listCaptureEnvelopes = async (): Promise<Array<Record<string, unknown>>> => {
  await ensureCaptureStore();
  const items: Array<Record<string, unknown>> = [];
  for (const file of await fs.readdir(CAPTURE_STORE_DIR)) {
    if (!file.endsWith('.json')) {continue;}
    const envelope = await readCaptureEnvelope(file.slice(0, -5));
    if (!envelope) {continue;}
    items.push({
      id: envelope.id,
      label: envelope.label,
      capturedAt: envelope.capturedAt,
      sourceUrl: envelope.sourceUrl,
      finalUrl: envelope.finalUrl,
      title: envelope.title,
      hasRaw: envelope.raw !== undefined,
      hasSnapshot: envelope.snapshot !== undefined,
    });
  }
  return items.sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
};

const buildCaptureEnvelope = (request: CaptureIngestRequest): CaptureEnvelope | null => {
  if (request.raw === undefined && request.snapshot === undefined) {return null;}
  const capturedAt = request.capturedAt?.trim() || new Date().toISOString();
  return {
    id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    label: request.label?.trim().slice(0, 120) || 'capture',
    capturedAt,
    sourceUrl: request.sourceUrl?.trim() || undefined,
    finalUrl: request.finalUrl?.trim() || undefined,
    title: request.title?.trim() || undefined,
    raw: request.raw,
    snapshot: request.snapshot,
    meta: request.meta,
  };
};

const captureProjection = async (targetUrl: string, mode: NonNullable<SnapshotRequest['mode']>) => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.goto(targetUrl, {waitUntil: 'domcontentloaded', timeout: 45_000});
    const control = await captureControlSnapshot(page);
    const components = buildEntityRuleComponentSnapshots(control);
    const store = new PageSnapshotSessionStore();
    const entry = await store.ensureFresh({
      pageKey: page,
      pageUrl: page.url(),
      capture: async () => ({control, form: components.form, table: components.table}),
    });
    const result = buildSnapshotProjection(entry, {mode});
    if (!result.ok) {throw new Error(result.error.message);}
    return {url: page.url(), projection: result.projection};
  } finally {
    await browser.close();
  }
};

export const createSnapshotApiPlugin = (): Plugin => ({
  name: 'snapshot-v2-viewer-api',
  configureServer(server) {
    server.middlewares.use('/api/capture/ingest', async (request, response) => {
      if (request.method !== 'POST') {sendJson(response, 405, {ok: false, error: 'method not allowed'}); return;}
      try {
        const envelope = buildCaptureEnvelope(JSON.parse(await readBody(request)) as CaptureIngestRequest);
        if (!envelope) {sendJson(response, 400, {ok: false, error: 'snapshot or raw is required'}); return;}
        await ensureCaptureStore();
        await fs.writeFile(captureFilePath(envelope.id), JSON.stringify(envelope, null, 2), 'utf8');
        sendJson(response, 200, {ok: true, data: {id: envelope.id, storeDir: CAPTURE_STORE_DIR}});
      } catch (error) {
        sendJson(response, 500, {ok: false, error: `capture ingest failed: ${String(error)}`});
      }
    });

    server.middlewares.use('/api/capture/list', async (request, response) => {
      if (request.method !== 'GET') {sendJson(response, 405, {ok: false, error: 'method not allowed'}); return;}
      try {
        sendJson(response, 200, {ok: true, data: {storeDir: CAPTURE_STORE_DIR, items: await listCaptureEnvelopes()}});
      } catch (error) {
        sendJson(response, 500, {ok: false, error: `capture list failed: ${String(error)}`});
      }
    });

    server.middlewares.use('/api/capture/item', async (request, response) => {
      if (request.method !== 'GET') {sendJson(response, 405, {ok: false, error: 'method not allowed'}); return;}
      const requestUrl = new URL(request.url || '', 'http://localhost');
      const envelope = await readCaptureEnvelope(requestUrl.searchParams.get('id') || '');
      if (!envelope) {sendJson(response, 404, {ok: false, error: 'capture not found'}); return;}
      sendJson(response, 200, {ok: true, data: envelope});
    });

    server.middlewares.use('/api/snapshot', async (request, response) => {
      if (request.method !== 'POST') {sendJson(response, 405, {ok: false, error: 'method not allowed'}); return;}
      try {
        const payload = JSON.parse(await readBody(request)) as SnapshotRequest;
        const targetUrl = payload.url?.trim() || '';
        if (!isHttpUrl(targetUrl)) {sendJson(response, 400, {ok: false, error: 'valid http/https url is required'}); return;}
        sendJson(response, 200, {ok: true, data: await captureProjection(targetUrl, payload.mode ?? 'debug')});
      } catch (error) {
        sendJson(response, 500, {ok: false, error: `snapshot failed: ${String(error)}`});
      }
    });
  },
});

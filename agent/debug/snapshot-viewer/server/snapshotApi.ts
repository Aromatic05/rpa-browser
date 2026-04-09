import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { Plugin } from 'vite';
import { chromium } from 'playwright';
import { collectRawData } from '../../../src/runner/steps/executors/snapshot/stages/collect';
import {
  generateSemanticSnapshot,
  generateSemanticSnapshotFromRaw,
} from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';

type SnapshotRequest = {
  url?: string;
};

type LocalSnapshotRequest = {
  domTree?: unknown;
  a11yTree?: unknown;
  label?: string;
};

type SnapshotApiSuccess = {
  ok: true;
  data: {
    url: string;
    unifiedGraph: unknown;
    raw?: {
      domTree?: unknown;
      a11yTree?: unknown;
    };
  };
};

type SnapshotApiFailure = {
  ok: false;
  error: string;
};

type CaptureEnvelope = {
  id: string;
  label: string;
  capturedAt: string;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  raw?: {
    domTree?: unknown;
    a11yTree?: unknown;
  };
  snapshot?: unknown;
  meta?: Record<string, unknown>;
};

type CaptureIngestRequest = {
  label?: string;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  capturedAt?: string;
  raw?: {
    domTree?: unknown;
    a11yTree?: unknown;
  };
  snapshot?: unknown;
  meta?: Record<string, unknown>;
};

type CaptureListItem = {
  id: string;
  label: string;
  capturedAt: string;
  sourceUrl?: string;
  finalUrl?: string;
  hasRaw: boolean;
  hasSnapshot: boolean;
};

const countNodes = (node: unknown): number => {
  if (!node || typeof node !== 'object') return 0;
  const children = Array.isArray((node as { children?: unknown[] }).children)
    ? ((node as { children?: unknown[] }).children as unknown[])
    : [];
  return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (res: ServerResponse, statusCode: number, payload: unknown) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const CAPTURE_STORE_DIR =
  process.env.RPA_SNAPSHOT_CAPTURE_DIR ||
  path.join(os.tmpdir(), 'rpa-snapshot-viewer-captures');

const ensureCaptureStore = async () => {
  await fs.mkdir(CAPTURE_STORE_DIR, { recursive: true });
};

const sanitizeCaptureLabel = (value: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return 'capture';
  return normalized.slice(0, 120);
};

const captureFilePath = (id: string): string => {
  return path.join(CAPTURE_STORE_DIR, `${id}.json`);
};

const writeCaptureEnvelope = async (envelope: CaptureEnvelope) => {
  await ensureCaptureStore();
  const filePath = captureFilePath(envelope.id);
  await fs.writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8');
};

const readCaptureEnvelope = async (id: string): Promise<CaptureEnvelope | null> => {
  const safeId = id.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  try {
    const text = await fs.readFile(captureFilePath(safeId), 'utf8');
    return JSON.parse(text) as CaptureEnvelope;
  } catch {
    return null;
  }
};

const listCaptureEnvelopes = async (): Promise<CaptureListItem[]> => {
  await ensureCaptureStore();
  const files = await fs.readdir(CAPTURE_STORE_DIR);
  const items: CaptureListItem[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    const envelope = await readCaptureEnvelope(id);
    if (!envelope) continue;
    items.push({
      id: envelope.id,
      label: envelope.label,
      capturedAt: envelope.capturedAt,
      sourceUrl: envelope.sourceUrl,
      finalUrl: envelope.finalUrl,
      hasRaw: Boolean(envelope.raw?.domTree && envelope.raw?.a11yTree),
      hasSnapshot: Boolean(envelope.snapshot),
    });
  }

  return items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
};

const buildCaptureEnvelope = (request: CaptureIngestRequest): CaptureEnvelope | null => {
  const hasRaw = Boolean(request.raw?.domTree && request.raw?.a11yTree);
  const hasSnapshot = Boolean(request.snapshot);
  if (!hasRaw && !hasSnapshot) return null;

  const nowIso = new Date().toISOString();
  return {
    id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    label: sanitizeCaptureLabel(request.label || 'capture'),
    capturedAt: (request.capturedAt || nowIso).trim() || nowIso,
    sourceUrl: request.sourceUrl?.trim() || undefined,
    finalUrl: request.finalUrl?.trim() || undefined,
    title: request.title?.trim() || undefined,
    raw: hasRaw ? request.raw : undefined,
    snapshot: hasSnapshot ? request.snapshot : undefined,
    meta: request.meta && typeof request.meta === 'object' ? request.meta : undefined,
  };
};

export const createSnapshotApiPlugin = (): Plugin => ({
  name: 'snapshot-viewer-api',
  configureServer(server) {
    // viewer 场景默认开启 snapshot 调试日志，便于定位节点缺失问题。
    if (!process.env.RPA_SNAPSHOT_DEBUG) {
      process.env.RPA_SNAPSHOT_DEBUG = '1';
    }

    server.middlewares.use('/api/capture/ingest', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      let request: CaptureIngestRequest;
      try {
        request = JSON.parse(await readBody(req)) as CaptureIngestRequest;
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' });
        return;
      }

      const envelope = buildCaptureEnvelope(request);
      if (!envelope) {
        sendJson(res, 400, {
          ok: false,
          error: 'snapshot or raw(domTree+a11yTree) is required',
        });
        return;
      }

      try {
        await writeCaptureEnvelope(envelope);
        sendJson(res, 200, {
          ok: true,
          data: {
            id: envelope.id,
            label: envelope.label,
            capturedAt: envelope.capturedAt,
            storeDir: CAPTURE_STORE_DIR,
          },
        });
      } catch (cause) {
        sendJson(res, 500, { ok: false, error: `capture ingest failed: ${String(cause)}` });
      }
    });

    server.middlewares.use('/api/capture/list', async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      try {
        const items = await listCaptureEnvelopes();
        sendJson(res, 200, {
          ok: true,
          data: {
            storeDir: CAPTURE_STORE_DIR,
            items,
          },
        });
      } catch (cause) {
        sendJson(res, 500, { ok: false, error: `capture list failed: ${String(cause)}` });
      }
    });

    server.middlewares.use('/api/capture/item', async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const id = (requestUrl.searchParams.get('id') || '').trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'id is required' });
        return;
      }

      const envelope = await readCaptureEnvelope(id);
      if (!envelope) {
        sendJson(res, 404, { ok: false, error: 'capture not found' });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        data: envelope,
      });
    });

    // 注意顺序：from-raw 必须放在 /api/snapshot 之前，避免被前缀路由提前拦截。
    server.middlewares.use('/api/snapshot/from-raw', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      let request: LocalSnapshotRequest;
      try {
        request = JSON.parse(await readBody(req)) as LocalSnapshotRequest;
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' });
        return;
      }

      if (!request.domTree || !request.a11yTree) {
        sendJson(res, 400, { ok: false, error: 'domTree and a11yTree are required' });
        return;
      }

      try {
        const unifiedGraph = generateSemanticSnapshotFromRaw({
          domTree: request.domTree,
          a11yTree: request.a11yTree,
        });
        const label = (request.label || 'local-fixture').trim();
        console.log(
          `[snapshot-viewer] local source=${label} dom=${countNodes(request.domTree)} a11y=${countNodes(request.a11yTree)} snapshot=${countNodes((unifiedGraph as { root?: unknown })?.root)}`,
        );

        sendJson(res, 200, {
          ok: true,
          data: {
            url: `local://${label}`,
            unifiedGraph,
            raw: {
              domTree: request.domTree,
              a11yTree: request.a11yTree,
            },
          },
        });
      } catch (cause) {
        sendJson(res, 500, {
          ok: false,
          error: `local snapshot failed: ${String(cause)}`,
        });
      }
    });

    server.middlewares.use('/api/snapshot', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      let request: SnapshotRequest;
      try {
        request = JSON.parse(await readBody(req)) as SnapshotRequest;
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' });
        return;
      }

      const targetUrl = (request.url || '').trim();
      if (!targetUrl || !isHttpUrl(targetUrl)) {
        sendJson(res, 400, { ok: false, error: 'url is required and must be http/https' });
        return;
      }

      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      try {
        console.log(`[snapshot-viewer] request url=${targetUrl}`);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });

        const raw = await collectRawData(page);
        const unifiedGraph = await generateSemanticSnapshot(page);
        console.log(
          `[snapshot-viewer] collected url=${page.url()} dom=${countNodes(raw.domTree)} a11y=${countNodes(raw.a11yTree)} snapshot=${countNodes((unifiedGraph as { root?: unknown })?.root)}`,
        );

        sendJson(res, 200, {
          ok: true,
          data: {
            url: page.url(),
            unifiedGraph,
            raw,
          },
        });
      } catch (cause) {
        sendJson(res, 500, {
          ok: false,
          error: `snapshot failed: ${String(cause)}`,
        });
      } finally {
        await browser?.close().catch(() => undefined);
      }
    });

  },
});

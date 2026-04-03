import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { chromium } from 'playwright';
import { collectRawData } from '../../../src/runner/steps/executors/snapshot/collect';
import {
  generateSemanticSnapshot,
  generateSemanticSnapshotFromRaw,
} from '../../../src/runner/steps/executors/snapshot/snapshot';

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
    domTree: unknown;
    a11yTree: unknown;
    unifiedGraph: unknown;
  };
};

type SnapshotApiFailure = {
  ok: false;
  error: string;
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

const sendJson = (res: ServerResponse, statusCode: number, payload: SnapshotApiSuccess | SnapshotApiFailure) => {
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

export const createSnapshotApiPlugin = (): Plugin => ({
  name: 'snapshot-viewer-api',
  configureServer(server) {
    // viewer 场景默认开启 snapshot 调试日志，便于定位节点缺失问题。
    if (!process.env.RPA_SNAPSHOT_DEBUG) {
      process.env.RPA_SNAPSHOT_DEBUG = '1';
    }

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
            domTree: raw.domTree,
            a11yTree: raw.a11yTree,
            unifiedGraph,
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
            domTree: request.domTree,
            a11yTree: request.a11yTree,
            unifiedGraph,
          },
        });
      } catch (cause) {
        sendJson(res, 500, {
          ok: false,
          error: `local snapshot failed: ${String(cause)}`,
        });
      }
    });
  },
});

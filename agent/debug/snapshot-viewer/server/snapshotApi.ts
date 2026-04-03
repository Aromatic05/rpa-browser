import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { chromium } from 'playwright';
import { collectRawData } from '../../../src/runner/steps/executors/snapshot/collect';
import { generateSemanticSnapshot } from '../../../src/runner/steps/executors/snapshot/snapshot';

type SnapshotRequest = {
  url?: string;
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
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });

        const raw = await collectRawData(page);
        const unifiedGraph = await generateSemanticSnapshot(page);

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
  },
});

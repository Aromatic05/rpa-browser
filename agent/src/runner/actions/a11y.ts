import path from 'path';
import { promises as fs } from 'fs';
import { AxeBuilder } from '@axe-core/playwright';
import type { ActionHandler } from '../execute';
import type { PageA11yScanCommand } from '../commands';
import type { A11yScanOptions, A11yScanResult, A11yViolation } from '../a11y_types';

const ensureDir = async (dir: string) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
};

const buildCounts = (violations: A11yViolation[]) => {
  const byImpact: Record<string, number> = {};
  for (const v of violations) {
    const impact = v.impact || 'unknown';
    byImpact[impact] = (byImpact[impact] || 0) + 1;
  }
  return { total: violations.length, byImpact };
};

const normalizeViolations = (violations: any[]): A11yViolation[] =>
  violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: (v.nodes || []).slice(0, 20).map((node: any) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary
    }))
  }));

export const scanA11y = async (page: import('playwright').Page, options: A11yScanOptions = {}) => {
  const builder = new AxeBuilder({ page });
  options.include?.forEach((sel) => builder.include(sel));
  options.exclude?.forEach((sel) => builder.exclude(sel));
  if (options.tags?.length) {
    builder.withTags(options.tags);
  }
  const results = await builder.analyze();
  let violations = normalizeViolations(results.violations || []);
  if (options.includedImpacts?.length) {
    violations = violations.filter((v) => v.impact && options.includedImpacts?.includes(v.impact as any));
  }
  const counts = buildCounts(violations);
  const ts = Date.now();
  const response: A11yScanResult = {
    ok: violations.length === 0,
    url: page.url(),
    ts,
    violations,
    counts
  };
  if (!response.ok) {
    const outDir = path.resolve(process.cwd(), '.artifacts/a11y');
    await ensureDir(outDir);
    const screenshotPath = path.join(outDir, `${ts}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    response.evidence = { screenshotPath };
  }
  if (options.resultDetail === 'full') {
    response.raw = results;
  }
  return response;
};

export const a11yHandlers: Record<string, ActionHandler> = {
  'page.a11yScan': async (ctx, command) => {
    const args = (command as PageA11yScanCommand).args || {};
    const result = await scanA11y(ctx.page, args);
    return { ok: true, tabToken: ctx.tabToken, data: result };
  }
};

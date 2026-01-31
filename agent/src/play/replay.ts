/**
 * replay：将录制事件转换为可执行命令，并在必要时尝试自愈定位。
 *
 * 依赖关系：
 * - 上游：runner/actions/recording 调用 replayRecording
 * - 下游：runner/execute 执行命令，actions 完成实际操作
 *
 * 关键约束：
 * - 录制事件可能包含候选定位器（locatorCandidates）
 * - 回放失败时生成 evidence（截图/候选尝试）用于排错
 */
import type { Locator, Page } from 'playwright';
import type { RecordedEvent } from '../record/recorder';
import type { Command } from '../runner/commands';
import type { Result } from '../runner/results';
import type { LocatorCandidate, ScopeHint } from '../runner/locator_candidates';
import { highlightLocator, clearHighlight } from '../runner/actions/highlight';
import path from 'path';
import { promises as fs } from 'fs';

export type ReplayOptions = {
    clickDelayMs: number;
    stepDelayMs: number;
    scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};


const flashHighlight = async (locator: Locator) => {
    try {
        await highlightLocator(locator);
        await locator.page().waitForTimeout(150);
    } catch {
        // ignore
    }
};
type CandidateAttempt = {
    kind: string;
    detail: string;
    count: number;
    error?: string;
};

// 回放证据目录，失败时写入截图。
const ensureDir = async (dir: string) => {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch {
        // ignore
    }
};

// scopeHint 是录制侧给出的区域提示（如 header/main）。
const buildScope = (page: Page, scopeHint?: ScopeHint) => {
    if (!scopeHint) return page;
    const selector = scopeHint;
    const locator = page.locator(selector).first();
    return locator;
};

// 将候选定位结构转为具体 locator（优先语义定位）。
const buildLocator = (scope: Page | Locator, candidate: LocatorCandidate) => {
    if (candidate.kind === 'testid' && candidate.testId) {
        return (scope as any).getByTestId(candidate.testId);
    }
    if (candidate.kind === 'role' && candidate.role && candidate.name) {
        return (scope as any).getByRole(candidate.role as any, { name: candidate.name });
    }
    if (candidate.kind === 'label' && candidate.text) {
        return (scope as any).getByLabel(candidate.text, { exact: candidate.exact ?? true });
    }
    if (candidate.kind === 'placeholder' && candidate.text) {
        return (scope as any).getByPlaceholder(candidate.text, { exact: candidate.exact ?? true });
    }
    if (candidate.kind === 'text' && candidate.text) {
        return (scope as any).getByText(candidate.text, { exact: candidate.exact ?? true });
    }
    if (candidate.kind === 'css' && candidate.selector) {
        return (scope as any).locator(candidate.selector);
    }
    return null;
};

const describeCandidate = (candidate: LocatorCandidate) => {
    if (candidate.kind === 'css') return candidate.selector || '';
    if (candidate.kind === 'testid') return candidate.testId || '';
    if (candidate.kind === 'role') return `${candidate.role}:${candidate.name || ''}`;
    return candidate.text || '';
};

/**
 * 依次尝试候选定位器，返回第一个可见唯一匹配。
 */
const resolveByCandidates = async (
    page: Page,
    candidates: LocatorCandidate[],
    scopeHint: ScopeHint | undefined,
    timeoutMs: number,
) => {
    const scope = buildScope(page, scopeHint);
    const attempts: CandidateAttempt[] = [];
    for (const candidate of candidates) {
        const locator = buildLocator(scope, candidate);
        if (!locator) {
            attempts.push({
                kind: candidate.kind,
                detail: describeCandidate(candidate),
                count: 0,
                error: 'invalid candidate',
            });
            continue;
        }
        let count = 0;
        try {
            count = await locator.count();
            if (count === 0) {
                attempts.push({
                    kind: candidate.kind,
                    detail: describeCandidate(candidate),
                    count,
                });
                continue;
            }
            if (count > 1) {
                attempts.push({
                    kind: candidate.kind,
                    detail: describeCandidate(candidate),
                    count,
                    error: 'ambiguous',
                });
                continue;
            }
            const first = locator.first();
            await first.waitFor({ state: 'visible', timeout: timeoutMs });
            await first.scrollIntoViewIfNeeded();
            return { locator: first, attempts };
        } catch (error) {
            attempts.push({
                kind: candidate.kind,
                detail: describeCandidate(candidate),
                count,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { locator: null, attempts };
};

/**
 * 回放录制事件序列。会在必要时尝试 locatorCandidates 自愈。
 * stopOnError 为 true 时遇到失败立即停止。
 */
export const replayRecording = async (
    page: Page,
    events: RecordedEvent[],
    options: ReplayOptions,
    opts: { stopOnError: boolean },
    execute: (command: Command) => Promise<Result>,
    shouldStop?: () => boolean,
) => {
    const results: Array<Record<string, unknown>> = [];
    let pendingScroll = false;

    for (const event of events) {
        if (shouldStop?.()) {
            results.push({ ts: Date.now(), ok: true, type: 'replay.stop', pageUrl: page.url() });
            return { ok: true, data: { results, stopped: true } };
        }
        try {
            let command: Command | null = null;
            const candidates = event.locatorCandidates;
            const scopeHint = event.scopeHint;
            if (event.type === 'navigate' && event.url) {
                command = {
                    cmd: 'page.goto',
                    tabToken: event.tabToken,
                    args: { url: event.url, waitUntil: 'domcontentloaded' },
                };
                pendingScroll = false;
            } else if (event.type === 'click' && event.selector) {
                if (pendingScroll) {
                    await page.locator(event.selector).first().scrollIntoViewIfNeeded();
                    pendingScroll = false;
                }
                if (candidates?.length) {
                    const { locator, attempts } = await resolveByCandidates(
                        page,
                        candidates,
                        scopeHint,
                        5000,
                    );
                    if (!locator) {
                        const ts = Date.now();
                        const outDir = path.resolve(
                            process.cwd(),
                            '.artifacts/replay',
                            event.tabToken,
                        );
                        await ensureDir(outDir);
                        const screenshotPath = path.join(outDir, `${ts}.png`);
                        await page.screenshot({ path: screenshotPath, fullPage: true });
                        results.push({
                            ts: event.ts,
                            ok: false,
                            type: event.type,
                            error: 'locator not found',
                            evidence: { attempts, url: page.url(), screenshotPath },
                        });
                        if (opts.stopOnError) return { ok: false, data: { results } };
                        continue;
                    }
                    await flashHighlight(locator);
                    await locator.click({ timeout: 5000, noWaitAfter: true });
                    await clearHighlight(locator);
                    await page.waitForTimeout(options.stepDelayMs);
                    results.push({ ts: event.ts, ok: true, type: event.type, pageUrl: page.url() });
                    continue;
                }
                command = {
                    cmd: 'element.click',
                    tabToken: event.tabToken,
                    args: {
                        target: { selector: event.selector },
                        options: { timeout: 5000, noWaitAfter: true },
                    },
                };
            } else if ((event.type === 'input' || event.type === 'change') && event.selector) {
                if (event.value === '***') {
                    results.push({ ts: event.ts, ok: true, note: 'password redacted' });
                    continue;
                }
                if (pendingScroll) {
                    await page.locator(event.selector).first().scrollIntoViewIfNeeded();
                    pendingScroll = false;
                }
                if (candidates?.length) {
                    const { locator, attempts } = await resolveByCandidates(
                        page,
                        candidates,
                        scopeHint,
                        5000,
                    );
                    if (!locator) {
                        const ts = Date.now();
                        const outDir = path.resolve(
                            process.cwd(),
                            '.artifacts/replay',
                            event.tabToken,
                        );
                        await ensureDir(outDir);
                        const screenshotPath = path.join(outDir, `${ts}.png`);
                        await page.screenshot({ path: screenshotPath, fullPage: true });
                        results.push({
                            ts: event.ts,
                            ok: false,
                            type: event.type,
                            error: 'locator not found',
                            evidence: { attempts, url: page.url(), screenshotPath },
                        });
                        if (opts.stopOnError) return { ok: false, data: { results } };
                        continue;
                    }
                    await flashHighlight(locator);
                    await locator.fill(event.value || '', { timeout: 5000 });
                    await clearHighlight(locator);
                    await page.waitForTimeout(options.stepDelayMs);
                    results.push({ ts: event.ts, ok: true, type: event.type, pageUrl: page.url() });
                    continue;
                }
                command = {
                    cmd: 'element.fill',
                    tabToken: event.tabToken,
                    args: { target: { selector: event.selector }, text: event.value || '' },
                };
            } else if (
                event.type === 'check' &&
                event.selector &&
                typeof event.checked === 'boolean'
            ) {
                command = {
                    cmd: 'element.setChecked',
                    tabToken: event.tabToken,
                    args: { target: { selector: event.selector }, checked: event.checked },
                };
            } else if (event.type === 'select' && event.selector) {
                command = {
                    cmd: 'element.selectOption',
                    tabToken: event.tabToken,
                    args: {
                        target: { selector: event.selector },
                        value: event.value,
                        label: event.label,
                    },
                };
            } else if (event.type === 'date' && event.selector && event.value) {
                command = {
                    cmd: 'element.setDate',
                    tabToken: event.tabToken,
                    args: { target: { selector: event.selector }, value: event.value },
                };
            } else if (event.type === 'paste' && event.selector) {
                if (!event.value || event.value === '***') {
                    results.push({ ts: event.ts, ok: true, note: 'paste redacted' });
                    continue;
                }
                command = {
                    cmd: 'element.paste',
                    tabToken: event.tabToken,
                    args: {
                        target: { selector: event.selector },
                        text: event.value,
                        options: { allowSensitive: true },
                    },
                };
            } else if (event.type === 'copy' && event.selector) {
                command = {
                    cmd: 'element.copy',
                    tabToken: event.tabToken,
                    args: { target: { selector: event.selector } },
                };
            } else if (event.type === 'keydown' && event.key) {
                command = {
                    cmd: 'keyboard.press',
                    tabToken: event.tabToken,
                    args: { key: event.key },
                };
            } else if (event.type === 'scroll') {
                if (typeof event.scrollX === 'number' && typeof event.scrollY === 'number') {
                    command = {
                        cmd: 'page.scrollTo',
                        tabToken: event.tabToken,
                        args: { x: event.scrollX, y: event.scrollY },
                    };
                } else {
                    command = {
                        cmd: 'page.scrollBy',
                        tabToken: event.tabToken,
                        args: { dx: 0, dy: options.scroll.minDelta },
                    };
                }
                pendingScroll = true;
            }
            if (!command) {
                results.push({ ts: event.ts, ok: true, type: event.type, skipped: true });
                continue;
            }
            const execResult = await execute(command);
            if (!execResult.ok && opts.stopOnError) {
                results.push({
                    ts: event.ts,
                    ok: false,
                    type: event.type,
                    error: execResult.error.message,
                });
                return { ok: false, data: { results } };
            }
            await page.waitForTimeout(options.stepDelayMs);
            results.push({
                ts: event.ts,
                ok: execResult.ok,
                type: event.type,
                pageUrl: page.url(),
            });
        } catch (error) {
            results.push({
                ts: event.ts,
                ok: false,
                type: event.type,
                error: error instanceof Error ? error.message : String(error),
            });
            if (opts.stopOnError) {
                return { ok: false, data: { results } };
            }
        }
    }

    return { ok: true, data: { results } };
};

import type { Page } from 'playwright';

/**
 * Observed-world invalidation bridge.
 *
 * The PageSnapshotSessionStore only becomes dirty when an rpa-browser step or
 * the recorder marks it so. Real pages mutate themselves (application timers,
 * SPA renders, websocket updates) without any rpa tool involved, so a captured
 * world revision silently goes stale while the store still reports "fresh".
 *
 * This module installs a lightweight, content-agnostic DOM MutationObserver on
 * a managed page and forwards a bare "the DOM changed" signal to the runtime
 * (via Playwright's `exposeFunction`, which survives navigation and never
 * leaks page content). The runtime then marks the page session dirty so the
 * existing dirtyRevision -> ensureFresh -> captureRevision pipeline recaptures
 * exactly when the world actually moved.
 */

const SIGNAL_FUNCTION_NAME = '__rpa_dom_mutation_signal';
const OBSERVER_GUARD_KEY = '__rpa_dom_observer_installed';

/** Coalescing window: leading-edge signal plus one trailing signal per window. */
const COALESCE_WINDOW_MS = 100;

const installedPages = new WeakSet<Page>();

/**
 * Installs the page-side observer. The script must:
 * - cover attributes, childList and characterData under the whole document,
 * - ignore the rpa-internal `data-rpa-*` attribute namespace so snapshot
 *   capture markers and runtime-state markers never mark the page dirty,
 * - ignore the extension's own DOM (script/style nodes and the annotator
 *   panel subtree) so the tool's own UI never dirties the observed world,
 * - stay silent while the document is still `loading`: the initial HTML parse
 *   is captured by the first page-session baseline, and a late coalesced
 *   signal must not race past that capture,
 * - coalesce React/Vue mutation bursts into one signal so the runtime is not
 *   flooded with per-record notifications,
 * - run once per document and be guarded so rebinding/reconnect never stacks
 *   a second observer in the same document.
 */
const OBSERVER_INSTALL_SCRIPT = `
(() => {
    const SIGNAL = ${JSON.stringify(SIGNAL_FUNCTION_NAME)};
    const GUARD = ${JSON.stringify(OBSERVER_GUARD_KEY)};
    const WINDOW_MS = ${COALESCE_WINDOW_MS};
    if (globalThis[GUARD]) { return; }
    globalThis[GUARD] = true;
    const target = (document && document.documentElement) || document;
    if (!target) { return; }
    let cooldown = false;
    let pending = false;
    let timer = null;
    const fire = () => {
        const signal = globalThis[SIGNAL];
        if (typeof signal !== 'function') { return; }
        try { signal(); } catch (error) {}
    };
    const flush = () => {
        timer = null;
        cooldown = false;
        if (!pending) { return; }
        pending = false;
        fire();
    };
    const schedule = () => {
        if (document.readyState === 'loading') { return; }
        if (cooldown) { pending = true; return; }
        cooldown = true;
        pending = false;
        fire();
        timer = setTimeout(flush, WINDOW_MS);
    };
    const isIgnoredElement = (node) => {
        if (!node || node.nodeType !== 1) { return false; }
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'script' || tag === 'style') { return true; }
        const attr = (name) => { try { return node.getAttribute(name); } catch (error) { return null; } };
        if (attr('id') === 'rpa-floating-panel') { return true; }
        const flagged = (value) => {
            if (!value) { return false; }
            const normalized = String(value).toLowerCase();
            return normalized === '1' || normalized === 'true' || normalized === 'yes';
        };
        return flagged(attr('data-rpa-panel')) || flagged(attr('data-rpa-snapshot-ignore'));
    };
    const isInIgnoredSubtree = (node) => {
        let cursor = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
        while (cursor) {
            if (isIgnoredElement(cursor)) { return true; }
            cursor = cursor.parentElement;
        }
        return false;
    };
    const isInternalMutation = (record) => {
        if (record.type === 'attributes') {
            if (typeof record.attributeName === 'string'
                && record.attributeName.indexOf('data-rpa-') === 0) {
                return true;
            }
            return isInIgnoredSubtree(record.target);
        }
        if (record.type === 'characterData') {
            return isInIgnoredSubtree(record.target);
        }
        if (record.type === 'childList') {
            if (isInIgnoredSubtree(record.target)) { return true; }
            for (let index = 0; index < record.addedNodes.length; index += 1) {
                const node = record.addedNodes[index];
                if (!node) { continue; }
                if (node.nodeType !== 1 || (!isIgnoredElement(node) && !isInIgnoredSubtree(node))) {
                    return false;
                }
            }
            for (let index = 0; index < record.removedNodes.length; index += 1) {
                const node = record.removedNodes[index];
                if (!node) { continue; }
                if (node.nodeType !== 1 || (!isIgnoredElement(node) && !isInIgnoredSubtree(node))) {
                    return false;
                }
            }
            return true;
        }
        return false;
    };
    try {
        const observer = new MutationObserver((records) => {
            for (let index = 0; index < records.length; index += 1) {
                if (isInternalMutation(records[index])) { continue; }
                schedule();
                return;
            }
        });
        observer.observe(target, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
    } catch (error) {}
})();
`;

/**
 * Installs the DOM mutation signal for one managed page. Idempotent per page:
 * a second call is a no-op, and rebinding/reconnecting the same page never
 * stacks duplicate observers or duplicate exposeFunction listeners.
 *
 * Teardown is owned by the page lifecycle: when the page closes, Playwright
 * drops the exposed binding and the page-side timers/observer die with the
 * document; the WeakSet entry is garbage collected. No module-level timer or
 * listener outlives the page.
 */
export const installPageMutationObserver = async (
    page: Page,
    onDomMutated: (page: Page) => void,
): Promise<void> => {
    if (installedPages.has(page)) {return;}
    installedPages.add(page);

    try {
        await page.exposeFunction(SIGNAL_FUNCTION_NAME, () => {
            onDomMutated(page);
        });
    } catch (_error) {
        // The binding may already be registered for this page on a reconnect;
        // one live observer keeps signalling, so re-registration is not needed.
    }
    try {
        await page.addInitScript({ content: OBSERVER_INSTALL_SCRIPT });
    } catch (_error) {
        // Restricted documents may reject init scripts; best-effort per page.
    }
    try {
        await page.evaluate(OBSERVER_INSTALL_SCRIPT);
    } catch (_error) {
        // The current document may be navigating or already closed; the init
        // script re-installs the observer on the next document.
    }
};
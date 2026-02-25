import type { Page } from 'playwright';

type DescribeResult =
    | { ok: true; data: { role?: string; name?: string; text?: string } }
    | {
          ok: false;
          error: { code: 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS'; message: string; details?: unknown; phase: 'trace' };
      };

export const describeSelector = async (page: Page, selector: string): Promise<DescribeResult> => {
    const result = await page.evaluate((sel) => {
        const normalizeText = (value?: string | null) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const getLabelText = (el: Element) => {
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
                return '';
            }
            const id = el.getAttribute('id');
            if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label) return normalizeText(label.textContent || '');
            }
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return normalizeText(ariaLabel);
            const labelledBy = el.getAttribute('aria-labelledby');
            if (labelledBy) {
                const ids = labelledBy.split(/\s+/);
                const parts = ids
                    .map((id: string) => {
                        const node = document.getElementById(id);
                        return node ? normalizeText(node.textContent || '') : '';
                    })
                    .filter(Boolean);
                if (parts.length) return parts.join(' ');
            }
            const wrapLabel = el.closest('label');
            if (wrapLabel) return normalizeText(wrapLabel.textContent || '');
            return '';
        };
        const getRole = (el: Element) => {
            const explicit = el.getAttribute('role');
            if (explicit) return explicit;
            const tag = el.tagName.toLowerCase();
            if (tag === 'button') return 'button';
            if (tag === 'a' && el.getAttribute('href')) return 'link';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
                const type = (el.getAttribute('type') || 'text').toLowerCase();
                if (type === 'checkbox') return 'checkbox';
                if (type === 'radio') return 'radio';
                if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
                return 'textbox';
            }
            return null;
        };
        const getName = (el: Element) => {
            const aria = el.getAttribute('aria-label');
            if (aria) return normalizeText(aria);
            const labelText = getLabelText(el);
            if (labelText) return labelText;
            const title = el.getAttribute('title');
            if (title) return normalizeText(title);
            const alt = el.getAttribute('alt');
            if (alt) return normalizeText(alt);
            if (
                (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
                el.value
            ) {
                return normalizeText(el.value);
            }
            const textContent = el instanceof HTMLElement ? el.innerText : el.textContent;
            const text = normalizeText(textContent || '');
            if (text) return text;
            return '';
        };

        try {
            const nodes = Array.from(document.querySelectorAll(sel));
            if (nodes.length === 0) return { status: 'not_found' };
            if (nodes.length > 1) return { status: 'ambiguous', count: nodes.length };
            const el = nodes[0];
            return {
                status: 'ok',
                role: getRole(el) || undefined,
                name: getName(el) || undefined,
                text: normalizeText((el instanceof HTMLElement ? el.innerText : el.textContent) || '') || undefined,
            };
        } catch (error) {
            return { status: 'invalid', message: String(error) };
        }
    }, selector);

    if (result.status === 'invalid') {
        return {
            ok: false,
            error: { code: 'ERR_NOT_FOUND', message: 'invalid selector', details: { selector, error: result.message }, phase: 'trace' },
        };
    }
    if (result.status === 'not_found') {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'selector not found', details: { selector }, phase: 'trace' } };
    }
    if (result.status === 'ambiguous') {
        // TODO: add fuzzy disambiguation.
        return {
            ok: false,
            error: {
                code: 'ERR_AMBIGUOUS',
                message: 'selector matches multiple elements',
                details: { selector, count: result.count },
                phase: 'trace',
            },
        };
    }
    return { ok: true, data: { role: result.role, name: result.name, text: result.text } };
};

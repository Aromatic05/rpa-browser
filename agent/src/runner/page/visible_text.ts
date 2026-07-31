export const visibleTextEvaluation = (needle: string): {expression: string; arg: {needle: string}} => ({
    expression: `({ needle }) => {
        const text = String(needle || '').trim();
        if (!text || !document.body) return false;
        const isRendered = (element) => {
            let current = element;
            while (current instanceof Element) {
                const style = window.getComputedStyle(current);
                if (!style
                    || style.display === 'none'
                    || style.visibility === 'hidden'
                    || style.visibility === 'collapse'
                    || Number(style.opacity || '1') <= 0) {
                    return false;
                }
                current = current.parentElement;
            }
            return element.getClientRects().length > 0;
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const chunks = [];
        let node = walker.nextNode();
        while (node) {
            const value = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
            const parent = node.parentElement;
            if (value && parent && isRendered(parent)) chunks.push(value);
            node = walker.nextNode();
        }
        return chunks.join(' ').includes(text);
    }`,
    arg: {needle},
});

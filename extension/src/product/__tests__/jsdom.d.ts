/**
 * Minimal ambient types for jsdom, which ships no bundled declarations.
 * Declared only what the product DOM tests actually use.
 */
declare module 'jsdom' {
    export class JSDOM {
        constructor(html?: string, options?: { url?: string });
        window: Window & typeof globalThis;
        close(): void;
    }
}
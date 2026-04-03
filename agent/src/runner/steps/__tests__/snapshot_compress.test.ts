import test from 'node:test';
import assert from 'node:assert/strict';
import { compress } from '../executors/snapshot/compress';
import type { UnifiedNode } from '../executors/snapshot/types';

const node = (
    id: string,
    role: string,
    children: UnifiedNode[] = [],
    patch: Partial<UnifiedNode> = {},
): UnifiedNode => ({
    id,
    role,
    children,
    ...patch,
});

test('compress should delete script/style/svg/path and empty decorative shells', () => {
    const root = node('root', 'root', [
        node('script', 'script', [], { attrs: { tag: 'script' } }),
        node('style', 'style', [], { attrs: { tag: 'style' } }),
        node('svg', 'svg', [], { attrs: { tag: 'svg' } }),
        node('path', 'path', [], { attrs: { tag: 'path' } }),
        node('empty', 'div', [], { attrs: { tag: 'div', class: 'ant-space' } }),
        node('button', 'button', [], { name: '提交', content: '提交', attrs: { tag: 'button' } }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'button');
});

test('compress should collapse wrapper shells and lift child text to interactive parent', () => {
    const root = node('root', 'root', [
        node('shell', 'div', [
            node('btn', 'button', [
                node('text-shell', 'span', [], {
                    name: '查询',
                    content: '查询',
                    attrs: { tag: 'span' },
                }),
            ], {
                attrs: { tag: 'button' },
            }),
        ], {
            attrs: { tag: 'div', class: 'ant-btn-content' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'button');
    assert.equal(out.children[0].name, '查询');
    assert.equal(out.children[0].content, '查询');
    assert.equal(out.children[0].children.length, 0);
});

test('compress should keep entity/structure nodes even if they look like wrappers', () => {
    const rowEntity = node('row-entity', 'div', [
        node('cell-1', 'cell', [], { attrs: { tag: 'td' } }),
    ], {
        entityId: 'entity:row-1',
        entityType: 'row',
        attrs: { tag: 'div', entityId: 'entity:row-1', entityType: 'row' },
    });
    const root = node('root', 'root', [rowEntity]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].id, 'row-entity');
    assert.equal(out.children[0].entityType, 'row');
});

test('compress should not blindly lift long mixed text into parent', () => {
    const longText =
        'This is a very long mixed sentence that should stay on the text node and must not be lifted into button name.';
    const root = node('root', 'root', [
        node('btn', 'button', [
            node('text-shell', 'span', [], {
                content: longText,
                attrs: { tag: 'span' },
            }),
        ], {
            attrs: { tag: 'button' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'button');
    assert.equal(out.children[0].name, undefined);
    assert.equal(out.children[0].content, undefined);
    assert.equal(out.children[0].children.length, 1);
    assert.equal(out.children[0].children[0].content, longText);
});

test('compress should keep list/listitem boundary while preserving link atom', () => {
    const root = node('root', 'root', [
        node('list', 'list', [
            node('item', 'listitem', [
                node('link', 'link', [
                    node('icon-wrap', 'span', [
                        node('icon', 'i', [], { attrs: { tag: 'i', class: 'icon external' } }),
                    ], { attrs: { tag: 'span', class: 'link-icon' } }),
                ], {
                    name: '文档',
                    content: '文档',
                    target: { ref: '/docs', kind: 'url' },
                    attrs: { tag: 'a' },
                }),
            ], { attrs: { tag: 'li' } }),
        ], { attrs: { tag: 'ul' } }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children[0].role, 'list');
    assert.equal(out.children[0].children[0].role, 'listitem');
    assert.equal(out.children[0].children[0].children[0].role, 'link');
    assert.equal(out.children[0].children[0].children[0].children.length, 0);
});

test('compress should atomize button and trim icon implementation descendants', () => {
    const root = node('root', 'root', [
        node('btn', 'button', [
            node('span-1', 'span', [
                node('svg', 'svg', [
                    node('path', 'path', [], { attrs: { tag: 'path' } }),
                ], { attrs: { tag: 'svg' } }),
            ], { attrs: { tag: 'span', class: 'btn-icon' } }),
            node('span-2', 'span', [], { name: '保存', content: '保存', attrs: { tag: 'span' } }),
        ], {
            attrs: { tag: 'button' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'button');
    assert.equal(out.children[0].name, '保存');
    assert.equal(out.children[0].children.length, 0);
});

test('compress should atomize image and remove vector implementation subtree', () => {
    const root = node('root', 'root', [
        node('img', 'image', [
            node('svg', 'svg', [
                node('g', 'g', [
                    node('path', 'path', [], { attrs: { tag: 'path' } }),
                ], { attrs: { tag: 'g' } }),
            ], { attrs: { tag: 'svg' } }),
        ], {
            name: '商品图',
            attrs: { tag: 'img', src: 'https://example.com/x.png' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'image');
    assert.equal(out.children[0].children.length, 0);
});

test('compress should remove duplicated text fragments under completed heading', () => {
    const root = node('root', 'root', [
        node('h', 'heading', [
            node('a', 'span', [], { content: '订单列表', attrs: { tag: 'span' } }),
            node('b', 'span', [], { content: '订单列表', attrs: { tag: 'span' } }),
            node('c', 'span', [], { content: '（今日）', attrs: { tag: 'span' } }),
        ], {
            name: '订单列表',
            content: '订单列表',
            attrs: { tag: 'h2' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'heading');
    assert.equal(out.children[0].children.length, 0);
    assert.equal(out.children[0].content, '订单列表 （今日）');
});

test('compress should flatten multi-layer layout wrappers but keep card boundary', () => {
    const root = node('root', 'root', [
        node('w1', 'div', [
            node('w2', 'div', [
                node('card', 'section', [
                    node('w3', 'div', [
                        node('btn', 'button', [], { name: '查看', content: '查看', attrs: { tag: 'button' } }),
                    ], { attrs: { tag: 'div', class: 'card-body' } }),
                ], {
                    entityType: 'card',
                    attrs: { tag: 'section', entityType: 'card' },
                }),
            ], { attrs: { tag: 'div', class: 'col center' } }),
        ], { attrs: { tag: 'div', class: 'row container' } }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'section');
    assert.equal(out.children[0].children.length, 1);
    assert.equal(out.children[0].children[0].role, 'button');
});

test('compress should flatten entity-marked layout shell when child can absorb semantic payload', () => {
    const root = node('root', 'root', [
        node('shell', 'div', [
            node('row', 'row', [
                node('action', 'button', [], { name: '删除', content: '删除', attrs: { tag: 'button' } }),
            ], { attrs: { tag: 'div' } }),
        ], {
            entityId: 'entity:x',
            entityType: 'unknown',
            parentEntityId: 'entity:p',
            attrs: {
                tag: 'div',
                entityId: 'entity:x',
                entityType: 'unknown',
                parentEntityId: 'entity:p',
            },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'row');
    assert.equal(out.children[0].entityId, 'entity:x');
    assert.equal(out.children[0].parentEntityId, 'entity:p');
});

test('compress should cut non-page subtree in one shot', () => {
    const root = node('root', 'root', [
        node('head', 'head', [
            node('meta', 'meta', [], { attrs: { tag: 'meta' } }),
            node('link', 'link', [], { attrs: { tag: 'link' } }),
            node('script', 'script', [], { attrs: { tag: 'script' } }),
        ], { attrs: { tag: 'head' } }),
        node('main', 'main', [
            node('content', 'paragraph', [], { content: '正文', attrs: { tag: 'p' } }),
        ], { attrs: { tag: 'main' } }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'main');
});

test('compress should prune pseudo-element nodes like ::before/::after', () => {
    const root = node('root', 'root', [
        node('container', 'div', [
            node('before', '::before', [], { attrs: { tag: '::before', backendDOMNodeId: '197' } }),
            node('real', 'link', [], {
                name: '主页',
                content: '主页',
                target: { ref: '/', kind: 'url' },
                attrs: { tag: 'a' },
            }),
            node('after', '::after', [], { attrs: { tag: '::after', backendDOMNodeId: '198' } }),
        ], { attrs: { tag: 'div' } }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'link');
});

test('compress should drop head subtree even when represented by role', () => {
    const root = node('root', 'root', [
        node('html', 'html', [
            node('head-role', 'head', [
                node('meta', 'meta', [], { attrs: { tag: 'meta' } }),
            ]),
            node('body', 'body', [
                node('main', 'main', [], { content: '正文', attrs: { tag: 'main' } }),
            ]),
        ]),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children[0].children.length, 1);
    assert.equal(out.children[0].children[0].role, 'body');
});

test('compress should still drop head subtree when head is wrongly marked as entity/card', () => {
    const root = node('root', 'root', [
        node('head', 'head', [
            node('asset', 'link', [], {
                target: { ref: '/css/app.css', kind: 'url' },
                attrs: {
                    tag: 'link',
                    href: '/css/app.css',
                    strongSemantic: 'true',
                    entityId: 'entity:n0.0',
                },
            }),
            node('title', 'title', [], {
                content: '订单管理 - title',
                attrs: { tag: 'title' },
            }),
        ], {
            attrs: {
                tag: 'head',
                entity: 'true',
                entityId: 'entity:n0.0',
                entityType: 'card',
            },
            entityId: 'entity:n0.0',
            entityType: 'card',
        }),
        node('body', 'body', [
            node('main', 'main', [], { content: '正文', attrs: { tag: 'main' } }),
        ], { attrs: { tag: 'body' } }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'body');
});

test('compress should remove breadcrumb separator and collapse wrapper span', () => {
    const root = node('root', 'root', [
        node('wrapper', 'span', [
            node('home', 'link', [], {
                name: '主页',
                content: '主页',
                target: { ref: '/', kind: 'url' },
                attrs: { tag: 'a', class: 'router-link-active', entityId: 'entity:x' },
            }),
            node('separator', 'span', [], {
                content: '/',
                attrs: { tag: 'span', class: 'ant-breadcrumb-separator' },
            }),
        ], {
            attrs: { tag: 'span', parentEntityId: 'entity:x' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'link');
    assert.equal(out.children[0].content, '主页');
});

test('compress should enforce strict atomic link and cut heading/image descendants', () => {
    const root = node('root', 'root', [
        node('brand-link', 'link', [
            node('wrap', 'div', [
                node('logo', 'image', [], { attrs: { tag: 'img' } }),
                node('title', 'heading', [], {
                    name: '影刀商城',
                    content: '影刀商城',
                    attrs: { tag: 'h1' },
                }),
            ], { attrs: { tag: 'div' } }),
        ], {
            name: '影刀商城',
            content: '影刀商城',
            target: { ref: '/', kind: 'url' },
            attrs: { tag: 'a', href: '/' },
        }),
    ]);

    const out = compress(root);
    assert.ok(out);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].role, 'link');
    assert.equal(out.children[0].name, '影刀商城');
    assert.equal(out.children[0].content, '影刀商城');
    assert.equal(out.children[0].children.length, 0);
});

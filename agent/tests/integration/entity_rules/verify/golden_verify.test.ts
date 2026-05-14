import test from 'node:test';
import { verifyEntityRuleGoldenCase } from './helper';

const cases = [
    { profile: 'oa-ant-orders', app: 'ant', pagePath: '/entity-rules/fixtures/order-list' },
    { profile: 'oa-ant-order-form', app: 'ant', pagePath: '/entity-rules/fixtures/order-form' },
    { profile: 'oa-element-users', app: 'element', pagePath: '/entity-rules/fixtures/user-list' },
    { profile: 'oa-element-user-form', app: 'element', pagePath: '/entity-rules/fixtures/user-form' },
] as const;

for (const item of cases) {
    test(`entity rules golden verify: ${item.profile}`, async () => {
        await verifyEntityRuleGoldenCase(item);
    });
}

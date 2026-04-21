import test from 'node:test';
import { verifyEntityRuleGoldenCase } from './helper';

const cases = [
    { profile: 'oa-ant-orders', pagePath: '/pages/entity-rules/ant-order-list.html' },
    { profile: 'oa-ant-order-form', pagePath: '/pages/entity-rules/ant-order-form.html' },
    { profile: 'oa-element-users', pagePath: '/pages/entity-rules/element-user-list.html' },
    { profile: 'oa-element-user-form', pagePath: '/pages/entity-rules/element-user-form.html' },
] as const;

for (const item of cases) {
    test(`entity rules golden verify: ${item.profile}`, async () => {
        await verifyEntityRuleGoldenCase(item);
    });
}

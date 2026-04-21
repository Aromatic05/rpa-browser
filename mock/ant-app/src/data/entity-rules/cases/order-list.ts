import type { OrderListCase } from '../../../types/entity-rules';
import { fixtureOrderRows } from '../fixtures/order-list';

const buyers = ['王明', '李静', '张涛', '赵敏', '陈楠', '刘晨', '孙凯', '周越'];
const statuses = ['全部', '待审批', '已通过', '已驳回'] as const;

const buildCase = (index: number): OrderListCase => {
    const id = `case-order-list-${String(index + 1).padStart(2, '0')}`;
    const serial = String((index % fixtureOrderRows.length) + 1).padStart(3, '0');
    const useOrderNoOnly = index % 3 === 0;

    const expected = useOrderNoOnly
        ? {
            orderNo: `ORD-2026-${serial}`,
            buyer: '',
            status: '全部' as const,
        }
        : {
            orderNo: '',
            buyer: buyers[index % buyers.length],
            status: statuses[(index % (statuses.length - 1)) + 1],
        };

    const scoreRules = useOrderNoOnly
        ? [
            { key: 'orderNo', score: 60 },
            { key: 'submit', score: 40 },
        ]
        : [
            { key: 'buyer', score: 35 },
            { key: 'status', score: 35 },
            { key: 'submit', score: 30 },
        ];

    return {
        id,
        title: `订单列表场景 ${index + 1}`,
        description: useOrderNoOnly ? '输入订单编号并提交查询。' : '输入采购人和状态并提交查询。',
        initialData: {
            filters: { orderNo: '', buyer: '', status: '全部' },
            rows: fixtureOrderRows,
        },
        expected: { filters: expected },
        scoreRules,
    };
};

export const orderListCases: OrderListCase[] = Array.from({ length: 30 }, (_, index) => buildCase(index));

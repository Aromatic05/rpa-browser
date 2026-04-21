import type { OrderListCase } from '../../../types/entity-rules';
import { fixtureOrderRows } from '../fixtures/order-list';

const buyers = ['王明', '李静', '张涛', '赵敏', '陈楠', '刘晨', '孙凯', '周越'];
const statuses = ['全部', '待审批', '已通过', '已驳回'] as const;

const matchRows = (filters: { orderNo: string; buyer: string; status: string }) =>
    fixtureOrderRows.filter((row) => {
        if (filters.orderNo && !row.orderNo.includes(filters.orderNo)) return false;
        if (filters.buyer && !row.buyer.includes(filters.buyer)) return false;
        if (filters.status !== '全部' && row.status !== filters.status) return false;
        return true;
    });

const buildCase = (index: number): OrderListCase => {
    const id = `case-order-list-${String(index + 1).padStart(2, '0')}`;
    const serial = String((index % fixtureOrderRows.length) + 1).padStart(3, '0');
    const buyer = buyers[index % buyers.length];
    const status = statuses[(index % (statuses.length - 1)) + 1];

    const mode = index % 4;
    const expectedFilters =
        mode === 0
            ? { orderNo: `ORD-2026-${serial}`, buyer: '', status: '全部' as const }
            : mode === 1
                ? { orderNo: '', buyer, status: '全部' as const }
                : mode === 2
                    ? { orderNo: '', buyer, status }
                    : { orderNo: '', buyer: '', status };
    const matched = matchRows(expectedFilters);

    const scoreRules =
        mode === 0
            ? [
                { key: 'orderNo', score: 60 },
                { key: 'submit', score: 40 },
            ]
            : mode === 1
                ? [
                    { key: 'buyer', score: 60 },
                    { key: 'submit', score: 40 },
                ]
                : mode === 2
                    ? [
                        { key: 'buyer', score: 35 },
                        { key: 'status', score: 35 },
                        { key: 'submit', score: 30 },
                    ]
                    : [
                        { key: 'status', score: 60 },
                        { key: 'submit', score: 40 },
                    ];

    const description =
        mode === 0
            ? `按订单编号精确查询：${expectedFilters.orderNo}。预期结果 ${matched.length} 条。`
            : mode === 1
                ? `按采购人查询：${expectedFilters.buyer}。预期结果 ${matched.length} 条。`
                : mode === 2
                    ? `按采购人+状态查询：${expectedFilters.buyer} / ${expectedFilters.status}。预期结果 ${matched.length} 条。`
                    : `按状态查询：${expectedFilters.status}。预期结果 ${matched.length} 条。`;

    return {
        id,
        title: `订单列表任务 ${index + 1}`,
        description,
        initialData: {
            filters: { orderNo: '', buyer: '', status: '全部' },
            rows: fixtureOrderRows,
        },
        expected: {
            filters: expectedFilters,
            resultCount: matched.length,
        },
        scoreRules,
    };
};

export const orderListCases: OrderListCase[] = Array.from({ length: 30 }, (_, index) => buildCase(index));

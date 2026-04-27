import type { OrderListCase } from '../../../types/entity-rules';
import { fixtureOrderRows } from '../fixtures/order-list';

const matchRows = (filters: { orderNo: string; buyer: string; status: string }) =>
    fixtureOrderRows.filter((row) => {
        if (filters.orderNo && !row.orderNo.includes(filters.orderNo)) return false;
        if (filters.buyer && !row.buyer.includes(filters.buyer)) return false;
        if (filters.status !== '全部' && row.status !== filters.status) return false;
        return true;
    });

const seeds: Array<{
    title: string;
    filters: { orderNo: string; buyer: string; status: string };
}> = [
    { title: '精确编号 ORD-2026-001', filters: { orderNo: 'ORD-2026-001', buyer: '', status: '全部' } },
    { title: '精确编号 ORD-2026-008', filters: { orderNo: 'ORD-2026-008', buyer: '', status: '全部' } },
    { title: '精确编号 ORD-2026-017', filters: { orderNo: 'ORD-2026-017', buyer: '', status: '全部' } },
    { title: '采购人 王明', filters: { orderNo: '', buyer: '王明', status: '全部' } },
    { title: '采购人 李静', filters: { orderNo: '', buyer: '李静', status: '全部' } },
    { title: '采购人 张涛', filters: { orderNo: '', buyer: '张涛', status: '全部' } },
    { title: '采购人 陈楠', filters: { orderNo: '', buyer: '陈楠', status: '全部' } },
    { title: '状态 待审批', filters: { orderNo: '', buyer: '', status: '待审批' } },
    { title: '状态 已通过', filters: { orderNo: '', buyer: '', status: '已通过' } },
    { title: '状态 已驳回', filters: { orderNo: '', buyer: '', status: '已驳回' } },
    { title: '王明 + 待审批', filters: { orderNo: '', buyer: '王明', status: '待审批' } },
    { title: '王明 + 已通过', filters: { orderNo: '', buyer: '王明', status: '已通过' } },
    { title: '李静 + 待审批', filters: { orderNo: '', buyer: '李静', status: '待审批' } },
    { title: '李静 + 已驳回', filters: { orderNo: '', buyer: '李静', status: '已驳回' } },
    { title: '张涛 + 已通过', filters: { orderNo: '', buyer: '张涛', status: '已通过' } },
    { title: '赵敏 + 已驳回', filters: { orderNo: '', buyer: '赵敏', status: '已驳回' } },
    { title: '陈楠 + 待审批', filters: { orderNo: '', buyer: '陈楠', status: '待审批' } },
    { title: '刘晨 + 已通过', filters: { orderNo: '', buyer: '刘晨', status: '已通过' } },
    { title: '孙凯 + 已驳回', filters: { orderNo: '', buyer: '孙凯', status: '已驳回' } },
    { title: '周越 + 待审批', filters: { orderNo: '', buyer: '周越', status: '待审批' } },
    { title: '编号片段 02', filters: { orderNo: '02', buyer: '', status: '全部' } },
    { title: '编号片段 03', filters: { orderNo: '03', buyer: '', status: '全部' } },
    { title: '编号片段 1', filters: { orderNo: '1', buyer: '', status: '全部' } },
    { title: '编号片段 4 + 状态已通过', filters: { orderNo: '4', buyer: '', status: '已通过' } },
    { title: '编号片段 5 + 状态待审批', filters: { orderNo: '5', buyer: '', status: '待审批' } },
    { title: '周越 + 编号片段 3', filters: { orderNo: '3', buyer: '周越', status: '全部' } },
    { title: '刘晨 + 编号片段 2', filters: { orderNo: '2', buyer: '刘晨', status: '全部' } },
    { title: '王明 + 编号片段 0', filters: { orderNo: '0', buyer: '王明', status: '全部' } },
    { title: '陈楠 + 编号片段 9', filters: { orderNo: '9', buyer: '陈楠', status: '全部' } },
    { title: '李静 + 编号片段 6', filters: { orderNo: '6', buyer: '李静', status: '全部' } },
];

export const orderListCases: OrderListCase[] = seeds.map((seed, index) => {
    const matched = matchRows(seed.filters);
    return {
        id: `case-order-list-${String(index + 1).padStart(2, '0')}`,
        title: `订单列表任务 ${index + 1}`,
        description: `${seed.title}。预期结果 ${matched.length} 条。`,
        initialData: {
            filters: { orderNo: '', buyer: '', status: '全部' },
            rows: fixtureOrderRows,
        },
        expected: {
            filters: seed.filters,
            resultCount: matched.length,
        },
        scoreRules: [
            { key: 'orderNo', score: 34 },
            { key: 'buyer', score: 33 },
            { key: 'status', score: 33 },
        ],
    };
});

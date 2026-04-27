import type { OrderFormCase } from '../../../types/entity-rules';

const buyers = ['采购专员A', '采购专员B', '采购专员C', '采购专员D', '采购专员E'];
const depts = ['采购部', '运营部', '财务部'] as const;
const categories = ['办公用品', '设备采购', '营销物料', '外包服务', '仓储补货'];

const buildCase = (index: number): OrderFormCase => {
    const id = `case-order-form-${String(index + 1).padStart(2, '0')}`;
    const serial = String(101 + index).padStart(3, '0');
    const amount = 3000 + index * 270;
    const buyer = buyers[index % buyers.length];
    const dept = depts[index % depts.length];
    const category = categories[index % categories.length];
    const expectedOrderNo = `ORD-2026-${serial}`;

    return {
        id,
        title: `订单表单任务 ${index + 1}`,
        description: `录入 ${category} 采购单：订单编号 ${expectedOrderNo}，采购人 ${buyer}，金额 ${amount}，部门 ${dept}。`,
        initialData: {
            orderNo: '',
            buyer: '',
            amount: 0,
            dept: '采购部',
            remark: '',
        },
        expected: {
            orderNo: expectedOrderNo,
            buyer,
            amount,
            dept,
        },
        scoreRules: [
            { key: 'orderNo', score: 30 },
            { key: 'buyer', score: 20 },
            { key: 'amount', score: 20 },
            { key: 'dept', score: 10 },
            { key: 'submit', score: 20 },
        ],
    };
};

export const orderFormCases: OrderFormCase[] = Array.from({ length: 30 }, (_, index) => buildCase(index));

import type { OrderFormCase } from '../../../types/entity-rules';

const buyers = ['采购专员A', '采购专员B', '采购专员C', '采购专员D', '采购专员E'];
const depts = ['采购部', '运营部', '财务部'] as const;

const buildCase = (index: number): OrderFormCase => {
    const id = `case-order-form-${String(index + 1).padStart(2, '0')}`;
    const serial = String(101 + index).padStart(3, '0');
    const amount = 3000 + index * 270;

    return {
        id,
        title: `订单表单场景 ${index + 1}`,
        description: '填写订单编号、采购人、金额、部门后提交。',
        initialData: {
            orderNo: '',
            buyer: '',
            amount: 0,
            dept: '采购部',
            remark: '',
        },
        expected: {
            orderNo: `ORD-2026-${serial}`,
            buyer: buyers[index % buyers.length],
            amount,
            dept: depts[index % depts.length],
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

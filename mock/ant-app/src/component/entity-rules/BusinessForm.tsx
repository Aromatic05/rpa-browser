import { Button, Col, Form, Input, InputNumber, Row, Select, Space } from 'antd';

type ListFormValues = { orderNo: string; buyer: string; status: string };
type OrderFormValues = { orderNo: string; buyer: string; amount: number; dept: string; remark: string };

type FilterProps = {
    mode: 'list';
    values: ListFormValues;
    onChange: (patch: Partial<ListFormValues>) => void;
    onSubmit?: () => void;
    onReset?: () => void;
};

type FormProps = {
    mode: 'form';
    values: OrderFormValues;
    onChange: (patch: Partial<OrderFormValues>) => void;
    onSubmit?: () => void;
    onReset?: () => void;
    onSaveDraft?: () => void;
    onCancel?: () => void;
};

const listStatusOptions = [
    { label: '全部', value: '全部' },
    { label: '待审批', value: '待审批' },
    { label: '已通过', value: '已通过' },
    { label: '已驳回', value: '已驳回' },
];

const deptOptions = [
    { label: '采购部', value: '采购部' },
    { label: '运营部', value: '运营部' },
    { label: '财务部', value: '财务部' },
];

const OrderListFilterForm = ({ values, onChange, onSubmit, onReset }: FilterProps) => (
    <Form layout="vertical" role="form" aria-label="订单筛选表单">
        <Row gutter={16}>
            <Col span={8}>
                <Form.Item label="订单编号">
                    <Input value={values.orderNo} placeholder="请输入订单编号" onChange={(event) => onChange({ orderNo: event.target.value })} />
                </Form.Item>
            </Col>
            <Col span={8}>
                <Form.Item label="采购人">
                    <Input value={values.buyer} placeholder="请输入采购人" onChange={(event) => onChange({ buyer: event.target.value })} />
                </Form.Item>
            </Col>
            <Col span={8}>
                <Form.Item label="状态">
                    <Select value={values.status} options={listStatusOptions} onChange={(status) => onChange({ status })} />
                </Form.Item>
            </Col>
        </Row>
        <Space>
            <Button type="primary" onClick={onSubmit}>
                查询
            </Button>
            <Button onClick={onReset}>重置</Button>
        </Space>
    </Form>
);

const OrderCreateForm = ({ values, onChange, onSubmit, onReset, onSaveDraft, onCancel }: FormProps) => (
    <Form layout="vertical" role="form" aria-label="订单创建表单">
        <Row gutter={16}>
            <Col span={12}>
                <Form.Item label="订单编号" required>
                    <Input value={values.orderNo} placeholder="例如 ORD-2026-101" onChange={(event) => onChange({ orderNo: event.target.value })} />
                </Form.Item>
            </Col>
            <Col span={12}>
                <Form.Item label="采购人" required>
                    <Input value={values.buyer} placeholder="请输入采购人" onChange={(event) => onChange({ buyer: event.target.value })} />
                </Form.Item>
            </Col>
            <Col span={12}>
                <Form.Item label="订单金额" required>
                    <InputNumber
                        style={{ width: '100%' }}
                        value={values.amount}
                        placeholder="请输入金额"
                        onChange={(amount) => onChange({ amount: Number(amount || 0) })}
                    />
                </Form.Item>
            </Col>
            <Col span={12}>
                <Form.Item label="所属部门" required>
                    <Select value={values.dept} options={deptOptions} onChange={(dept) => onChange({ dept })} />
                </Form.Item>
            </Col>
        </Row>
        <Form.Item label="备注">
            <Input value={values.remark} placeholder="请输入备注" onChange={(event) => onChange({ remark: event.target.value })} />
        </Form.Item>
        <Space>
            <Button type="primary" onClick={onSubmit}>
                提交
            </Button>
            <Button onClick={onSaveDraft}>保存草稿</Button>
            <Button onClick={onReset}>重置</Button>
            <Button onClick={onCancel}>取消</Button>
        </Space>
    </Form>
);

export const BusinessForm = (props: FilterProps | FormProps) => {
    if (props.mode === 'list') {
        return <OrderListFilterForm {...props} />;
    }
    return <OrderCreateForm {...props} />;
};

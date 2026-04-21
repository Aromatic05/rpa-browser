import { Alert, Card, Space, message } from 'antd';
import { useState } from 'react';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderFormFixture } from '../../service/entity-rules/fixture-service';

export const FixtureOrderForm = () => {
    const initialValues = getOrderFormFixture();
    const [formValues, setFormValues] = useState(initialValues);

    const validate = () => {
        if (!formValues.orderNo.trim()) return '订单编号必填';
        if (!formValues.buyer.trim()) return '采购人必填';
        if (!Number(formValues.amount) || Number(formValues.amount) <= 0) return '订单金额必须大于 0';
        if (!formValues.dept.trim()) return '所属部门必填';
        return undefined;
    };

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title="订单表单夹具页" description="用于 entity_rules 表单场景命中和 golden verify。" />
            <Alert type="info" showIcon message="提交前会做必填校验，缺字段无法提交。" />
            <Card title="新建订单">
                <BusinessForm
                    mode="form"
                    values={formValues}
                    onChange={(patch) => setFormValues((current) => ({ ...current, ...patch }))}
                    onSubmit={() => {
                        const error = validate();
                        if (error) {
                            message.error(error);
                            return;
                        }
                        message.success(`提交成功：${formValues.orderNo}`);
                    }}
                    onReset={() => {
                        setFormValues(initialValues);
                        message.info('表单已重置');
                    }}
                    onCancel={() => {
                        setFormValues(initialValues);
                        message.warning('已取消编辑');
                    }}
                />
            </Card>
        </Space>
    );
};

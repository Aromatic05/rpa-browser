import { Card, Space, message } from 'antd';
import { useState } from 'react';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderFormFixture } from '../../service/entity-rules/fixture-service';

export const FixtureOrderForm = () => {
    const initialValues = getOrderFormFixture();
    const [formValues, setFormValues] = useState(initialValues);
    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title="订单表单夹具页" description="用于 entity_rules 表单场景命中和 golden verify。" />
            <Card title="新建订单">
                <BusinessForm
                    mode="form"
                    values={formValues}
                    onChange={(patch) => setFormValues((current) => ({ ...current, ...patch }))}
                    onSubmit={() => message.success(`已提交订单 ${formValues.orderNo || '(未填写编号)'}`)}
                    onSaveDraft={() => message.info('草稿已保存')}
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

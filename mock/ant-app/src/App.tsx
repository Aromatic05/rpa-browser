import { ConfigProvider, Layout } from 'antd';
import { useRoutes } from 'react-router-dom';
import { entityRuleRoutes } from './route/entity-rules';

const { Content } = Layout;

const App = () => {
    const routeElement = useRoutes(entityRuleRoutes);
    return (
        <ConfigProvider>
            <Layout style={{ minHeight: '100vh', background: '#f5f7fb' }}>
                <Content style={{ maxWidth: 1120, margin: '0 auto', width: '100%', padding: 24 }}>{routeElement}</Content>
            </Layout>
        </ConfigProvider>
    );
};

export default App;

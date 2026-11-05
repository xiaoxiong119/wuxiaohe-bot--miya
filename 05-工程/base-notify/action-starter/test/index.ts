import { testAction, createActionContext } from '@lark-opdev/block-basekit-server-api';

async function test() {
  const actionContext = await createActionContext({
    tenantAccessToken: process.env.TENANT_ACCESS_TOKEN || '',
  });

  await testAction(
    {
      receiver: [
        {
          id: process.env.TEST_RECEIVE_ID || 'ou_xxx',
          type: (process.env.TEST_RECEIVE_TYPE as 'user' | 'group') || 'user',
        },
      ],
      content: '测试消息：来自多维表格自动化插件',
    },
    actionContext,
  );
}

test();

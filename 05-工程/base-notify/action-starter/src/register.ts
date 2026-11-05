import { basekit, Component, ParamType } from '@lark-opdev/block-basekit-server-api';

basekit.addAction({
  actionText: '发送飞书消息',
  description: '把消息内容发送到指定的飞书用户或群聊',
  useTenantAccessToken: true,
  formItems: [
    {
      itemId: 'receiver',
      label: '接收人 / 群',
      component: Component.ContactPicker,
      required: true,
      componentProps: {
        placeholder: '选择飞书用户或群聊',
        mode: 'single',
        supportTypes: ['user', 'group'],
      },
      help: '支持选择单个用户或群聊',
    },
    {
      itemId: 'content',
      label: '消息内容',
      component: Component.Input,
      required: true,
      componentProps: {
        mode: 'textarea',
        placeholder: '输入要发送的文本，可引用前序节点的字段',
      },
    },
  ],
  execute: async function (args, context) {
    const { receiver, content } = args;

    if (!receiver || !Array.isArray(receiver) || receiver.length === 0) {
      throw new Error('未选择接收人');
    }
    if (!content || String(content).trim() === '') {
      throw new Error('消息内容为空');
    }

    const target = receiver[0];
    const receiveIdType = target.type === 'group' ? 'chat_id' : 'open_id';
    const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;

    const response = await context.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${context.tenantAccessToken}`,
      },
      body: JSON.stringify({
        receive_id: target.id,
        msg_type: 'text',
        content: JSON.stringify({ text: String(content) }),
      }),
    });

    const data: any = await response.json();

    if (!response.ok || data.code !== 0) {
      return {
        success: false,
        messageId: '',
        error: `发送失败：${data.msg || response.statusText}（code ${data.code ?? response.status}）`,
      };
    }

    return {
      success: true,
      messageId: data.data?.message_id || '',
      error: '',
    };
  },
  resultType: {
    type: ParamType.Object,
    properties: {
      success: {
        type: ParamType.Boolean,
        label: '是否发送成功',
      },
      messageId: {
        type: ParamType.String,
        label: '消息 ID',
      },
      error: {
        type: ParamType.String,
        label: '错误信息',
      },
    },
  },
});

export default basekit;

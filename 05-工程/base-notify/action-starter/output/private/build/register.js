"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const block_basekit_server_api_1 = require("@lark-opdev/block-basekit-server-api");
block_basekit_server_api_1.basekit.addAction({
    actionText: '发送飞书消息',
    description: '把消息内容发送到指定的飞书用户或群聊',
    useTenantAccessToken: true,
    formItems: [
        {
            itemId: 'receiver',
            label: '接收人 / 群',
            component: block_basekit_server_api_1.Component.ContactPicker,
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
            component: block_basekit_server_api_1.Component.Input,
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
        const data = await response.json();
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
        type: block_basekit_server_api_1.ParamType.Object,
        properties: {
            success: {
                type: block_basekit_server_api_1.ParamType.Boolean,
                label: '是否发送成功',
            },
            messageId: {
                type: block_basekit_server_api_1.ParamType.String,
                label: '消息 ID',
            },
            error: {
                type: block_basekit_server_api_1.ParamType.String,
                label: '错误信息',
            },
        },
    },
});
exports.default = block_basekit_server_api_1.basekit;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVnaXN0ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvcmVnaXN0ZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxtRkFBcUY7QUFFckYsa0NBQU8sQ0FBQyxTQUFTLENBQUM7SUFDaEIsVUFBVSxFQUFFLFFBQVE7SUFDcEIsV0FBVyxFQUFFLG9CQUFvQjtJQUNqQyxvQkFBb0IsRUFBRSxJQUFJO0lBQzFCLFNBQVMsRUFBRTtRQUNUO1lBQ0UsTUFBTSxFQUFFLFVBQVU7WUFDbEIsS0FBSyxFQUFFLFNBQVM7WUFDaEIsU0FBUyxFQUFFLG9DQUFTLENBQUMsYUFBYTtZQUNsQyxRQUFRLEVBQUUsSUFBSTtZQUNkLGNBQWMsRUFBRTtnQkFDZCxXQUFXLEVBQUUsV0FBVztnQkFDeEIsSUFBSSxFQUFFLFFBQVE7Z0JBQ2QsWUFBWSxFQUFFLENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQzthQUNoQztZQUNELElBQUksRUFBRSxhQUFhO1NBQ3BCO1FBQ0Q7WUFDRSxNQUFNLEVBQUUsU0FBUztZQUNqQixLQUFLLEVBQUUsTUFBTTtZQUNiLFNBQVMsRUFBRSxvQ0FBUyxDQUFDLEtBQUs7WUFDMUIsUUFBUSxFQUFFLElBQUk7WUFDZCxjQUFjLEVBQUU7Z0JBQ2QsSUFBSSxFQUFFLFVBQVU7Z0JBQ2hCLFdBQVcsRUFBRSxxQkFBcUI7YUFDbkM7U0FDRjtLQUNGO0lBQ0QsT0FBTyxFQUFFLEtBQUssV0FBVyxJQUFJLEVBQUUsT0FBTztRQUNwQyxNQUFNLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxHQUFHLElBQUksQ0FBQztRQUVuQyxJQUFJLENBQUMsUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsSUFBSSxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ25FLE1BQU0sSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDNUIsQ0FBQztRQUNELElBQUksQ0FBQyxPQUFPLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsRUFBRSxDQUFDO1lBQzlDLE1BQU0sSUFBSSxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDNUIsQ0FBQztRQUVELE1BQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUMzQixNQUFNLGFBQWEsR0FBRyxNQUFNLENBQUMsSUFBSSxLQUFLLE9BQU8sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDdEUsTUFBTSxHQUFHLEdBQUcsbUVBQW1FLGFBQWEsRUFBRSxDQUFDO1FBRS9GLE1BQU0sUUFBUSxHQUFHLE1BQU0sT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7WUFDeEMsTUFBTSxFQUFFLE1BQU07WUFDZCxPQUFPLEVBQUU7Z0JBQ1AsY0FBYyxFQUFFLGlDQUFpQztnQkFDakQsYUFBYSxFQUFFLFVBQVUsT0FBTyxDQUFDLGlCQUFpQixFQUFFO2FBQ3JEO1lBQ0QsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ25CLFVBQVUsRUFBRSxNQUFNLENBQUMsRUFBRTtnQkFDckIsUUFBUSxFQUFFLE1BQU07Z0JBQ2hCLE9BQU8sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO2FBQ25ELENBQUM7U0FDSCxDQUFDLENBQUM7UUFFSCxNQUFNLElBQUksR0FBUSxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUV4QyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsSUFBSSxJQUFJLENBQUMsSUFBSSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3BDLE9BQU87Z0JBQ0wsT0FBTyxFQUFFLEtBQUs7Z0JBQ2QsU0FBUyxFQUFFLEVBQUU7Z0JBQ2IsS0FBSyxFQUFFLFFBQVEsSUFBSSxDQUFDLEdBQUcsSUFBSSxRQUFRLENBQUMsVUFBVSxTQUFTLElBQUksQ0FBQyxJQUFJLElBQUksUUFBUSxDQUFDLE1BQU0sR0FBRzthQUN2RixDQUFDO1FBQ0osQ0FBQztRQUVELE9BQU87WUFDTCxPQUFPLEVBQUUsSUFBSTtZQUNiLFNBQVMsRUFBRSxJQUFJLENBQUMsSUFBSSxFQUFFLFVBQVUsSUFBSSxFQUFFO1lBQ3RDLEtBQUssRUFBRSxFQUFFO1NBQ1YsQ0FBQztJQUNKLENBQUM7SUFDRCxVQUFVLEVBQUU7UUFDVixJQUFJLEVBQUUsb0NBQVMsQ0FBQyxNQUFNO1FBQ3RCLFVBQVUsRUFBRTtZQUNWLE9BQU8sRUFBRTtnQkFDUCxJQUFJLEVBQUUsb0NBQVMsQ0FBQyxPQUFPO2dCQUN2QixLQUFLLEVBQUUsUUFBUTthQUNoQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxJQUFJLEVBQUUsb0NBQVMsQ0FBQyxNQUFNO2dCQUN0QixLQUFLLEVBQUUsT0FBTzthQUNmO1lBQ0QsS0FBSyxFQUFFO2dCQUNMLElBQUksRUFBRSxvQ0FBUyxDQUFDLE1BQU07Z0JBQ3RCLEtBQUssRUFBRSxNQUFNO2FBQ2Q7U0FDRjtLQUNGO0NBQ0YsQ0FBQyxDQUFDO0FBRUgsa0JBQWUsa0NBQU8sQ0FBQyJ9
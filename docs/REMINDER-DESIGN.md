# Hub 定时提醒功能 — 方案设计

## 需求

用户通过飞书给进宝机器人发消息，如"明天早上8:00提醒我交周报"，到时间后飞书收到提醒消息。

## 现有架构

```
飞书用户 → 进宝机器人 → Hub.dispatchChat() → 节点 AI 处理 → 回复 → Hub → 进宝 → 飞书用户
```

关键细节：
- `dispatchChat` 的 `from` 字段是 `feishu:{clusterId}`，**不携带具体用户 open_id**
- 节点只知道消息来自"飞书"，不知道是哪个用户
- 节点已有 OpenClaw **cron 系统**（支持 `at` 一次性定时任务）
- 节点已有 **feishu_message** 工具（Hub 下发的飞书凭据，能发消息给指定 open_id）

## 方案对比

### 方案 A：节点 cron + feishu_message（推荐 ✅）

**思路**：节点 AI 解析时间 → 创建 cron 任务 → 到时间 → 用 feishu_message 发飞书消息

```
飞书用户: "明天8点提醒我交周报"
     ↓
进宝 → Hub → 节点 AI
     ↓
AI 理解意图，调用 cron 创建定时任务：
  schedule: { kind: "at", at: "2026-02-14T08:00:00+08:00" }
  payload: { kind: "agentTurn", message: "执行提醒：给飞书用户 ou_xxx 发送提醒消息'交周报'" }
     ↓
到时间后 cron 触发 isolated session
     ↓
AI 调用 feishu_message 发送消息给 ou_xxx
     ↓
用户飞书收到：「⏰ 提醒：交周报」
```

**优点**：
- ⭐ **改动最小** — Hub 和插件代码改动极少
- 复用现有 cron 系统，成熟可靠
- 复用现有 feishu_message 工具
- AI 自然语言理解已有能力

**缺点**：
- 节点必须在线才能触发（笔记本合盖就失效）
- cron 任务存储在节点本地

**需要改动**：
1. Hub `dispatchChat()` 传递发送者 open_id（目前缺失）
2. 插件端把 open_id 传给 AI（让 AI 知道要提醒谁）

---

### 方案 B：Hub 服务端定时器

**思路**：节点 AI 解析时间后，调用 Hub API 注册定时任务，Hub 到时间后直接发飞书消息

```
飞书用户: "明天8点提醒我交周报"
     ↓
进宝 → Hub → 节点 AI
     ↓
AI 解析出结构化数据：{ time: "2026-02-14T08:00:00+08:00", content: "交周报", userId: "ou_xxx" }
     ↓
AI 调用 hub_create_reminder → Hub REST API 注册定时任务
     ↓
Hub 端 setInterval/setTimeout 到时间后
     ↓
Hub 直接用飞书 SDK 发消息给 ou_xxx
```

**优点**：
- Hub 是云端服务器，24h 在线，不受节点状态影响
- 提醒可靠性最高

**缺点**：
- Hub 需要新增定时任务系统（调度器、持久化、容错）
- 改动较大
- Hub 重启后需恢复定时器

---

### 方案 C：Hub 定时 + 节点触发（混合）

**思路**：Hub 只做定时触发，到时间后通过 dispatchChat 让节点 AI 执行提醒发送

```
Hub 定时器触发 → dispatchChat(节点, "请发送提醒给 ou_xxx: 交周报")
                                     ↓
                             节点 AI 调用 feishu_message
```

**优点**：Hub 定时可靠 + 节点 AI 灵活

**缺点**：到时间时节点必须在线；Hub 仍需定时系统

---

## 推荐方案：A（节点 cron + feishu_message）

理由：
1. **改动最小**，只需在 Hub 传递用户 ID + 插件端透传
2. **复用成熟组件**（cron 系统 + feishu_message）
3. 对于 24h 在线的节点（台式机/服务器）完全够用
4. 未来可平滑升级到方案 B（Hub 端定时器作为增强）

### 具体改动清单

#### 1. Hub 端（feishu.ts） — 传递用户身份

**改动点**：`dispatchChat()` 调用时，在 payload 中加入发送者信息

```typescript
// feishu.ts - chatAndReply 方法
const result = await this.hub.dispatchChat(
  binding.clusterId,
  targetNodeId,
  content,
  {
    timeoutMs: 300000,
    // 新增：传递飞书用户信息
    sender: {
      platform: 'feishu',
      userId: userId,           // open_id
      userName: binding.feishuUserName || undefined,
    }
  }
);
```

**Hub.dispatchChat()** 将 sender 放入 chat 消息 payload：

```typescript
// hub.ts - dispatchChat 方法
this.sendTo(targetId, {
  type: 'chat',
  id: chatId,
  from: `feishu:${clusterId}`,
  to: targetId,
  payload: {
    content,
    role: 'user',
    sender: options.sender,  // 新增
  },
});
```

#### 2. 插件端（index.ts） — 透传用户 ID 给 AI

**改动点**：`handleIncomingChat()` 中，将 sender 信息注入消息上下文

```typescript
// index.ts - handleIncomingChat
const sender = msg.payload?.sender;
let messageForAI = content;

if (sender?.platform === 'feishu' && sender?.userId) {
  // 在消息中注入发送者信息，让 AI 知道是谁在说话
  messageForAI = `[飞书用户 ${sender.userName || sender.userId}，open_id: ${sender.userId}]\n${content}`;
}

const agentResult = await gatewayRpc('agent', {
  message: messageForAI,
  sessionKey,
  // ...
});
```

#### 3. AI 行为（无代码改动）

AI 收到带有用户 ID 的消息后，自然能理解"提醒"意图并执行：

```
用户消息：[飞书用户 Hanson，open_id: ou_0f1b3bb3c22b561bd09dc36769fe2a59]
         明天早上8点提醒我交周报

AI 思考：用户想要定时提醒，我需要：
1. 解析时间：明天早上8点 = 2026-02-14T08:00:00+08:00
2. 创建 cron 定时任务
3. 任务触发时用 feishu_message 发给 ou_0f1b3bb3c22b561bd09dc36769fe2a59

AI 动作：调用 cron 工具
  {
    action: "add",
    job: {
      name: "提醒交周报",
      schedule: { kind: "at", at: "2026-02-14T08:00:00+08:00" },
      payload: {
        kind: "agentTurn",
        message: "定时提醒触发：请用 feishu_message 工具给飞书用户 ou_0f1b3bb3c22b561bd09dc36769fe2a59 发送消息：⏰ 提醒：交周报"
      },
      sessionTarget: "isolated"
    }
  }

AI 回复：✅ 已设置提醒：明天早上 8:00 提醒你交周报
```

### 改动量评估

| 组件 | 改动 | 工作量 |
|------|------|--------|
| Hub feishu.ts | dispatchChat 加 sender 参数 | ~10 行 |
| Hub hub.ts | dispatchChat 转发 sender | ~5 行 |
| Hub types.ts | ChatOptions 加 sender 类型 | ~5 行 |
| 插件 index.ts | handleIncomingChat 注入 sender | ~10 行 |
| **总计** | | **~30 行代码** |

### 用户体验示例

```
用户: 明天早上8点提醒我交周报
AI:   ✅ 已设置提醒：明天 08:00 提醒你「交周报」

用户: 今天下午3点提醒我开会
AI:   ✅ 已设置提醒：今天 15:00 提醒你「开会」

用户: 每天早上9点提醒我看邮件
AI:   ✅ 已设置每日提醒：09:00 提醒你「看邮件」

--- 到时间后 ---
进宝: ⏰ 定时提醒：交周报
```

### 后续优化（Phase 2）

1. **提醒管理**：用户可以查看/取消已设置的提醒（`我的提醒`、`取消明天的提醒`）
2. **Hub 端定时器**：对于笔记本节点，升级为 Hub 端定时（方案 B），确保节点离线也能提醒
3. **重复提醒**：支持 cron 表达式（`每周一早上9点`）
4. **提醒确认**：提醒消息带交互按钮（稍后提醒/已完成）

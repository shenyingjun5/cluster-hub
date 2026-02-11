/**
 * cluster-hub 插件入口 v3
 *
 * 架构：插件持久化一切，控制台只做呈现。
 *
 * 职责：
 * - 持久化任务/聊天/节点事件到 ~/.openclaw/hub-data/
 * - 通过 context.broadcast 实时推送给控制台
 * - 注册 Gateway RPC 方法（供控制台/CLI/AI 工具调用）
 * - 注册 AI 工具（hub_status, hub_nodes, hub_send, hub_tasks）
 * - 注册 CLI 命令（openclaw hub status/nodes/send/register）
 * - 注册后台服务（WebSocket 连接 + 心跳）
 */

import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { HubClient } from './hub-client.js';
import { TaskStore, ChatStore, NodeEventStore } from './store.js';
import { setCredentials, setOwner, registerFeishuTools, hasCredentials } from './feishu-tools.js';
import type {
  HubPluginConfig, DEFAULT_CONFIG, ResultPayload, WSMessage,
  QueuedTask, ChatConfig, StoredTask, StoredChatMessage, StoredNodeEvent,
} from './types.js';

// ============================================================================
// 全局状态
// ============================================================================

let pluginApi: any;
let client: HubClient;
let taskStore: TaskStore;
let chatStore: ChatStore;
let nodeEventStore: NodeEventStore;
let taskQueue: TaskQueue;

/** 捕获的 Gateway broadcast 引用 — 用于推送事件给控制台 */
let gatewayBroadcast: ((event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void) | null = null;

/** 数据目录 */
const DATA_DIR = path.join(process.env.HOME || '/tmp', '.openclaw', 'hub-data');

// ============================================================================
// 广播辅助
// ============================================================================

function broadcast(event: string, payload: unknown): void {
  if (gatewayBroadcast) {
    try {
      gatewayBroadcast(event, payload, { dropIfSlow: true });
    } catch { /* 静默 */ }
  }
}

// ============================================================================
// Gateway RPC 调用（本地 WebSocket）
// ============================================================================

async function gatewayRpc(method: string, params: any, timeoutMs = 30_000): Promise<any> {
  const config = pluginApi.runtime.config.loadConfig();
  const port = config?.gateway?.port || 18789;
  const token = config?.gateway?.auth?.token;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const connectId = randomUUID();
  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let connected = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`Gateway RPC 超时 (${timeoutMs}ms): ${method}`));
      }
    }, timeoutMs);

    const settle = (err?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
      try { ws.close(); } catch { }
    };


    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'req', id: connectId, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'cli', version: '1.0.0', platform: 'node', mode: 'cli' },
          auth: { token },
        },
      }));
    };

    ws.onmessage = (event: any) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        if (msg.type === 'event') return;
        if (msg.type === 'res' && msg.id === connectId) {
          if (!msg.ok) { settle(new Error(`Gateway connect 失败: ${JSON.stringify(msg.payload)}`)); return; }
          connected = true;
          ws.send(JSON.stringify({ type: 'req', id: requestId, method, params }));
          return;
        }
        if (msg.type === 'res' && msg.id === requestId) {
          if (msg.ok) settle(undefined, msg.payload);
          else settle(new Error(msg.payload?.message || msg.payload?.error || `RPC 失败: ${method}`));
        }
      } catch (e: any) {
        settle(new Error(`解析响应失败: ${e.message}`));
      }
    };

    ws.onerror = (err: any) => settle(new Error(`WebSocket 错误: ${err.message || err}`));
    ws.onclose = () => { if (!settled) settle(new Error('WebSocket 连接关闭')); };
  });
}

// ============================================================================
// 本地任务执行（异步 fire-and-forget 模式）
// ============================================================================

/** 向 Gateway 发送 agent 请求，立即返回 runId + sessionKey（不等待完成） */
async function dispatchTaskToAgent(instruction: string): Promise<{ runId: string; sessionKey: string }> {
  const sessionKey = `agent:main:hub-task:${randomUUID()}`;
  const idempotencyKey = randomUUID();

  pluginApi.logger.info(`[cluster-hub] 派发任务: ${instruction.substring(0, 80)}`);

  const agentResult = await gatewayRpc('agent', {
    message: instruction,
    sessionKey,
    idempotencyKey,
    deliver: false,
    extraSystemPrompt: '你正在执行一个 Hub 集群任务。请直接完成任务并返回结果。',
  }, 15_000);

  return { runId: agentResult?.runId || idempotencyKey, sessionKey };
}

/** 后台等待 agent 完成，收集结果，清理 session */
async function waitAndCollectResult(runId: string, sessionKey: string, timeoutMs?: number): Promise<ResultPayload> {
  const timeout = timeoutMs || client.getConfig().taskTimeoutMs || 300_000;

  try {
    await gatewayRpc('agent.wait', { runId, timeoutMs: timeout }, timeout + 5_000);

    const history = await gatewayRpc('chat.history', { sessionKey, limit: 30 }, 10_000);
    const messages = history?.messages || [];

    const assistantMsgs = messages.filter((m: any) => m.role === 'assistant');
    let resultText = '';
    for (const msg of assistantMsgs) {
      if (typeof msg.content === 'string') {
        resultText += msg.content + '\n';
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) resultText += block.text + '\n';
        }
      }
    }

    gatewayRpc('sessions.delete', { key: sessionKey }, 5_000).catch(() => { });
    return { success: true, result: resultText.trim() || '(任务完成，无文本输出)' };
  } catch (err: any) {
    gatewayRpc('sessions.delete', { key: sessionKey }, 5_000).catch(() => { });
    return { success: false, error: err.message };
  }
}

/** 同步模式（兼容 sendTaskAndTrack 等需要 Promise<ResultPayload> 的调用方） */
async function executeTaskLocally(instruction: string, timeoutMs?: number): Promise<ResultPayload> {
  const { runId, sessionKey } = await dispatchTaskToAgent(instruction);
  return waitAndCollectResult(runId, sessionKey, timeoutMs);
}

// ============================================================================
// TaskQueue — 子节点任务队列（收到父节点下发的任务）
// ============================================================================

class TaskQueue {
  private maxConcurrent = 3;
  private queue: QueuedTask[] = [];
  /** 正在派发中（占用并发槽，brief） */
  private dispatching: Map<string, QueuedTask> = new Map();
  /** 已派发、正在后台等待完成（不占用并发槽） */
  private inflight: Map<string, QueuedTask> = new Map();
  private completed: QueuedTask[] = [];

  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, Math.min(n, 10));
  }

  /** 当前占用的并发槽数 */
  private get activeSlots(): number {
    return this.dispatching.size;
  }

  enqueue(taskId: string, fromNodeId: string, instruction: string, priority: 'high' | 'normal' | 'low' = 'normal'): void {
    const task: QueuedTask = {
      taskId, fromNodeId, instruction, priority,
      receivedAt: Date.now(),
      status: 'queued',
    };

    if (this.activeSlots < this.maxConcurrent) {
      this.startTask(task);
    } else {
      this.queue.push(task);
      pluginApi.logger.info(`[cluster-hub] 任务入队 ${taskId}, 位置=${this.queue.length}`);
      client.sendWS({
        type: 'task_ack' as any,
        id: taskId,
        to: fromNodeId,
        payload: { status: 'queued', position: this.queue.length },
      });
    }
  }

  private async startTask(task: QueuedTask): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    this.dispatching.set(task.taskId, task);

    client.sendWS({
      type: 'task_ack' as any,
      id: task.taskId,
      to: task.fromNodeId,
      payload: { status: 'running' },
    });

    pluginApi.logger.info(`[cluster-hub] 派发任务 ${task.taskId} (dispatching=${this.dispatching.size}, inflight=${this.inflight.size})`);

    try {
      // 1. 派发到 Gateway — 立即返回
      const { runId, sessionKey } = await dispatchTaskToAgent(task.instruction);
      task.sessionKey = sessionKey;

      // 2. 派发成功 → 移入 inflight，释放并发槽
      this.dispatching.delete(task.taskId);
      this.inflight.set(task.taskId, task);
      this.dequeue(); // 立即处理下一个排队任务

      // 3. 后台等待完成 + 回调（不占用并发槽）
      const result = await waitAndCollectResult(runId, sessionKey);
      task.status = result.success ? 'completed' : 'failed';
      task.result = result.result;
      task.error = result.error;
    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      // 如果派发阶段就失败了，需要从 dispatching 中移除
      this.dispatching.delete(task.taskId);
    }

    task.completedAt = Date.now();
    this.inflight.delete(task.taskId);
    this.completed.unshift(task);
    if (this.completed.length > 50) this.completed.pop();

    client.sendResult(task.taskId, task.fromNodeId, {
      success: task.status === 'completed',
      result: task.result,
      error: task.error,
    });

    pluginApi.logger.info(`[cluster-hub] 任务 ${task.taskId} ${task.status}, 耗时 ${Date.now() - (task.startedAt || 0)}ms`);
    // 任务完成后再次 dequeue，以防 dispatch 阶段有失败导致槽位提前释放
    this.dequeue();
  }

  private dequeue(): void {
    while (this.queue.length > 0 && this.activeSlots < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.startTask(next);
    }
  }

  cancel(taskId: string): boolean {
    const qIdx = this.queue.findIndex(t => t.taskId === taskId);
    if (qIdx >= 0) {
      const task = this.queue.splice(qIdx, 1)[0];
      task.status = 'cancelled';
      task.completedAt = Date.now();
      client.sendResult(task.taskId, task.fromNodeId, {
        success: false, error: '任务已被取消',
      });
      return true;
    }
    // 检查 dispatching 和 inflight 中的任务
    const running = this.dispatching.get(taskId) || this.inflight.get(taskId);
    if (running && running.sessionKey) {
      gatewayRpc('sessions.delete', { key: running.sessionKey }, 5_000).catch(() => { });
      return true;
    }
    return false;
  }

  getStatus() {
    return {
      maxConcurrent: this.maxConcurrent,
      queued: this.queue.length,
      dispatching: this.dispatching.size,
      inflight: this.inflight.size,
      running: this.dispatching.size + this.inflight.size,
      completed: this.completed.filter(t => t.status === 'completed').length,
      failed: this.completed.filter(t => t.status === 'failed').length,
      queuedTasks: this.queue.map(t => ({ taskId: t.taskId, instruction: t.instruction.substring(0, 100), receivedAt: t.receivedAt })),
      runningTasks: [...this.dispatching.values(), ...this.inflight.values()].map(t => ({ taskId: t.taskId, instruction: t.instruction.substring(0, 100), startedAt: t.startedAt })),
      recentCompleted: this.completed.slice(0, 10).map(t => ({ taskId: t.taskId, status: t.status, completedAt: t.completedAt })),
    };
  }
}

// ============================================================================
// 远程聊天 — 子节点侧处理
// ============================================================================

async function handleIncomingChat(msg: WSMessage): Promise<void> {
  const { content, config } = msg.payload || {};
  const fromNodeId = msg.from!;
  const chatId = msg.id;  // 保留原始 chatId 用于回复关联
  const whole = config?.whole ?? false;
  const autoRefreshMs = config?.autoRefreshMs ?? null;

  if (!content) return;

  pluginApi.logger.info(`[cluster-hub] 收到聊天 from ${fromNodeId}: ${(content as string).substring(0, 80)}`);

  try {
    const sessionKey = `hub-chat:${fromNodeId}`;
    const idempotencyKey = randomUUID();
    const agentResult = await gatewayRpc('agent', {
      message: content,
      sessionKey,
      idempotencyKey,
      deliver: false,
    }, 15_000);

    const runId = agentResult?.runId || idempotencyKey;
    let lastSentCount = 0;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    if (autoRefreshMs && autoRefreshMs > 0) {
      refreshTimer = setInterval(async () => {
        try {
          const history = await gatewayRpc('chat.history', { sessionKey, limit: 30 }, 10_000);
          const messages = history?.messages || [];
          if (messages.length > lastSentCount) {
            const newMsgs = messages.slice(lastSentCount);
            lastSentCount = messages.length;
            client.sendWS({
              type: 'chat' as any,
              id: randomUUID(),
              to: fromNodeId,
              payload: {
                role: 'delta',
                messages: formatMessages(newMsgs, whole),
                timestamp: Date.now(),
                done: false,
              },
            });
          }
        } catch { }
      }, autoRefreshMs);
    }

    try {
      await gatewayRpc('agent.wait', { runId, timeoutMs: 300_000 }, 305_000);
    } finally {
      if (refreshTimer) clearInterval(refreshTimer);
    }

    const history = await gatewayRpc('chat.history', { sessionKey, limit: 30 }, 10_000);
    const messages = history?.messages || [];

    client.sendWS({
      type: 'chat' as any,
      id: randomUUID(),
      to: fromNodeId,
      payload: {
        role: 'assistant',
        messages: formatMessages(messages, whole),
        replyTo: chatId,
        timestamp: Date.now(),
        done: true,
      },
    });

    pluginApi.logger.info(`[cluster-hub] 聊天回复完成 → ${fromNodeId}`);
  } catch (err: any) {
    pluginApi.logger.error(`[cluster-hub] 聊天处理失败: ${err.message}`);
    client.sendWS({
      type: 'chat' as any,
      id: randomUUID(),
      to: fromNodeId,
      payload: {
        role: 'assistant',
        content: `❌ 处理失败: ${err.message}`,
        replyTo: chatId,
        timestamp: Date.now(),
        done: true,
      },
    });
  }
}

function formatMessages(messages: any[], whole: boolean): any[] {
  return messages.map(msg => {
    if (!whole && Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: msg.content
          .filter((c: any) => c.type === 'text' && c.text)
          .map((c: any) => c.text)
          .join('\n'),
        timestamp: msg.timestamp,
      };
    }
    return { role: msg.role, content: msg.content, timestamp: msg.timestamp };
  });
}

// ============================================================================
// 任务发送 — 父节点向子节点下发
// ============================================================================

function resolveNodeName(nodeId: string): string | undefined {
  // 从 hub-client 缓存的节点列表中查找名称
  try {
    const status = client.getStatus();
    // 简单返回 undefined，让 store 自己处理
    return undefined;
  } catch { return undefined; }
}

function sendTaskAndTrack(nodeId: string, instruction: string): string {
  const taskId = randomUUID();

  if (isSelfNode(nodeId) && client.getConfig().selfTaskMode === 'local') {
    // 自发本地任务
    const task = taskStore.recordSent(taskId, nodeId, client.getConfig().nodeName, instruction, 'local');
    broadcast('hub.task.update', { task });

    // 异步执行
    executeTaskLocally(instruction).then(result => {
      const updated = taskStore.recordResult(taskId, result);
      if (updated) broadcast('hub.task.update', { task: updated });
    }).catch(err => {
      const updated = taskStore.recordResult(taskId, { success: false, error: err.message });
      if (updated) broadcast('hub.task.update', { task: updated });
    });

    return taskId;
  }

  // 远程任务
  const task = taskStore.recordSent(taskId, nodeId, resolveNodeName(nodeId), instruction, 'remote');
  broadcast('hub.task.update', { task });

  client.sendWS({
    type: 'task' as any,
    id: taskId,
    to: nodeId,
    payload: { task: instruction },
  });

  pluginApi.logger.info(`[cluster-hub] 任务已下发 ${taskId} → ${nodeId}`);
  return taskId;
}

function isSelfNode(nodeId: string): boolean {
  return nodeId === client.getConfig().nodeId;
}

// ============================================================================
// Hub 事件处理 — 持久化 + 广播
// ============================================================================

function handleTaskAck(msg: WSMessage): void {
  const taskId = msg.id;
  const status = msg.payload?.status;
  const update: Partial<StoredTask> = { status };
  if (status === 'queued') update.ackedAt = Date.now();
  if (status === 'running') { update.ackedAt = Date.now(); update.startedAt = Date.now(); }

  const task = taskStore.updateStatus(taskId, update);
  if (task) {
    pluginApi.logger.info(`[cluster-hub] 任务 ${taskId} ack: ${status}`);
    broadcast('hub.task.update', { task });
  }
}

function handleTaskResult(msg: WSMessage): void {
  const taskId = msg.id;
  const payload: ResultPayload = msg.payload || {};
  const task = taskStore.recordResult(taskId, payload);
  if (task) {
    pluginApi.logger.info(`[cluster-hub] 任务 ${taskId} 完成: ${task.status}`);
    broadcast('hub.task.update', { task });
  }
}

function handleChatReply(msg: WSMessage): void {
  const fromNodeId = msg.from!;
  const { messages: replyMsgs, role, done, content } = msg.payload || {};

  // 只在 done=true 时持久化最终回复
  if (done) {
    let text = '';
    if (replyMsgs && Array.isArray(replyMsgs)) {
      text = replyMsgs
        .filter((m: any) => m.role === 'assistant')
        .map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('\n');
    } else if (content) {
      text = typeof content === 'string' ? content : JSON.stringify(content);
    }

    if (text) {
      const message = chatStore.appendMessage(fromNodeId, { role: 'assistant', content: text });
      broadcast('hub.chat.message', { nodeId: fromNodeId, message });
    }
  }
}

function handleNodeEvent(action: string, payload: any): void {
  const nodeId = payload?.nodeId;
  if (!nodeId) return;

  let event: StoredNodeEvent['event'];
  if (action === 'node_online') event = 'online';
  else if (action === 'node_offline') event = 'offline';
  else if (action === 'child_registered') event = 'registered';
  else if (action === 'child_departed') event = 'departed';
  else return;

  const nodeEvent: StoredNodeEvent = {
    nodeId,
    nodeName: payload?.nodeName || payload?.name,
    event,
    timestamp: Date.now(),
  };
  nodeEventStore.record(nodeEvent);
  broadcast('hub.node.event', nodeEvent);
}

// ============================================================================
// 配置持久化
// ============================================================================

function resolveConfig(pluginConfig: any): HubPluginConfig {
  const defaults: HubPluginConfig = {
    hubUrl: 'https://openclaw-hub.hpplay.com.cn',
    capabilities: ['coding', 'shell'],
    heartbeatIntervalMs: 30000,
    reconnectIntervalMs: 5000,
    taskTimeoutMs: 300000,
    autoConnect: true,
    selfTaskMode: 'local',
  };
  return { ...defaults, ...pluginConfig };
}

async function persistConfig(): Promise<void> {
  try {
    const cfg = client.getConfig();
    const patchPath = 'plugins.entries.cluster-hub.config';
    const patchBody: any = {};
    if (cfg.hubUrl) patchBody.hubUrl = cfg.hubUrl;
    if (cfg.nodeId) patchBody.nodeId = cfg.nodeId;
    if (cfg.nodeName) patchBody.nodeName = cfg.nodeName;
    if (cfg.nodeAlias) patchBody.nodeAlias = cfg.nodeAlias;
    if (cfg.token) patchBody.token = cfg.token;
    if (cfg.clusterId) patchBody.clusterId = cfg.clusterId;
    if (cfg.parentId !== undefined) patchBody.parentId = cfg.parentId;
    patchBody.capabilities = cfg.capabilities;
    patchBody.selfTaskMode = cfg.selfTaskMode || 'local';

    const fullPatch = { plugins: { entries: { 'cluster-hub': { config: patchBody } } } };
    const ocConfig = pluginApi.runtime.config.loadConfig();
    const configPath = path.join(process.env.HOME || '/tmp', '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const json = JSON.parse(raw);
    deepMerge(json, fullPatch);
    fs.writeFileSync(configPath, JSON.stringify(json, null, 2));
    pluginApi.logger.info('[cluster-hub] 配置已持久化');
  } catch (err: any) {
    pluginApi.logger.error(`[cluster-hub] 持久化配置失败: ${err.message}`);
  }
}

function deepMerge(target: any, source: any): void {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

// ============================================================================
// 收到子节点任务
// ============================================================================

function handleIncomingTask(msg: WSMessage): void {
  const instruction = msg.payload?.task || msg.payload?.instruction || '';
  const fromNodeId = msg.from || '';
  const taskId = msg.id;
  const maxConcurrent = msg.payload?.config?.maxConcurrent;

  if (maxConcurrent) {
    taskQueue.setMaxConcurrent(maxConcurrent);
  }

  pluginApi.logger.info(`[cluster-hub] 收到任务 ${taskId} from ${fromNodeId}`);
  taskQueue.enqueue(taskId, fromNodeId, instruction, msg.payload?.priority || 'normal');
}

// ============================================================================
// 插件定义
// ============================================================================

const plugin = {
  id: 'cluster-hub',
  name: 'Cluster Hub',
  description: 'OpenClaw Hub 云端集群 — 跨网络节点注册、任务分发、实时通讯',
  configSchema: { type: 'object', additionalProperties: true },
  register(api: any) {
    pluginApi = api;
    const config = resolveConfig(api.pluginConfig);
    client = new HubClient(config, api.logger);
    taskQueue = new TaskQueue();

    // 初始化持久化存储
    taskStore = new TaskStore(DATA_DIR);
    chatStore = new ChatStore(DATA_DIR);
    nodeEventStore = new NodeEventStore(DATA_DIR);
    api.logger.info(`[cluster-hub] 数据目录: ${DATA_DIR}`);

    // Hub WS 事件 → 持久化 + 广播
    client.onTaskReceived = (msg) => handleIncomingTask(msg);
    client.on('task_ack', (msg) => handleTaskAck(msg));
    client.on('task_status', (msg) => handleTaskAck(msg)); // 复用 ack 处理
    client.on('task_cancel', (msg) => taskQueue.cancel(msg.id));
    client.on('result', (msg) => handleTaskResult(msg));
    client.on('chat', (msg) => {
      if (msg.payload?.role === 'user') {
        handleIncomingChat(msg);
      } else {
        handleChatReply(msg);
      }
    });

    // 节点状态事件 → 持久化 + 广播
    client.onNodeOnline = (nodeId: string) => {
      handleNodeEvent('node_online', { nodeId });
    };
    client.onNodeOffline = (nodeId: string) => {
      handleNodeEvent('node_offline', { nodeId });
    };

    // Hub 下发共享配置 → 注册飞书工具
    client.onSharedConfig = (config: any) => {
      api.logger.info(`[cluster-hub] 收到共享配置: ${JSON.stringify(Object.keys(config))}`);
      if (config.owner) {
        setOwner(config.owner);
      }
      if (config.feishu?.appId && config.feishu?.appSecret) {
        setCredentials(config.feishu);
        registerFeishuTools(api, api.logger);
      }
    };

    // ------------------------------------------------------------------
    // Gateway RPC 方法 — 每个 handler 都捕获 broadcast 引用
    // ------------------------------------------------------------------

    const captureBroadcast = (context: any) => {
      if (!gatewayBroadcast && context?.broadcast) {
        gatewayBroadcast = context.broadcast;
        api.logger.info('[cluster-hub] ✅ 已捕获 Gateway broadcast 引用');
      }
    };

    // hub.status — 获取整体状态
    api.registerGatewayMethod('hub.status', async ({ context, respond }: any) => {
      captureBroadcast(context);
      try {
        const status = client.getStatus();
        let nodes: any[] = [];
        if (status.registered) {
          nodes = await client.fetchNodes().catch(() => []);
        }
        respond(true, {
          ...status,
          selfTaskMode: client.getConfig().selfTaskMode || 'local',
          changeSeq: client.changeSeq,
          nodes,
          taskSummary: taskStore.summary(),
        });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.nodes — 获取节点列表
    api.registerGatewayMethod('hub.nodes', async ({ context, respond }: any) => {
      captureBroadcast(context);
      try {
        const nodes = await client.fetchNodes(true);
        respond(true, { nodes });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.node.get — 获取单个节点
    api.registerGatewayMethod('hub.node.get', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const node = await client.fetchNode(params?.nodeId);
        if (node) respond(true, { node });
        else respond(false, { message: 'Node not found' });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.node.update — 更新节点名称/别名
    api.registerGatewayMethod('hub.node.update', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId || client.getConfig().nodeId;
        if (!nodeId) { respond(false, { message: '未注册' }); return; }
        const body: any = {};
        if (params?.name) body.name = params.name;
        if (params?.alias) body.alias = params.alias;
        const data = await client.httpPatch(`/api/nodes/${nodeId}`, body);
        respond(true, data.data || data);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.tree — 获取树形结构
    api.registerGatewayMethod('hub.tree', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId || client.getConfig().nodeId;
        if (!nodeId) { respond(false, { message: '未注册' }); return; }
        const tree = await client.fetchTree(nodeId);
        respond(true, { tree });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.children — 获取子节点
    api.registerGatewayMethod('hub.children', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId || client.getConfig().nodeId;
        if (!nodeId) { respond(false, { message: '未注册' }); return; }
        const children = await client.fetchChildren(nodeId);
        respond(true, { children });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.clusters — 获取集群列表
    api.registerGatewayMethod('hub.clusters', async ({ context, respond }: any) => {
      captureBroadcast(context);
      try {
        const clusters = await client.fetchClusters();
        respond(true, { clusters });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.register — 注册节点
    api.registerGatewayMethod('hub.register', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const result = await client.register({
          id: params?.id,
          name: params?.name || client.getConfig().nodeName || 'OpenClaw Node',
          alias: params?.alias || client.getConfig().nodeAlias || `node-${Date.now()}`,
          parentId: params?.parentId ?? null,
          capabilities: params?.capabilities || client.getConfig().capabilities,
        });
        await persistConfig();
        if (client.getConfig().autoConnect) await client.connect();
        respond(true, result);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.register.child — 注册子节点
    api.registerGatewayMethod('hub.register.child', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const parentId = params?.parentId || client.getConfig().nodeId;
        if (!parentId) { respond(false, { message: '无父节点 ID' }); return; }
        const result = await client.registerChild({
          id: params?.id,
          name: params?.name,
          alias: params?.alias,
          parentId,
          capabilities: params?.capabilities || ['coding', 'shell'],
        });
        respond(true, result);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.invite-code.get — 获取邀请码
    api.registerGatewayMethod('hub.invite-code.get', async ({ context, respond }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = client.getConfig().nodeId;
        if (!nodeId) { respond(false, { message: '未注册' }); return; }
        const data = await client.httpGet(`/api/nodes/${nodeId}/invite-code`);
        respond(true, data.data || data);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.invite-code.set — 设置/刷新邀请码
    api.registerGatewayMethod('hub.invite-code.set', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = client.getConfig().nodeId;
        if (!nodeId) { respond(false, { message: '未注册' }); return; }
        const body = params?.code ? { code: params.code } : {};
        const data = await client.httpPost(`/api/nodes/${nodeId}/invite-code`, body);
        respond(true, data.data || data);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.shared-config.get — 获取共享配置
    api.registerGatewayMethod('hub.shared-config.get', async ({ context, respond }: any) => {
      captureBroadcast(context);
      try {
        const clusterId = client.getConfig().clusterId;
        if (!clusterId) { respond(false, { message: '未注册' }); return; }
        const data = await client.httpGet(`/api/clusters/${clusterId}/shared-config`);
        respond(true, data.data || data);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.shared-config.set — 设置共享配置（仅根节点）
    api.registerGatewayMethod('hub.shared-config.set', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const clusterId = client.getConfig().clusterId;
        if (!clusterId) { respond(false, { message: '未注册' }); return; }
        const data = await client.httpPut(`/api/clusters/${clusterId}/shared-config`, params || {});
        respond(true, data.data || data);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.unregister — 注销节点
    api.registerGatewayMethod('hub.unregister', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId || client.getConfig().nodeId;
        if (!nodeId) { respond(false, { message: '无节点 ID' }); return; }
        await client.unregister(nodeId);
        await persistConfig();
        respond(true, { ok: true });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.reparent — 变更父节点
    api.registerGatewayMethod('hub.reparent', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const result = await client.reparent(params?.nodeId, params?.newParentId ?? null);
        await persistConfig();
        respond(true, result);
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // ================================================================
    // 任务 RPC — hub.task.*
    // ================================================================

    // hub.task.send — 发送任务（异步）
    api.registerGatewayMethod('hub.task.send', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId;
        const instruction = params?.instruction;
        if (!nodeId || !instruction) {
          respond(false, { message: '需要 nodeId 和 instruction' });
          return;
        }
        const taskId = sendTaskAndTrack(nodeId, instruction);
        respond(true, { taskId });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.task.list — 获取任务列表
    api.registerGatewayMethod('hub.task.list', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const tasks = taskStore.list({
          nodeId: params?.nodeId,
          status: params?.status,
          limit: params?.limit,
        });
        respond(true, { tasks });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.task.get — 获取单个任务
    api.registerGatewayMethod('hub.task.get', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const task = taskStore.get(params?.taskId);
        if (task) respond(true, { task });
        else respond(false, { message: '任务不存在' });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.task.cancel — 取消任务
    api.registerGatewayMethod('hub.task.cancel', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const taskId = params?.taskId;
        if (!taskId) { respond(false, { message: '需要 taskId' }); return; }

        // 本地队列取消
        const localCancelled = taskQueue.cancel(taskId);

        // 远程取消（发 cancel 消息给子节点）
        const task = taskStore.get(taskId);
        if (task && task.source === 'remote' && (task.status === 'sent' || task.status === 'queued' || task.status === 'running')) {
          client.sendWS({
            type: 'task_cancel' as any,
            id: taskId,
            to: task.targetNodeId,
            payload: { reason: '用户取消' },
          });
          const updated = taskStore.updateStatus(taskId, { status: 'cancelled', completedAt: Date.now() });
          if (updated) {
            updated.durationMs = updated.completedAt! - updated.sentAt;
            broadcast('hub.task.update', { task: updated });
          }
        }

        respond(true, { cancelled: localCancelled || !!task });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.task.clear — 清理已完成任务
    api.registerGatewayMethod('hub.task.clear', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const cleared = taskStore.clearCompleted(params?.before);
        respond(true, { cleared });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.task.batch — 批量下发任务
    api.registerGatewayMethod('hub.task.batch', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const tasks = params?.tasks;
        if (!Array.isArray(tasks) || tasks.length === 0) {
          respond(false, { message: '需要 tasks 数组' }); return;
        }
        const results: any[] = [];
        for (const t of tasks) {
          if (!t.nodeId || !t.instruction) continue;
          try {
            const taskId = sendTaskAndTrack(t.nodeId, t.instruction);
            results.push({ nodeId: t.nodeId, taskId, ok: true });
          } catch (err: any) {
            results.push({ nodeId: t.nodeId, ok: false, error: err.message });
          }
        }
        respond(true, { results });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // ================================================================
    // 聊天 RPC — hub.chat.*
    // ================================================================

    // hub.chat.send — 发送聊天消息
    api.registerGatewayMethod('hub.chat.send', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId;
        const content = params?.content || params?.message;
        if (!nodeId || !content) {
          respond(false, { message: '需要 nodeId 和 content' });
          return;
        }

        // 持久化用户消息
        const userMsg = chatStore.appendMessage(nodeId, { role: 'user', content });
        broadcast('hub.chat.message', { nodeId, message: userMsg });

        // 发给子节点
        const msgId = randomUUID();
        const chatConfig: ChatConfig = {
          whole: params?.whole ?? false,
          autoRefreshMs: params?.autoRefreshMs ?? 2000,
        };

        client.sendWS({
          type: 'chat' as any,
          id: msgId,
          to: nodeId,
          payload: {
            role: 'user',
            content,
            timestamp: Date.now(),
            config: chatConfig,
          },
        });

        respond(true, { messageId: userMsg.id });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.chat.history — 获取聊天记录
    api.registerGatewayMethod('hub.chat.history', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId;
        if (!nodeId) { respond(false, { message: '需要 nodeId' }); return; }
        const messages = chatStore.getHistory(nodeId, params?.limit);
        respond(true, { messages });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.chat.list — 获取活跃聊天节点
    api.registerGatewayMethod('hub.chat.list', async ({ context, respond }: any) => {
      captureBroadcast(context);
      respond(true, { nodes: chatStore.getActiveNodes() });
    });

    // hub.chat.clear — 清除聊天记录
    api.registerGatewayMethod('hub.chat.clear', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId;
        if (!nodeId) { respond(false, { message: '需要 nodeId' }); return; }
        chatStore.clearHistory(nodeId);
        respond(true, { ok: true });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // ================================================================
    // 节点事件 RPC
    // ================================================================

    api.registerGatewayMethod('hub.node.events', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const events = nodeEventStore.list(params?.limit);
        respond(true, { events });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // ================================================================
    // 兼容旧 RPC（hub.send / hub.tasks / hub.messages 等）
    // ================================================================

    // hub.send — 兼容旧接口，转发到 hub.task.send
    api.registerGatewayMethod('hub.send', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const nodeId = params?.nodeId;
        const instruction = params?.instruction;
        if (!nodeId || !instruction) {
          respond(false, { message: '需要 nodeId 和 instruction' });
          return;
        }
        const taskId = sendTaskAndTrack(nodeId, instruction);
        respond(true, { taskId, status: 'sent' });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.send.sync — 自发本地同步
    api.registerGatewayMethod('hub.send.sync', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        if (!params?.nodeId || !params?.instruction) {
          respond(false, { message: '需要 nodeId 和 instruction' });
          return;
        }
        if (isSelfNode(params.nodeId) && client.getConfig().selfTaskMode === 'local') {
          const taskId = randomUUID();
          const task = taskStore.recordSent(taskId, params.nodeId, client.getConfig().nodeName, params.instruction, 'local');
          broadcast('hub.task.update', { task });

          const result = await executeTaskLocally(params.instruction, params?.timeoutMs);
          const updated = taskStore.recordResult(taskId, result);
          if (updated) broadcast('hub.task.update', { task: updated });

          respond(true, { result });
        } else {
          const taskId = sendTaskAndTrack(params.nodeId, params.instruction);
          respond(true, { taskId, status: 'sent', note: '远程任务异步执行' });
        }
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.tasks — 兼容旧接口
    api.registerGatewayMethod('hub.tasks', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        const tasks = taskStore.list({
          nodeId: params?.nodeId,
          limit: params?.limit || 50,
        });
        respond(true, {
          tasks,
          queue: taskQueue.getStatus(),
          summary: taskStore.summary(),
        });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.messages — 兼容旧接口
    api.registerGatewayMethod('hub.messages', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      const messages = client.getMessages(params?.nodeId || '');
      respond(true, { messages });
    });

    // hub.messages.clear — 兼容旧接口
    api.registerGatewayMethod('hub.messages.clear', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      client.clearMessages(params?.nodeId || '');
      respond(true, { ok: true });
    });

    // hub.config.get — 获取配置
    api.registerGatewayMethod('hub.config.get', async ({ context, respond }: any) => {
      captureBroadcast(context);
      const cfg = client.getConfig();
      respond(true, {
        config: {
          ...cfg,
          token: cfg.token ? `${cfg.token.substring(0, 20)}...` : undefined,
          adminKey: undefined,
        },
      });
    });

    // hub.config.set — 更新配置
    api.registerGatewayMethod('hub.config.set', async ({ context, respond, params }: any) => {
      captureBroadcast(context);
      try {
        client.updateConfig(params?.config || {});
        await persistConfig();
        respond(true, { ok: true });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.connect — 手动连接
    api.registerGatewayMethod('hub.connect', async ({ context, respond }: any) => {
      captureBroadcast(context);
      try {
        await client.connect();
        respond(true, { connected: client.isConnected() });
      } catch (err: any) {
        respond(false, { message: err.message });
      }
    });

    // hub.disconnect — 手动断开
    api.registerGatewayMethod('hub.disconnect', async ({ context, respond }: any) => {
      captureBroadcast(context);
      client.disconnect();
      respond(true, { ok: true });
    });

    // hub.ping — 检查连通性
    api.registerGatewayMethod('hub.ping', async ({ context, respond }: any) => {
      captureBroadcast(context);
      const ok = await client.checkConnection();
      respond(true, { ok });
    });

    // ------------------------------------------------------------------
    // AI 工具
    // ------------------------------------------------------------------

    api.registerTool({
      name: 'hub_status',
      description: '获取 Hub 集群状态 — 显示节点列表、在线状态、连接情况',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const status = client.getStatus();
        let nodesText = '';
        if (status.registered) {
          try {
            const nodes = await client.fetchNodes();
            nodesText = nodes.map(n => {
              const icon = n.online ? '🟢' : '⚫';
              return `${icon} ${n.name} (@${n.alias}) — ${n.capabilities.join(', ')}`;
            }).join('\n');
          } catch { nodesText = '(无法获取节点列表)'; }
        }
        const cfg = client.getConfig();
        const summary = taskStore.summary();
        const text = [
          `📡 Hub 集群状态`,
          ``,
          `连接: ${status.connected ? '✅ 已连接' : '❌ 未连接'}`,
          `注册: ${status.registered ? '✅ 已注册' : '❌ 未注册'}`,
          status.nodeId ? `节点 ID: ${status.nodeId}` : '',
          `自发任务: ${cfg.selfTaskMode === 'local' ? '🏠 本地模式' : '🌐 Hub 模式'}`,
          `任务统计: ${summary.running} 进行中, ${summary.completed} 已完成, ${summary.failed} 失败`,
          ``,
          nodesText ? `节点列表:\n${nodesText}` : '',
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text }], data: { status, summary } };
      },
    });

    api.registerTool({
      name: 'hub_nodes',
      description: '列出 Hub 集群所有节点详情',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const nodes = await client.fetchNodes(true);
        if (nodes.length === 0) return { content: [{ type: 'text', text: '暂无注册的节点' }] };
        const lines = nodes.map(n => {
          const icon = n.online ? '🟢' : '⚫';
          const parent = n.parentId ? `parent=${n.parentId}` : '根节点';
          return `${icon} **${n.name}** (@${n.alias})\n   ID: ${n.id} | ${parent} | 能力: ${n.capabilities.join(', ')} | 负载: ${n.load}%`;
        });
        return {
          content: [{ type: 'text', text: `Hub 节点 (${nodes.length}):\n\n${lines.join('\n\n')}` }],
          data: { nodes },
        };
      },
    });

    api.registerTool({
      name: 'hub_send',
      description: '给 Hub 集群中的节点发送指令（异步，不等结果）。自发本地任务同步返回结果。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '目标节点 ID 或别名' },
          instruction: { type: 'string', description: '要执行的指令/任务描述' },
        },
        required: ['nodeId', 'instruction'],
      },
      async execute(_id: string, params: { nodeId: string; instruction: string }) {
        if (!client.isRegistered()) {
          return { content: [{ type: 'text', text: '❌ Hub 未注册' }] };
        }
        try {
          if (isSelfNode(params.nodeId) && client.getConfig().selfTaskMode === 'local') {
            // 自发本地：记录到 store + 同步等结果
            const taskId = randomUUID();
            const task = taskStore.recordSent(taskId, params.nodeId, client.getConfig().nodeName, params.instruction, 'local');
            broadcast('hub.task.update', { task });

            const result = await executeTaskLocally(params.instruction);
            const updated = taskStore.recordResult(taskId, result);
            if (updated) broadcast('hub.task.update', { task: updated });

            const text = result.success
              ? `✅ 节点 ${params.nodeId} 返回 (本地):\n\n${result.result}`
              : `❌ 节点 ${params.nodeId} 执行失败 (本地):\n\n${result.error}`;
            return { content: [{ type: 'text', text }], data: { result, mode: 'local' } };
          }
          const taskId = sendTaskAndTrack(params.nodeId, params.instruction);
          return {
            content: [{ type: 'text', text: `✅ 任务已下发 → 节点 ${params.nodeId}\n\ntaskId: ${taskId}\n\n任务将异步执行，用 hub_tasks 查看进度。` }],
            data: { taskId, mode: 'async' },
          };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `❌ 发送失败: ${err.message}` }] };
        }
      },
    });

    api.registerTool({
      name: 'hub_tasks',
      description: '查看 Hub 集群的任务状态（排队/执行中/已完成）',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '目标节点 ID（可选）' },
        },
      },
      async execute(_id: string, params: { nodeId?: string }) {
        try {
          const tasks = taskStore.list({ nodeId: params?.nodeId, limit: 20 });
          const summary = taskStore.summary();
          const queueStatus = taskQueue.getStatus();

          const lines: string[] = [
            '📋 任务状态\n',
            `总计: ${summary.total} | 进行中: ${summary.running} | 完成: ${summary.completed} | 失败: ${summary.failed}`,
            `本地队列: ${queueStatus.running}/${queueStatus.maxConcurrent} 执行中, ${queueStatus.queued} 排队`,
            '',
          ];

          for (const t of tasks) {
            const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'running' ? '🔄' : '⏳';
            const duration = t.durationMs ? ` (${(t.durationMs / 1000).toFixed(1)}s)` : '';
            lines.push(`${icon} ${t.taskId.substring(0, 8)}: ${t.instruction.substring(0, 60)} [${t.status}]${duration}`);
          }

          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `❌ 查询失败: ${err.message}` }] };
        }
      },
    });

    api.registerTool({
      name: 'hub_wait_task',
      description: '等待指定 Hub 任务完成并返回结果。用于任务编排场景：下发任务后等待结果再继续。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID（hub_send 返回的 taskId）' },
          timeoutMs: { type: 'number', description: '超时毫秒数（默认 300000 = 5分钟）' },
        },
        required: ['taskId'],
      },
      async execute(_id: string, params: { taskId: string; timeoutMs?: number }) {
        const timeout = params.timeoutMs || 300_000;
        const startTime = Date.now();
        const pollInterval = 2000;

        while (Date.now() - startTime < timeout) {
          const task = taskStore.get(params.taskId);
          if (!task) {
            return { content: [{ type: 'text', text: `❌ 任务 ${params.taskId} 不存在` }] };
          }

          if (task.status === 'completed') {
            return {
              content: [{ type: 'text', text: `✅ 任务完成 (${((task.durationMs || 0) / 1000).toFixed(1)}s)\n\n${task.result || '(无文本输出)'}` }],
              data: { task },
            };
          }
          if (task.status === 'failed') {
            return {
              content: [{ type: 'text', text: `❌ 任务失败 (${((task.durationMs || 0) / 1000).toFixed(1)}s)\n\n${task.error || '未知错误'}` }],
              data: { task },
            };
          }
          if (task.status === 'cancelled') {
            return {
              content: [{ type: 'text', text: `⚠️ 任务已取消` }],
              data: { task },
            };
          }

          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        return {
          content: [{ type: 'text', text: `⏱️ 等待超时 (${(timeout / 1000).toFixed(0)}s)，任务仍在执行中。\n\n用 hub_tasks 稍后查看结果。` }],
        };
      },
    });

    api.registerTool({
      name: 'hub_batch_send',
      description: '批量向多个 Hub 节点下发任务（并行）。返回所有 taskId。用于任务编排场景：一次分发多个子任务。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '任务列表，每项包含 nodeId 和 instruction',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string', description: '目标节点 ID 或别名' },
                instruction: { type: 'string', description: '任务指令' },
              },
              required: ['nodeId', 'instruction'],
            },
          },
        },
        required: ['tasks'],
      },
      async execute(_id: string, params: { tasks: Array<{ nodeId: string; instruction: string }> }) {
        if (!client.isRegistered()) {
          return { content: [{ type: 'text', text: '❌ Hub 未注册' }] };
        }
        if (!params.tasks || params.tasks.length === 0) {
          return { content: [{ type: 'text', text: '❌ 任务列表为空' }] };
        }

        const results: Array<{ nodeId: string; taskId: string; instruction: string; mode: string }> = [];

        for (const t of params.tasks) {
          try {
            if (isSelfNode(t.nodeId) && client.getConfig().selfTaskMode === 'local') {
              const taskId = randomUUID();
              const task = taskStore.recordSent(taskId, t.nodeId, client.getConfig().nodeName, t.instruction, 'local');
              broadcast('hub.task.update', { task });
              // 异步执行，不等待
              executeTaskLocally(t.instruction).then(result => {
                const updated = taskStore.recordResult(taskId, result);
                if (updated) broadcast('hub.task.update', { task: updated });
              }).catch(err => {
                const updated = taskStore.recordResult(taskId, { success: false, error: err.message });
                if (updated) broadcast('hub.task.update', { task: updated });
              });
              results.push({ nodeId: t.nodeId, taskId, instruction: t.instruction.substring(0, 60), mode: 'local' });
            } else {
              const taskId = sendTaskAndTrack(t.nodeId, t.instruction);
              results.push({ nodeId: t.nodeId, taskId, instruction: t.instruction.substring(0, 60), mode: 'remote' });
            }
          } catch (err: any) {
            results.push({ nodeId: t.nodeId, taskId: `ERROR: ${err.message}`, instruction: t.instruction.substring(0, 60), mode: 'error' });
          }
        }

        const lines = results.map(r =>
          r.mode === 'error'
            ? `❌ → ${r.nodeId}: ${r.taskId}`
            : `✅ → ${r.nodeId}: taskId=${r.taskId.substring(0, 8)} (${r.mode})`
        );

        return {
          content: [{ type: 'text', text: `📦 批量下发 ${results.length} 个任务\n\n${lines.join('\n')}\n\n用 hub_wait_task 等待单个任务结果，或 hub_tasks 查看整体进度。` }],
          data: { results },
        };
      },
    });

    api.registerTool({
      name: 'hub_wait_all',
      description: '等待多个 Hub 任务全部完成并返回汇总结果。用于任务编排场景：批量下发后等全部结束。',
      parameters: {
        type: 'object',
        properties: {
          taskIds: {
            type: 'array',
            description: '任务 ID 列表',
            items: { type: 'string' },
          },
          timeoutMs: { type: 'number', description: '总超时毫秒数（默认 600000 = 10分钟）' },
        },
        required: ['taskIds'],
      },
      async execute(_id: string, params: { taskIds: string[]; timeoutMs?: number }) {
        const timeout = params.timeoutMs || 600_000;
        const startTime = Date.now();
        const pollInterval = 2000;
        const remaining = new Set(params.taskIds);

        while (remaining.size > 0 && Date.now() - startTime < timeout) {
          for (const taskId of [...remaining]) {
            const task = taskStore.get(taskId);
            if (!task) { remaining.delete(taskId); continue; }
            if (['completed', 'failed', 'cancelled', 'timeout'].includes(task.status)) {
              remaining.delete(taskId);
            }
          }
          if (remaining.size > 0) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
          }
        }

        // 汇总结果
        const results = params.taskIds.map(taskId => {
          const task = taskStore.get(taskId);
          if (!task) return { taskId: taskId.substring(0, 8), status: 'not_found', result: '' };
          return {
            taskId: taskId.substring(0, 8),
            nodeId: task.targetNodeId.substring(0, 8),
            nodeName: task.targetNodeName,
            status: task.status,
            duration: task.durationMs ? `${(task.durationMs / 1000).toFixed(1)}s` : '-',
            result: task.result?.substring(0, 200) || task.error?.substring(0, 200) || '',
          };
        });

        const succeeded = results.filter(r => r.status === 'completed').length;
        const failed = results.filter(r => r.status === 'failed').length;
        const timedOut = remaining.size;

        const lines: string[] = [
          `📊 批量任务汇总: ${succeeded} 成功, ${failed} 失败, ${timedOut} 超时\n`,
        ];

        for (const r of results) {
          const icon = r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'cancelled' ? '⚠️' : '⏳';
          lines.push(`${icon} [${r.taskId}] ${r.nodeName || r.nodeId || '?'} (${r.duration}) — ${r.status}`);
          if (r.result) lines.push(`   ${r.result}`);
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          data: { results, succeeded, failed, timedOut },
        };
      },
    });

    // ------------------------------------------------------------------
    // CLI 命令
    // ------------------------------------------------------------------

    api.registerCli(({ program }: any) => {
      const hub = program.command('hub').description('Hub 云端集群管理');

      hub.command('status')
        .description('查看 Hub 连接和集群状态')
        .action(async () => {
          const status = client.getStatus();
          const cfg = client.getConfig();
          const summary = taskStore.summary();
          console.log(`\n📡 Hub 集群状态\n`);
          console.log(`  连接:     ${status.connected ? '✅ 已连接' : '❌ 未连接'}`);
          console.log(`  注册:     ${status.registered ? '✅ 已注册' : '❌ 未注册'}`);
          if (status.nodeId) console.log(`  节点:     ${status.nodeId}`);
          console.log(`  自发任务: ${cfg.selfTaskMode === 'local' ? '🏠 本地模式' : '🌐 Hub 模式'}`);
          console.log(`  任务:     ${summary.running} 进行中, ${summary.completed} 完成, ${summary.failed} 失败`);

          if (status.registered) {
            try {
              const nodes = await client.fetchNodes();
              console.log(`\n  节点列表 (${nodes.length}):`);
              for (const n of nodes) {
                const icon = n.online ? '🟢' : '⚫';
                console.log(`    ${icon} ${n.name} (@${n.alias}) [${n.capabilities.join(',')}] load=${n.load}%`);
              }
            } catch { /* ignore */ }
          }
          console.log('');
        });

      hub.command('nodes')
        .description('列出所有节点')
        .action(async () => {
          const nodes = await client.fetchNodes(true);
          if (nodes.length === 0) { console.log('暂无节点'); return; }
          console.table(nodes.map(n => ({
            id: n.id, name: n.name, alias: `@${n.alias}`,
            online: n.online ? '✅' : '❌', parent: n.parentId || '(根)',
            load: `${n.load}%`, capabilities: n.capabilities.join(','),
          })));
        });

      hub.command('tree')
        .description('显示节点树形结构')
        .action(async () => {
          const nodeId = client.getConfig().nodeId;
          if (!nodeId) { console.log('未注册'); return; }
          const rootId = client.getConfig().clusterId || nodeId;
          const tree = await client.fetchTree(rootId);
          if (!tree) { console.log('无法获取'); return; }
          printTree(tree, '', true);
        });

      hub.command('register')
        .description('注册本节点到 Hub')
        .option('--name <name>', '节点名称')
        .option('--alias <alias>', '节点别名')
        .option('--parent <parentId>', '父节点 ID')
        .option('--invite <code>', '邀请码（加入已有集群时需要）')
        .action(async (opts: any) => {
          try {
            const result = await client.register({
              name: opts.name || client.getConfig().nodeName || 'OpenClaw Node',
              alias: opts.alias || client.getConfig().nodeAlias || `node-${Date.now()}`,
              parentId: opts.parent || null,
              inviteCode: opts.invite || undefined,
              capabilities: client.getConfig().capabilities,
            });
            await persistConfig();
            console.log(`✅ 注册成功! 节点 ID: ${result.nodeId}`);
            if (client.getConfig().autoConnect) {
              await client.connect();
              console.log(`  WebSocket: ${client.isConnected() ? '已连接' : '连接中...'}`);
            }
          } catch (err: any) {
            console.error(`❌ 注册失败: ${err.message}`);
          }
        });

      hub.command('unregister')
        .description('从 Hub 注销本节点')
        .option('--node <nodeId>', '指定节点 ID')
        .action(async (opts: any) => {
          const nodeId = opts.node || client.getConfig().nodeId;
          if (!nodeId) { console.error('❌ 没有节点 ID'); return; }
          try {
            await client.unregister(nodeId);
            await persistConfig();
            console.log('✅ 注销成功');
          } catch (err: any) {
            console.error(`❌ 注销失败: ${err.message}`);
          }
        });

      hub.command('send <nodeId> <instruction>')
        .description('给节点发送指令')
        .option('--timeout <ms>', '超时毫秒', '300000')
        .action(async (nodeId: string, instruction: string, opts: any) => {
          if (!client.isRegistered()) { console.error('❌ Hub 未注册'); return; }
          if (isSelfNode(nodeId) && client.getConfig().selfTaskMode === 'local') {
            console.log(`📤 本地执行: ${instruction}`);
            const taskId = randomUUID();
            taskStore.recordSent(taskId, nodeId, client.getConfig().nodeName, instruction, 'local');
            const result = await executeTaskLocally(instruction, parseInt(opts.timeout));
            taskStore.recordResult(taskId, result);
            console.log(result.success ? `✅ ${result.result}` : `❌ ${result.error}`);
          } else {
            const taskId = sendTaskAndTrack(nodeId, instruction);
            console.log(`✅ 任务已下发, taskId: ${taskId}`);
          }
        });

      hub.command('tasks')
        .description('查看任务列表')
        .option('--limit <n>', '数量', '20')
        .action(async (opts: any) => {
          const tasks = taskStore.list({ limit: parseInt(opts.limit) });
          if (tasks.length === 0) { console.log('暂无任务'); return; }
          console.table(tasks.map(t => ({
            id: t.taskId.substring(0, 8),
            target: t.targetNodeId.substring(0, 8),
            status: t.status,
            instruction: t.instruction.substring(0, 40),
            duration: t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : '-',
          })));
        });

      hub.command('connect').description('手动连接').action(async () => {
        await client.connect();
        console.log(client.isConnected() ? '✅ 已连接' : '⏳ 连接中...');
      });

      hub.command('disconnect').description('断开连接').action(() => {
        client.disconnect();
        console.log('✅ 已断开');
      });

      hub.command('invite')
        .description('查看或生成邀请码')
        .option('--new', '生成新邀请码')
        .option('--node <nodeId>', '指定节点 ID')
        .action(async (opts: any) => {
          const nodeId = opts.node || client.getConfig().nodeId;
          if (!nodeId) { console.error('❌ 没有节点 ID'); return; }
          try {
            if (opts.new) {
              const data = await client.httpPost(`/api/nodes/${nodeId}/invite-code`, {});
              const code = data.data?.inviteCode || data.inviteCode;
              console.log(`✅ 新邀请码: ${code}`);
              console.log(`\n子节点加入命令:`);
              console.log(`  openclaw hub register --parent ${nodeId} --invite ${code} --name "节点名" --alias "别名"`);
            } else {
              const data = await client.httpGet(`/api/nodes/${nodeId}/invite-code`);
              const code = data.data?.inviteCode || data.inviteCode;
              if (code) {
                console.log(`📋 当前邀请码: ${code}`);
                console.log(`\n子节点加入命令:`);
                console.log(`  openclaw hub register --parent ${nodeId} --invite ${code} --name "节点名" --alias "别名"`);
              } else {
                console.log('暂无邀请码，使用 openclaw hub invite --new 生成');
              }
            }
          } catch (err: any) {
            console.error(`❌ 失败: ${err.message}`);
          }
        });
    }, { commands: ['hub'] });

    // ------------------------------------------------------------------
    // 后台服务
    // ------------------------------------------------------------------

    api.registerService({
      id: 'cluster-hub-ws',
      start: async () => {
        try {
          const port = pluginApi.runtime.config.loadConfig()?.gateway?.port || 18789;
          api.logger.info(`[cluster-hub] Gateway RPC: ws://127.0.0.1:${port}`);
        } catch (err: any) {
          api.logger.warn(`[cluster-hub] Gateway 配置读取失败: ${err.message}`);
        }

        if (client.isRegistered() && client.getConfig().autoConnect) {
          api.logger.info('[cluster-hub] 后台服务启动，自动连接 Hub...');
          setTimeout(() => {
            client.connect().catch((err: any) => {
              api.logger.error(`[cluster-hub] 自动连接失败: ${err.message}`);
            });
          }, 2000);
        } else {
          api.logger.info('[cluster-hub] 后台服务启动（未注册或 autoConnect=false）');
        }
      },
      stop: () => {
        api.logger.info('[cluster-hub] 后台服务停止，写盘...');
        taskStore?.flush();
        chatStore?.flush();
        nodeEventStore?.flush();
        client.disconnect();
      },
    });
  },
};

// ============================================================================
// 辅助函数
// ============================================================================

function printTree(node: any, prefix: string, isLast: boolean): void {
  const icon = node.online ? '🟢' : '⚫';
  const connector = isLast ? '└── ' : '├── ';
  console.log(`${prefix}${connector}${icon} ${node.name} (@${node.alias})`);
  const children = node.children || [];
  for (let i = 0; i < children.length; i++) {
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    printTree(children[i], childPrefix, i === children.length - 1);
  }
}

export default plugin;

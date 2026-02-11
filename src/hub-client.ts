/**
 * Hub WebSocket + HTTP 客户端
 */

import { randomUUID } from 'crypto';
import type {
  HubPluginConfig,
  HubNode,
  HubCluster,
  HubTreeNode,
  RegisterRequest,
  RegisterResponse,
  WSMessage,
  ResultPayload,
  PendingTask,
  InteractiveMessage,
} from './types.js';

type PluginLogger = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export class HubClient {
  private ws: any = null; // WebSocket instance
  private config: HubPluginConfig;
  private logger: PluginLogger;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private intentionallyClosed = false;

  // 缓存
  private nodesCache: HubNode[] = [];
  private nodesCacheTime = 0;
  private readonly CACHE_TTL_MS = 15_000;

  // 变更序号（节点上下线、注册等事件递增，供控制台判断是否需要全量刷新）
  private _changeSeq = 0;
  get changeSeq(): number { return this._changeSeq; }

  // 任务追踪
  private pendingTasks: Map<string, PendingTask> = new Map();
  // 指令交互消息（nodeId → messages）
  private nodeMessages: Map<string, InteractiveMessage[]> = new Map();

  // 事件回调
  public onTaskReceived?: (task: WSMessage) => void;
  public onNodeOnline?: (nodeId: string) => void;
  public onNodeOffline?: (nodeId: string) => void;
  public onConnected?: () => void;
  public onDisconnected?: () => void;

  // 通用事件监听
  private eventListeners: Map<string, Array<(msg: WSMessage) => void>> = new Map();

  on(event: string, handler: (msg: WSMessage) => void): void {
    const listeners = this.eventListeners.get(event) || [];
    listeners.push(handler);
    this.eventListeners.set(event, listeners);
  }

  off(event: string, handler: (msg: WSMessage) => void): void {
    const listeners = this.eventListeners.get(event) || [];
    this.eventListeners.set(event, listeners.filter(l => l !== handler));
  }

  private emit(event: string, msg: WSMessage): void {
    const listeners = this.eventListeners.get(event) || [];
    for (const handler of listeners) {
      try { handler(msg); } catch (err: any) {
        this.logger.error(`[cluster-hub] 事件处理错误 (${event}): ${err.message}`);
      }
    }
  }

  constructor(config: HubPluginConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
  }

  // ========================================================================
  // 配置
  // ========================================================================

  getConfig(): HubPluginConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<HubPluginConfig>): void {
    Object.assign(this.config, patch);
  }

  isRegistered(): boolean {
    return !!(this.config.nodeId && this.config.token);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ========================================================================
  // HTTP API
  // ========================================================================

  async httpGet(path: string): Promise<any> {
    const url = `${this.config.hubUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    if (this.config.adminKey) {
      headers['X-Admin-Key'] = this.config.adminKey;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Hub HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }

  async httpPost(path: string, body: any): Promise<any> {
    const url = `${this.config.hubUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.adminKey) {
      headers['X-Admin-Key'] = this.config.adminKey;
    }
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hub HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  async httpPatch(path: string, body: any): Promise<any> {
    const url = `${this.config.hubUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    if (this.config.adminKey) {
      headers['X-Admin-Key'] = this.config.adminKey;
    }
    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hub HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async httpDelete(path: string): Promise<any> {
    const url = `${this.config.hubUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    if (this.config.adminKey) {
      headers['X-Admin-Key'] = this.config.adminKey;
    }
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hub HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ========================================================================
  // 节点注册
  // ========================================================================

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const data = await this.httpPost('/api/nodes/register', req);
    // Hub 返回 { success: true, data: { nodeId, clusterId, token, ... } }
    const resp = data.data || data;
    if (!data.success && !resp.nodeId) {
      throw new Error(data.error || 'Registration failed');
    }
    const result: RegisterResponse = {
      nodeId: resp.nodeId,
      clusterId: resp.clusterId,
      parentId: resp.parentId ?? null,
      depth: resp.depth ?? 0,
      token: resp.token,
    };

    // 更新本地配置
    this.config.nodeId = result.nodeId;
    this.config.clusterId = result.clusterId;
    this.config.parentId = result.parentId;
    this.config.token = result.token;

    this.logger.info(`[cluster-hub] 注册成功: nodeId=${result.nodeId}, cluster=${result.clusterId}`);
    return result;
  }

  async registerChild(req: RegisterRequest): Promise<RegisterResponse> {
    // 子节点注册（parentId 由调用者设置）
    const data = await this.httpPost('/api/nodes/register', req);
    const resp = data.data || data;
    if (!data.success && !resp.nodeId) {
      throw new Error(data.error || 'Child registration failed');
    }
    return {
      nodeId: resp.nodeId,
      clusterId: resp.clusterId,
      parentId: resp.parentId ?? null,
      depth: resp.depth ?? 0,
      token: resp.token,
    };
  }

  async unregister(nodeId: string): Promise<void> {
    await this.httpDelete(`/api/nodes/${nodeId}`);
    if (nodeId === this.config.nodeId) {
      this.config.nodeId = undefined;
      this.config.token = undefined;
      this.config.clusterId = undefined;
      this.config.parentId = undefined;
      this.disconnect();
    }
    this.logger.info(`[cluster-hub] 节点已注销: ${nodeId}`);
  }

  async reparent(nodeId: string, newParentId: string | null): Promise<any> {
    const data = await this.httpPatch(`/api/nodes/${nodeId}/parent`, {
      newParentId,
    });
    if (!data.success) {
      throw new Error(data.error || 'Reparent failed');
    }
    const resp = data.data || data;
    // 如果是自己的 reparent，更新 token
    if (nodeId === this.config.nodeId && resp.token) {
      this.config.token = resp.token;
      this.config.parentId = newParentId;
      this.config.clusterId = resp.clusterId;
    }
    return resp;
  }

  // ========================================================================
  // 节点查询
  // ========================================================================

  async fetchNodes(force = false): Promise<HubNode[]> {
    const now = Date.now();
    if (!force && this.nodesCache.length > 0 && (now - this.nodesCacheTime) < this.CACHE_TTL_MS) {
      return this.nodesCache;
    }
    const data = await this.httpGet('/api/nodes');
    this.nodesCache = data.nodes || [];
    this.nodesCacheTime = now;
    return this.nodesCache;
  }

  async fetchNode(nodeId: string): Promise<HubNode | null> {
    try {
      const data = await this.httpGet(`/api/nodes/${nodeId}`);
      return data.data || data || null;
    } catch {
      return null;
    }
  }

  async fetchChildren(nodeId: string): Promise<HubNode[]> {
    const data = await this.httpGet(`/api/nodes/${nodeId}/children`);
    return data.data || [];
  }

  async fetchTree(nodeId: string): Promise<HubTreeNode | null> {
    try {
      const data = await this.httpGet(`/api/nodes/${nodeId}/tree`);
      return data.data || null;
    } catch {
      return null;
    }
  }

  async fetchClusters(): Promise<HubCluster[]> {
    const data = await this.httpGet('/api/clusters');
    return data.data || [];
  }

  getCachedNodes(): HubNode[] {
    return [...this.nodesCache];
  }

  // ========================================================================
  // WebSocket 连接
  // ========================================================================

  async connect(): Promise<void> {
    if (!this.config.token) {
      this.logger.warn('[cluster-hub] 无 Token，无法连接 WebSocket');
      return;
    }
    if (this.connected) {
      this.logger.debug?.('[cluster-hub] 已连接，跳过');
      return;
    }

    this.intentionallyClosed = false;

    const wsUrl = this.config.hubUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      + `/ws?token=${encodeURIComponent(this.config.token)}`;

    this.logger.info(`[cluster-hub] 连接 WebSocket: ${this.config.hubUrl}`);

    try {
      // 使用原生 WebSocket（Node.js 22+ 内置）
      const WebSocketImpl = typeof WebSocket !== 'undefined'
        ? WebSocket
        : (await import('ws')).default;

      this.ws = new WebSocketImpl(wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        this.logger.info('[cluster-hub] WebSocket 已连接');
        this.startHeartbeat();
        this.onConnected?.();
      };

      this.ws.onmessage = (event: any) => {
        try {
          const data = typeof event.data === 'string' ? event.data : event.data.toString();
          const msg: WSMessage = JSON.parse(data);
          this.handleMessage(msg);
        } catch (err: any) {
          this.logger.error(`[cluster-hub] 解析消息失败: ${err.message}`);
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.stopHeartbeat();
        this.logger.info('[cluster-hub] WebSocket 断开');
        this.onDisconnected?.();

        if (!this.intentionallyClosed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err: any) => {
        this.logger.error(`[cluster-hub] WebSocket 错误: ${err.message || err}`);
      };
    } catch (err: any) {
      this.logger.error(`[cluster-hub] 连接失败: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    if (this.reconnectTimer) return;

    const ms = this.config.reconnectIntervalMs;
    this.logger.info(`[cluster-hub] ${ms}ms 后重连...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, ms);
  }

  // ========================================================================
  // 心跳
  // ========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    this.sendWS({
      type: 'heartbeat',
      id: randomUUID(),
      payload: {
        load: 0, // TODO: 获取实际负载
        activeTasks: this.pendingTasks.size,
      },
    });
  }

  // ========================================================================
  // 消息收发
  // ========================================================================

  sendWS(msg: WSMessage): void {
    if (!this.ws || !this.connected) {
      this.logger.warn('[cluster-hub] WebSocket 未连接，无法发送');
      return;
    }
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err: any) {
      this.logger.error(`[cluster-hub] 发送失败: ${err.message}`);
    }
  }

  private handleMessage(msg: WSMessage): void {
    switch (msg.type) {
      case 'task':
        this.handleIncomingTask(msg);
        break;
      case 'result':
        this.handleResult(msg);
        break;
      case 'task_ack':
        this.emit('task_ack', msg);
        break;
      case 'task_status':
        this.emit('task_status', msg);
        break;
      case 'task_cancel':
        this.emit('task_cancel', msg);
        break;
      case 'chat':
        this.emit('chat', msg);
        break;
      case 'direct':
        this.handleDirect(msg);
        break;
      case 'broadcast':
        this.handleBroadcast(msg);
        break;
      case 'heartbeat':
        // 心跳确认，忽略
        break;
      default:
        this.logger.debug?.(`[cluster-hub] 未知消息类型: ${msg.type}`);
    }
  }

  private handleIncomingTask(msg: WSMessage): void {
    this.logger.info(`[cluster-hub] 收到任务: ${msg.id} from ${msg.from}`);
    this.onTaskReceived?.(msg);
  }

  private handleResult(msg: WSMessage): void {
    const taskId = msg.id;
    
    // 通知 TaskTracker（v2 异步模式）
    this.emit('result', msg);
    
    // 兼容旧的同步等待模式（pendingTasks）
    const pending = this.pendingTasks.get(taskId);
    if (!pending) {
      this.logger.debug?.(`[cluster-hub] 收到任务结果: ${taskId} (异步模式)`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTasks.delete(taskId);

    const result: ResultPayload = msg.payload || {};
    this.logger.info(`[cluster-hub] 任务完成: ${taskId}, success=${result.success}`);

    // 更新消息状态
    const messages = this.nodeMessages.get(pending.nodeId) || [];
    const assistantMsg: InteractiveMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: result.success ? (result.result || '(无返回内容)') : (result.error || '任务失败'),
      timestamp: Date.now(),
      status: result.success ? 'completed' : 'failed',
      taskId,
    };
    messages.push(assistantMsg);
    this.nodeMessages.set(pending.nodeId, messages);

    pending.resolve(result);
  }

  private handleDirect(msg: WSMessage): void {
    if (msg.payload?.action === 'connected') {
      this.logger.info(`[cluster-hub] 连接确认: nodeId=${msg.payload.nodeId}`);
    }
  }

  private handleBroadcast(msg: WSMessage): void {
    if (msg.channel === 'system') {
      const action = msg.payload?.action;
      if (action === 'node_online') {
        const nodeId = msg.payload?.node?.id;
        if (nodeId) {
          this.logger.info(`[cluster-hub] 节点上线: ${nodeId}`);
          this.nodesCache = [];
          this._changeSeq++;
          this.onNodeOnline?.(nodeId);
        }
      } else if (action === 'node_offline') {
        const nodeId = msg.payload?.nodeId;
        if (nodeId) {
          this.logger.info(`[cluster-hub] 节点离线: ${nodeId}`);
          this.nodesCache = [];
          this._changeSeq++;
          this.onNodeOffline?.(nodeId);
        }
      } else if (['child_registered', 'child_unregistered', 'child_departed', 'child_arrived', 'reparented'].includes(action)) {
        this.logger.info(`[cluster-hub] 集群变更: ${action}`);
        this.nodesCache = [];
        this._changeSeq++;
      }
    }
  }

  // ========================================================================
  // 任务发送
  // ========================================================================

  /**
   * 给指定节点发送指令，返回 Promise 等待结果
   */
  sendTask(nodeId: string, instruction: string, timeoutMs?: number): Promise<ResultPayload> {
    const taskId = randomUUID();
    const timeout = timeoutMs || this.config.taskTimeoutMs;

    // 记录用户消息
    const messages = this.nodeMessages.get(nodeId) || [];
    messages.push({
      id: randomUUID(),
      role: 'user',
      content: instruction,
      timestamp: Date.now(),
      status: 'sending',
      taskId,
    });
    this.nodeMessages.set(nodeId, messages);

    return new Promise<ResultPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        // 更新消息状态
        const msgs = this.nodeMessages.get(nodeId) || [];
        msgs.push({
          id: randomUUID(),
          role: 'assistant',
          content: '任务超时',
          timestamp: Date.now(),
          status: 'timeout',
          taskId,
        });
        this.nodeMessages.set(nodeId, msgs);
        reject(new Error(`Task ${taskId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingTasks.set(taskId, {
        taskId,
        nodeId,
        instruction,
        createdAt: Date.now(),
        timeoutMs: timeout,
        resolve,
        reject,
        timer,
      });

      this.sendWS({
        type: 'task',
        id: taskId,
        to: nodeId,
        payload: {
          task: instruction,
        },
      });

      // 更新发送状态
      const last = messages[messages.length - 1];
      if (last) last.status = 'running';
    });
  }

  /**
   * 给指定节点发送指令（fire-and-forget，不等结果），返回 taskId
   */
  sendTaskAsync(nodeId: string, instruction: string): string {
    const taskId = randomUUID();

    const messages = this.nodeMessages.get(nodeId) || [];
    messages.push({
      id: randomUUID(),
      role: 'user',
      content: instruction,
      timestamp: Date.now(),
      status: 'running',
      taskId,
    });
    this.nodeMessages.set(nodeId, messages);

    // 注册等待（超时后自动清理）
    const timer = setTimeout(() => {
      this.pendingTasks.delete(taskId);
    }, this.config.taskTimeoutMs);

    this.pendingTasks.set(taskId, {
      taskId,
      nodeId,
      instruction,
      createdAt: Date.now(),
      timeoutMs: this.config.taskTimeoutMs,
      resolve: () => {},
      reject: () => {},
      timer,
    });

    this.sendWS({
      type: 'task',
      id: taskId,
      to: nodeId,
      payload: { task: instruction },
    });

    return taskId;
  }

  /**
   * 发送 result 回给任务发起者
   */
  sendResult(taskId: string, toNodeId: string, result: ResultPayload): void {
    this.sendWS({
      type: 'result',
      id: taskId,
      to: toNodeId,
      payload: result,
    });
  }

  // ========================================================================
  // 消息管理
  // ========================================================================

  getMessages(nodeId: string): InteractiveMessage[] {
    return this.nodeMessages.get(nodeId) || [];
  }

  clearMessages(nodeId: string): void {
    this.nodeMessages.delete(nodeId);
  }

  getPendingTasks(): Map<string, PendingTask> {
    return new Map(this.pendingTasks);
  }

  // ========================================================================
  // 健康检查
  // ========================================================================

  async checkConnection(): Promise<boolean> {
    try {
      const data = await this.httpGet('/');
      return data?.status === 'running';
    } catch {
      return false;
    }
  }

  getStatus(): {
    registered: boolean;
    connected: boolean;
    nodeId: string | null;
    clusterId: string | null;
    parentId: string | null;
    pendingTasks: number;
    cachedNodes: number;
  } {
    return {
      registered: this.isRegistered(),
      connected: this.connected,
      nodeId: this.config.nodeId || null,
      clusterId: this.config.clusterId || null,
      parentId: this.config.parentId ?? null,
      pendingTasks: this.pendingTasks.size,
      cachedNodes: this.nodesCache.length,
    };
  }
}

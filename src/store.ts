/**
 * 持久化存储 — TaskStore + ChatStore
 *
 * 核心原则：插件持久化一切，控制台只做呈现。
 * 数据目录: ~/.openclaw/hub-data/
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { StoredTask, StoredChatMessage, StoredNodeEvent, ResultPayload } from './types.js';

// ============================================================================
// TaskStore — 任务持久化
// ============================================================================

export class TaskStore {
  private tasks: StoredTask[] = [];
  private dataDir: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private maxHistory = 200;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.load();
  }

  /** 记录发送任务 */
  recordSent(
    taskId: string,
    targetNodeId: string,
    targetNodeName: string | undefined,
    instruction: string,
    source: 'local' | 'remote',
  ): StoredTask {
    const task: StoredTask = {
      taskId,
      targetNodeId,
      targetNodeName,
      instruction,
      source,
      status: 'sent',
      sentAt: Date.now(),
    };
    this.tasks.unshift(task);
    this.trim();
    this.scheduleSave();
    return task;
  }

  /** 更新任务状态（中间态：queued/running） */
  updateStatus(taskId: string, update: Partial<StoredTask>): StoredTask | null {
    const task = this.findTask(taskId);
    if (!task) return null;
    Object.assign(task, update);
    this.scheduleSave();
    return task;
  }

  /** 记录最终结果 */
  recordResult(taskId: string, payload: ResultPayload): StoredTask | null {
    const task = this.findTask(taskId);
    if (!task) return null;
    task.status = payload.success ? 'completed' : 'failed';
    task.completedAt = Date.now();
    task.result = payload.result;
    task.error = payload.error;
    task.durationMs = task.completedAt - task.sentAt;
    this.scheduleSave();
    return task;
  }

  /** 查询任务列表 */
  list(opts?: { nodeId?: string; status?: string; limit?: number }): StoredTask[] {
    let result = this.tasks;
    if (opts?.nodeId) result = result.filter(t => t.targetNodeId === opts.nodeId);
    if (opts?.status) result = result.filter(t => t.status === opts.status);
    return opts?.limit ? result.slice(0, opts.limit) : result;
  }

  /** 获取单个任务 */
  get(taskId: string): StoredTask | null {
    return this.findTask(taskId) || null;
  }

  /** 清理已完成的任务 */
  clearCompleted(before?: number): number {
    const cutoff = before || Date.now();
    const original = this.tasks.length;
    this.tasks = this.tasks.filter(t => {
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
        return (t.completedAt || 0) > cutoff;
      }
      return true;
    });
    const cleared = original - this.tasks.length;
    if (cleared > 0) this.scheduleSave();
    return cleared;
  }

  /** 获取摘要统计 */
  summary(): { total: number; running: number; completed: number; failed: number } {
    return {
      total: this.tasks.length,
      running: this.tasks.filter(t => t.status === 'sent' || t.status === 'queued' || t.status === 'running').length,
      completed: this.tasks.filter(t => t.status === 'completed').length,
      failed: this.tasks.filter(t => t.status === 'failed').length,
    };
  }

  private findTask(taskId: string): StoredTask | undefined {
    return this.tasks.find(t => t.taskId === taskId);
  }

  private trim(): void {
    if (this.tasks.length > this.maxHistory) {
      this.tasks = this.tasks.slice(0, this.maxHistory);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  private save(): void {
    try {
      const filePath = path.join(this.dataDir, 'tasks.json');
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        tasks: this.tasks,
      }, null, 2));
    } catch (err) {
      // logger 在外部，此处静默
    }
  }

  private load(): void {
    try {
      const filePath = path.join(this.dataDir, 'tasks.json');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      this.tasks = [];
    }
  }

  /** 强制立即写盘（关闭时调用） */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }
}

// ============================================================================
// ChatStore — 聊天持久化
// ============================================================================

export class ChatStore {
  private chats: Map<string, StoredChatMessage[]> = new Map();
  private dataDir: string;
  private saveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private maxHistory = 500;

  constructor(dataDir: string) {
    this.dataDir = path.join(dataDir, 'chats');
    this.loadAll();
  }

  /** 追加消息 */
  appendMessage(nodeId: string, msg: Omit<StoredChatMessage, 'id' | 'timestamp' | 'nodeId'>): StoredChatMessage {
    const message: StoredChatMessage = {
      id: randomUUID(),
      nodeId,
      role: msg.role,
      content: msg.content,
      timestamp: Date.now(),
    };
    const history = this.chats.get(nodeId) || [];
    history.push(message);
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }
    this.chats.set(nodeId, history);
    this.scheduleSave(nodeId);
    return message;
  }

  /** 获取聊天历史 */
  getHistory(nodeId: string, limit?: number): StoredChatMessage[] {
    const history = this.chats.get(nodeId) || [];
    return limit ? history.slice(-limit) : history;
  }

  /** 获取有聊天记录的节点列表 */
  getActiveNodes(): string[] {
    return Array.from(this.chats.keys()).filter(k => {
      const msgs = this.chats.get(k);
      return msgs && msgs.length > 0;
    });
  }

  /** 清除某节点的聊天记录 */
  clearHistory(nodeId: string): void {
    this.chats.delete(nodeId);
    // 删除文件
    try {
      const filePath = path.join(this.dataDir, `${nodeId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  private scheduleSave(nodeId: string): void {
    if (this.saveTimers.has(nodeId)) return;
    this.saveTimers.set(nodeId, setTimeout(() => {
      this.saveTimers.delete(nodeId);
      this.saveNode(nodeId);
    }, 1000));
  }

  private saveNode(nodeId: string): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const filePath = path.join(this.dataDir, `${nodeId}.json`);
      const messages = this.chats.get(nodeId) || [];
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        nodeId,
        updatedAt: Date.now(),
        messages,
      }, null, 2));
    } catch { /* ignore */ }
  }

  private loadAll(): void {
    try {
      if (!fs.existsSync(this.dataDir)) return;
      const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.dataDir, file), 'utf-8');
          const data = JSON.parse(raw);
          if (data.nodeId && Array.isArray(data.messages)) {
            this.chats.set(data.nodeId, data.messages);
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* ignore */ }
  }

  /** 强制立即写盘 */
  flush(): void {
    for (const [nodeId, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.saveNode(nodeId);
    }
    this.saveTimers.clear();
  }
}

// ============================================================================
// NodeEventStore — 节点事件记录
// ============================================================================

export class NodeEventStore {
  private events: StoredNodeEvent[] = [];
  private dataDir: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private maxHistory = 200;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.load();
  }

  /** 记录节点事件 */
  record(event: StoredNodeEvent): void {
    this.events.unshift(event);
    if (this.events.length > this.maxHistory) {
      this.events = this.events.slice(0, this.maxHistory);
    }
    this.scheduleSave();
  }

  /** 获取事件列表 */
  list(limit?: number): StoredNodeEvent[] {
    return limit ? this.events.slice(0, limit) : this.events;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  private save(): void {
    try {
      const filePath = path.join(this.dataDir, 'node-events.json');
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        events: this.events,
      }, null, 2));
    } catch { /* ignore */ }
  }

  private load(): void {
    try {
      const filePath = path.join(this.dataDir, 'node-events.json');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      this.events = Array.isArray(data.events) ? data.events : [];
    } catch {
      this.events = [];
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }
}

import "reflect-metadata";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, sep, resolve, dirname } from "node:path";
import { unzip } from "fflate";
import { WebSocket } from "ws";
import {
  Plugin,
  pluginManager,
  type PluginSetupContext,
} from "@myfinal/plugin-runtime";

import { PKG_VERSION } from "./version.js";
import {
  type PluginConfig,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
} from "./config.js";
import {
  type DevSession,
  type GlobalWssEntry,
} from "./types.js";
import {
  isAuthMsg,
  isPushBundleMsg,
  safePluginName,
  send,
  getPluginsDir,
  generateToken,
} from "./utils.js";
import {
  MAX_BUNDLE_BYTES,
  AUTH_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_HISTORY_RECORDS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_FAILS,
} from "./constants.js";

declare global {
  // eslint-disable-next-line no-var
  var __dianDevSyncWss: GlobalWssEntry | undefined;
}

@Plugin({
  name: "dian-dev-sync",
  description: "Dian 插件远程开发同步服务（支持热更新）",
  version: PKG_VERSION,
  author: "FinalDev",
  icon: "🛠️",
})
export default class DevSyncPlugin {
  private wss: import("ws").WebSocketServer | null = null;
  private sessions = new Map<string, DevSession>();
  private token = "";
  private port = 3901;
  private host: "127.0.0.1" | "0.0.0.0" = "127.0.0.1";
  private config = loadConfig();

  // 并发写锁：per-plugin
  private writeLocks = new Map<string, Promise<void>>();

  // 认证频率限制
  private authFailures = new Map<string, { count: number; firstAt: number }>();

  // 历史存储（通过路由注入获取引用）
  private historyStore: {
    createTable: (tableName: string, columns: string[], pluginName?: string) => Promise<void>;
    insert: (tableName: string, data: Record<string, unknown>) => Promise<void>;
    query: (tableName: string, params?: Record<string, unknown>, options?: { limit?: number; orderBy?: string; order?: "ASC" | "DESC" }) => Promise<Record<string, unknown>[]>;
    delete: (tableName: string, params?: Record<string, unknown>) => Promise<number>;
  } | null = null;

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async onSetup(ctx: PluginSetupContext): Promise<void> {
    this.applyEnvConfig();
    await this.closePreviousWss();
    this.setupRoutes(ctx);
    this.startWebSocketServer(ctx);
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────

  private applyEnvConfig(): void {
    this.port = Number(process.env.DIAN_DEV_SYNC_PORT ?? this.config.port ?? 3901);
    if (!Number.isInteger(this.port) || this.port <= 0 || this.port > 65535) {
      console.warn(`[dian-dev-sync] invalid port ${this.port}, falling back to ${DEFAULT_CONFIG.port}`);
      this.port = DEFAULT_CONFIG.port;
    }
    this.token = process.env.DIAN_DEV_SYNC_TOKEN ?? this.config.token ?? "";
    const envHost = process.env.DIAN_DEV_SYNC_HOST;
    this.host = envHost === "127.0.0.1" || envHost === "0.0.0.0" ? envHost
      : this.config.host === "127.0.0.1" || this.config.host === "0.0.0.0" ? this.config.host
      : DEFAULT_CONFIG.host;
  }

  // ── 热重载：关闭旧 WSS ───────────────────────────────────────────────────

  private async closePreviousWss(): Promise<void> {
    const prev = globalThis.__dianDevSyncWss;
    if (!prev?.wss) return;
    console.info("[dian-dev-sync] closing previous WSS before starting new one");
    if (prev.heartbeatTimer) clearInterval(prev.heartbeatTimer);
    prev.wss.removeAllListeners();
    prev.wss.clients?.forEach((client) => client.terminate?.());
    await new Promise<void>((resolve) => prev.wss.close(() => resolve()));
    globalThis.__dianDevSyncWss = undefined;
  }

  // ── HTTP 路由 ────────────────────────────────────────────────────────────

  private setupRoutes(ctx: PluginSetupContext): void {
    ctx.ui({ staticDir: "./public", entry: "index.html" });

    ctx.route("GET", "/status", (_req, reply) => {
      const list = [...this.sessions.entries()].map(([name, s]) => ({
        pluginName: name,
        connectedAt: s.connectedAt,
        lastSyncAt: s.lastSyncAt,
      }));
      return reply.send({ ok: true, sessions: list, port: this.port, host: this.host });
    });

    ctx.route("GET", "/config", (_req, reply) => {
      reply.send({
        ok: true,
        port: this.config.port,
        host: this.config.host,
        hasToken: !!this.config.token,
      });
    });

    ctx.route("POST", "/config", async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body !== "object") {
        return reply.code(400).send({ ok: false, error: "invalid request body" });
      }
      const next: PluginConfig = { ...this.config };
      if (typeof body.token === "string") next.token = body.token;
      if (typeof body.port === "number" && Number.isInteger(body.port) && body.port > 0 && body.port <= 65535) next.port = body.port;
      if (body.host === "127.0.0.1" || body.host === "0.0.0.0") next.host = body.host;
      await saveConfig(next);
      this.config = next;
      reply.send({ ok: true });
      if (body.token !== undefined || body.host !== undefined || body.port !== undefined) {
        pluginManager.reload("dian-dev-sync").catch((err: unknown) => {
          console.error("[dian-dev-sync] self-reload failed:", err);
        });
      }
    });

    // 生成随机 Token
    ctx.route("POST", "/generate-token", async (_req, reply) => {
      const newToken = generateToken();
      const next: PluginConfig = { ...this.config, token: newToken };
      await saveConfig(next);
      this.config = next;
      reply.send({ ok: true, token: newToken });
      pluginManager.reload("dian-dev-sync").catch((err: unknown) => {
        console.error("[dian-dev-sync] self-reload failed:", err);
      });
    });

    ctx.route("POST", "/disconnect", (req, reply) => {
      const body = req.body as Record<string, unknown>;
      const pluginName = safePluginName(body?.pluginName);
      if (!pluginName) {
        return reply.code(400).send({ error: "missing or invalid pluginName" });
      }
      const session = this.sessions.get(pluginName);
      if (session) {
        session.socket.close();
        this.sessions.delete(pluginName);
      }
      return reply.send({ ok: true });
    });

    // 历史记录路由
    this.setupHistoryRoutes(ctx);
  }

  // ── 历史记录 ─────────────────────────────────────────────────────────────

  private setupHistoryRoutes(ctx: PluginSetupContext): void {
    const ensureTable = async (req: unknown): Promise<boolean> => {
      if (this.historyStore) return true;
      const store = (req as unknown as Record<string, unknown>).pluginStore as {
        createTable: (tableName: string, columns: string[], pluginName?: string) => Promise<void>;
        insert: (tableName: string, data: Record<string, unknown>) => Promise<void>;
        query: (tableName: string, params?: Record<string, unknown>, options?: { limit?: number; orderBy?: string; order?: "ASC" | "DESC" }) => Promise<Record<string, unknown>[]>;
        delete: (tableName: string, params?: Record<string, unknown>) => Promise<number>;
      } | undefined;
      if (!store) return false;
      try {
        await store.createTable("dian_dev_sync_history", [
          "plugin_name TEXT NOT NULL",
          "status TEXT NOT NULL",
          "message TEXT",
          "bundle_size INTEGER",
        ], "dian-dev-sync");
        this.historyStore = store;
        return true;
      } catch {
        return false;
      }
    };

    ctx.route("GET", "/history", async (req, reply) => {
      if (!(await ensureTable(req))) return reply.send({ ok: true, items: [] });
      try {
        const items = await this.historyStore!.query("dian_dev_sync_history", undefined, {
          orderBy: "id",
          order: "DESC",
          limit: 50,
        });
        return reply.send({ ok: true, items });
      } catch (err) {
        return reply.code(500).send({ ok: false, error: String(err) });
      }
    });

    ctx.route("DELETE", "/history", async (req, reply) => {
      if (!(await ensureTable(req))) return reply.send({ ok: true });
      try {
        await this.historyStore!.delete("dian_dev_sync_history");
        return reply.send({ ok: true });
      } catch (err) {
        return reply.code(500).send({ ok: false, error: String(err) });
      }
    });
  }

  // ── 记录历史 + 自动裁剪 ───────────────────────────────────────────────────

  private async recordHistory(
    pluginName: string,
    status: "success" | "error",
    message: string,
    bundleSize?: number
  ): Promise<void> {
    if (!this.historyStore) return;
    try {
      await this.historyStore.insert("dian_dev_sync_history", {
        plugin_name: pluginName,
        status,
        message,
        bundle_size: bundleSize ?? null,
      });
      await this.pruneHistory();
    } catch (e) {
      console.error("[dian-dev-sync] failed to record history:", e);
    }
  }

  private async pruneHistory(): Promise<void> {
    if (!this.historyStore) return;
    try {
      const items = await this.historyStore.query("dian_dev_sync_history", undefined, {
        orderBy: "id",
        order: "DESC",
        limit: MAX_HISTORY_RECORDS + 1,
      });
      if (items.length <= MAX_HISTORY_RECORDS) return;
      const cutoffId = (items[items.length - 1] as Record<string, unknown>).id;
      // 使用 delete 方法删除旧记录（简化版：删除所有 id <= cutoffId 的记录）
      // 注意：这里需要通过 WHERE 条件删除，但 PluginStore 没有直接支持
      // 暂时使用简化方式：删除超出限制的记录数量
      const excessCount = items.length - MAX_HISTORY_RECORDS;
      for (let i = 0; i < excessCount; i++) {
        const id = (items[MAX_HISTORY_RECORDS + i] as Record<string, unknown>).id;
        await this.historyStore.delete("dian_dev_sync_history", { id });
      }
    } catch { /* 裁剪失败不影响主逻辑 */ }
  }

  // ── WebSocket 服务 ───────────────────────────────────────────────────────

  private async startWebSocketServer(_ctx: PluginSetupContext): Promise<void> {
    const { WebSocketServer: WSS } = await import("ws");

    try {
      this.wss = new WSS({ port: this.port, host: this.host });
    } catch (err) {
      console.error(`[dian-dev-sync] failed to start WSS on ${this.host}:${this.port}:`, err);
      return;
    }

    const heartbeatTimer = setInterval(() => {
      this.sessions.forEach((session, name) => {
        if (!session.alive) {
          console.info(`[dian-dev-sync] plugin "${name}" heartbeat timeout, terminating`);
          session.socket.terminate();
          this.sessions.delete(name);
          return;
        }
        session.alive = false;
        if (session.socket.readyState === WebSocket.OPEN) {
          session.socket.ping();
        }
      });
    }, HEARTBEAT_INTERVAL_MS);

    globalThis.__dianDevSyncWss = { wss: this.wss, instance: this, heartbeatTimer };

    this.wss.on("error", (err) => {
      console.error(`[dian-dev-sync] WSS error:`, err.message);
    });

    this.wss.on("close", () => {
      clearInterval(heartbeatTimer);
      console.info("[dian-dev-sync] WSS closed");
      if (globalThis.__dianDevSyncWss?.instance === this) {
        globalThis.__dianDevSyncWss = undefined;
      }
    });

    console.info(`[dian-dev-sync] WS server listening on ws://${this.host}:${this.port}`);
    if (!this.token) {
      console.warn("[dian-dev-sync] DIAN_DEV_SYNC_TOKEN not set — set via env or Web UI");
    }

    this.wss.on("connection", (socket, req) => this.handleConnection(socket, req));
  }

  // ── WS 连接处理 ──────────────────────────────────────────────────────────

  private handleConnection(socket: WebSocket, req: import("http").IncomingMessage): void {
    const remoteIp = req.socket.remoteAddress ?? "unknown";
    let authed = false;
    let sessionPluginName = "";
    let authTimer: NodeJS.Timeout | null = null;

    authTimer = setTimeout(() => {
      if (!authed) {
        send(socket, { type: "error", ok: false, message: "auth timeout" });
        socket.close();
      }
    }, AUTH_TIMEOUT_MS);

    socket.on("pong", () => {
      if (sessionPluginName) {
        const session = this.sessions.get(sessionPluginName);
        if (session) session.alive = true;
      }
    });

    socket.on("message", async (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        send(socket, { type: "error", ok: false, message: "invalid json" });
        return;
      }

      if (!authed) {
        const name = this.handleAuth(socket, data, remoteIp);
        if (name) {
          authed = true;
          sessionPluginName = name;
          if (authTimer) clearTimeout(authTimer);
        }
        return;
      }

      await this.handlePushBundle(socket, data, sessionPluginName);
    });

    socket.on("close", () => {
      if (authTimer) clearTimeout(authTimer);
      if (sessionPluginName) {
        const s = this.sessions.get(sessionPluginName);
        if (s?.socket === socket) {
          this.sessions.delete(sessionPluginName);
          console.info(`[dian-dev-sync] plugin "${sessionPluginName}" disconnected`);
        }
      }
    });

    socket.on("error", (err) => {
      console.error("[dian-dev-sync] socket error:", err);
    });
  }

  // ── 认证频率限制 ──────────────────────────────────────────────────────────

  private isRateLimited(ip: string): boolean {
    const entry = this.authFailures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > RATE_LIMIT_WINDOW_MS) {
      this.authFailures.delete(ip);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX_FAILS;
  }

  private recordAuthFailure(ip: string): void {
    const entry = this.authFailures.get(ip);
    if (!entry || Date.now() - entry.firstAt > RATE_LIMIT_WINDOW_MS) {
      this.authFailures.set(ip, { count: 1, firstAt: Date.now() });
    } else {
      entry.count++;
    }
  }

  private clearAuthFailure(ip: string): void {
    this.authFailures.delete(ip);
  }

  // ── 认证 ─────────────────────────────────────────────────────────────────

  private handleAuth(socket: WebSocket, data: unknown, remoteIp: string): string | null {
    if (this.isRateLimited(remoteIp)) {
      send(socket, { type: "auth-result", ok: false, message: "too many failed attempts, try again later" });
      socket.close();
      return null;
    }

    if (!isAuthMsg(data)) {
      send(socket, { type: "error", ok: false, message: "expected auth message" });
      socket.close();
      return null;
    }
    if (!this.token) {
      send(socket, { type: "auth-result", ok: false, message: "token not configured on server" });
      socket.close();
      return null;
    }
    if (data.token !== this.token) {
      this.recordAuthFailure(remoteIp);
      send(socket, { type: "auth-result", ok: false, message: "invalid token" });
      socket.close();
      return null;
    }
    const name = safePluginName(data.pluginName);
    if (!name) {
      send(socket, { type: "auth-result", ok: false, message: "invalid pluginName" });
      socket.close();
      return null;
    }

    this.clearAuthFailure(remoteIp);

    const existing = this.sessions.get(name);
    if (existing) {
      send(existing.socket, { type: "error", ok: false, message: "replaced by new connection" });
      existing.socket.close();
      this.sessions.delete(name);
    }

    this.sessions.set(name, { socket, connectedAt: Date.now(), pluginName: name, alive: true });
    send(socket, { type: "auth-result", ok: true });
    console.info(`[dian-dev-sync] plugin "${name}" connected from ${remoteIp}`);
    return name;
  }

  // ── 并发写锁 ─────────────────────────────────────────────────────────────

  private async acquireWriteLock(pluginName: string): Promise<void> {
    while (this.writeLocks.has(pluginName)) {
      await this.writeLocks.get(pluginName);
    }
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    (promise as unknown as { _resolve: () => void })._resolve = resolve;
    this.writeLocks.set(pluginName, promise);
  }

  private releaseWriteLock(pluginName: string): void {
    const lock = this.writeLocks.get(pluginName);
    this.writeLocks.delete(pluginName);
    if (lock) {
      (lock as unknown as { _resolve: () => void })._resolve();
    }
  }

  // ── 推送处理 ─────────────────────────────────────────────────────────────

  private async handlePushBundle(
    socket: WebSocket,
    data: unknown,
    sessionPluginName: string
  ): Promise<void> {
    if (!isPushBundleMsg(data)) {
      send(socket, { type: "error", ok: false, message: "unknown message type" });
      return;
    }

    const name = safePluginName(data.pluginName);
    if (!name || name !== sessionPluginName) {
      send(socket, { type: "error", ok: false, message: "pluginName mismatch" });
      return;
    }

    await this.acquireWriteLock(name);

    const pluginsDir = getPluginsDir();
    const destDir = resolve(pluginsDir, name);

    try {
      const zipBuffer = Buffer.from(data.bundle, "base64");
      if (zipBuffer.byteLength > MAX_BUNDLE_BYTES) {
        throw new Error(`bundle too large (${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)} MB, max 100 MB)`);
      }
      const zipData = new Uint8Array(zipBuffer);

      send(socket, { type: "bundle-accepted", ok: true });

      pluginManager.setInstallLock(true);

      const files = await new Promise<Record<string, Uint8Array>>((res, rej) => {
        unzip(zipData, (err, f) => {
          if (err) rej(err);
          else if (!f) rej(new Error("unzip returned no data"));
          else res(f);
        });
      });

      if (existsSync(destDir)) {
        await rm(destDir, { recursive: true, force: true });
      }
      await mkdir(destDir, { recursive: true });

      const writeTasks: Promise<void>[] = [];
      for (const [filePath, fileData] of Object.entries(files)) {
        if (filePath.endsWith("/")) continue;
        const dest = resolve(destDir, filePath);
        if (!dest.startsWith(destDir + sep)) {
          throw new Error(`path traversal denied: ${filePath}`);
        }
        writeTasks.push(
          mkdir(dirname(dest), { recursive: true }).then(() => writeFile(dest, fileData))
        );
      }
      await Promise.all(writeTasks);

      const indexFile = join(destDir, "index.js");
      const existing = pluginManager.plugins.find((p) => p.meta.name === name);
      if (existing) {
        await pluginManager.reload(name);
      } else if (existsSync(indexFile)) {
        await pluginManager.loadFromPath(indexFile);
      }

      const session = this.sessions.get(name);
      if (session) session.lastSyncAt = Date.now();

      send(socket, { type: "reload-complete", ok: true });
      console.info(`[dian-dev-sync] plugin "${name}" synced & reloaded`);
      await this.recordHistory(name, "success", "synced & reloaded", data.bundle.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dian-dev-sync] reload error for "${name}":`, msg);
      send(socket, { type: "reload-error", ok: false, message: msg });
      await this.recordHistory(name, "error", msg, data.bundle.length);
    } finally {
      pluginManager.setInstallLock(false);
      this.releaseWriteLock(name);
    }
  }
}

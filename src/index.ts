import "reflect-metadata";
import { WebSocket, type WebSocketServer } from "ws";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzip } from "fflate";
import {
  Plugin,
  pluginManager,
  type PluginSetupContext,
} from "@dian/plugin-runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface PluginConfig {
  token: string;
  port: number;
  host: "127.0.0.1" | "0.0.0.0";
}

interface DevSession {
  socket: WebSocket;
  connectedAt: number;
  lastSyncAt?: number;
  pluginName: string;
}

interface WsAuthMessage {
  type: "auth";
  token: string;
  pluginName: string;
}

interface WsPushBundleMessage {
  type: "push-bundle";
  pluginName: string;
  bundle: string;
}

interface WsResponse {
  type: string;
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

interface GlobalWssEntry {
  wss: WebSocketServer;
  instance: DevSyncPlugin;
}

declare global {
  var __dianDevSyncWss: GlobalWssEntry | undefined;
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PluginConfig = { token: "", port: 3901, host: "127.0.0.1" };
const CONFIG_PATH = resolve(__dirname, "config.json");
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5000;

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function isAuthMsg(data: unknown): data is WsAuthMessage {
  const d = data as Record<string, unknown>;
  return d?.type === "auth" && typeof d?.token === "string" && typeof d?.pluginName === "string";
}

function isPushBundleMsg(data: unknown): data is WsPushBundleMessage {
  const d = data as Record<string, unknown>;
  return d?.type === "push-bundle" && typeof d?.pluginName === "string" && typeof d?.bundle === "string";
}

function safePluginName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return /^[\w-]+$/.test(name) ? name : null;
}

function send(socket: WebSocket, data: WsResponse): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function getPluginsDir(): string {
  const fromEnv = process.env.DIAN_PLUGINS_DIR;
  if (fromEnv) return resolve(fromEnv);
  const fromManager = pluginManager.pluginsDir;
  if (fromManager) return fromManager;
  const first = pluginManager.plugins[0]?.filePath;
  if (first) return dirname(first);
  return resolve(__dirname, "../../../plugins");
}

function loadConfig(): PluginConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PluginConfig>;
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (e) {
    console.warn("[dian-dev-sync] failed to load config:", e);
  }
  return { ...DEFAULT_CONFIG };
}

async function saveConfig(cfg: PluginConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── 插件主体 ──────────────────────────────────────────────────────────────────

@Plugin({
  name: "dian-dev-sync",
  description: "Dian 插件远程开发同步服务",
  version: "1.0.0",
  author: "FinalDev",
  icon: "🛠️",
})
export default class DevSyncPlugin {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, DevSession>();
  private token = "";
  private port = 3901;
  private host: "127.0.0.1" | "0.0.0.0" = "127.0.0.1";
  private config = loadConfig();

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async onSetup(ctx: PluginSetupContext): Promise<void> {
    this.applyEnvConfig();
    await this.closePreviousWss();
    this.setupRoutes(ctx);
    await this.initHistoryStore(ctx);
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
      return reply.send({ ok: true, sessions: list, port: this.port });
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
  }

  // ── 历史记录 ─────────────────────────────────────────────────────────────

  private historyStore: import("@dian/storage").SqlitePluginStore | null = null;

  private async initHistoryStore(ctx: PluginSetupContext): Promise<void> {
    try {
      const { SqlitePluginStore } = await import("@dian/storage");
      // 数据库存储在插件目录的上一层（plugins/ 根目录下），
      // 这样自更新时 rm(plugins/dian-dev-sync/) 不会删掉它，也不会触发 EBUSY。
      const dbPath = resolve(__dirname, "..", "dian-dev-sync-history.db");
      this.historyStore = new SqlitePluginStore(dbPath);
      await this.historyStore.createTable("sync_history", [
        "plugin_name TEXT NOT NULL",
        "status TEXT NOT NULL",
        "message TEXT",
        "bundle_size INTEGER",
      ]);
      // 将独立数据库注册到数据库查看器，使其在 UI 中以 "dian-dev-sync" 数据源展示
      ctx.datasource("dian-dev-sync", dbPath);
      console.info(`[dian-dev-sync] history store enabled at ${dbPath}`);
    } catch (err) {
      console.error("[dian-dev-sync] failed to init history store:", err);
    }

    ctx.route("GET", "/history", async (_req, reply) => {
      if (!this.historyStore) return reply.send({ ok: true, items: [] });
      try {
        const items = await this.historyStore.query("sync_history", undefined, {
          orderBy: "id",
          order: "DESC",
          limit: 50,
        });
        return reply.send({ ok: true, items });
      } catch (err) {
        return reply.code(500).send({ ok: false, error: String(err) });
      }
    });
  }

  // ── 记录历史辅助 ─────────────────────────────────────────────────────────

  private async recordHistory(
    pluginName: string,
    status: "success" | "error",
    message: string,
    bundleSize?: number
  ): Promise<void> {
    if (!this.historyStore) return;
    try {
      await this.historyStore.insert("sync_history", {
        plugin_name: pluginName,
        status,
        message,
        bundle_size: bundleSize ?? null,
      });
    } catch (e) {
      console.error("[dian-dev-sync] failed to record history:", e);
    }
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

    globalThis.__dianDevSyncWss = { wss: this.wss, instance: this };

    this.wss.on("error", (err) => {
      console.error(`[dian-dev-sync] WSS error:`, err.message);
    });

    this.wss.on("close", () => {
      console.info("[dian-dev-sync] WSS closed");
      if (globalThis.__dianDevSyncWss?.instance === this) {
        globalThis.__dianDevSyncWss = undefined;
      }
    });

    console.info(`[dian-dev-sync] WS server listening on ws://${this.host}:${this.port}`);
    if (!this.token) {
      console.warn("[dian-dev-sync] DIAN_DEV_SYNC_TOKEN not set — set via env or Web UI");
    }

    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  // ── WS 连接处理 ──────────────────────────────────────────────────────────

  private handleConnection(socket: WebSocket): void {
    let authed = false;
    let sessionPluginName = "";
    let authTimer: NodeJS.Timeout | null = null;

    authTimer = setTimeout(() => {
      if (!authed) {
        send(socket, { type: "error", ok: false, message: "auth timeout" });
        socket.close();
      }
    }, AUTH_TIMEOUT_MS);

    socket.on("message", async (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        send(socket, { type: "error", ok: false, message: "invalid json" });
        return;
      }

      if (!authed) {
        const name = this.handleAuth(socket, data);
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

  // ── 认证 ─────────────────────────────────────────────────────────────────

  /** 返回值：认证成功返回 pluginName，否则返回 null */
  private handleAuth(socket: WebSocket, data: unknown): string | null {
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

    const existing = this.sessions.get(name);
    if (existing) {
      send(existing.socket, { type: "error", ok: false, message: "replaced by new connection" });
      existing.socket.close();
      this.sessions.delete(name);
    }

    this.sessions.set(name, { socket, connectedAt: Date.now(), pluginName: name });
    send(socket, { type: "auth-result", ok: true });
    console.info(`[dian-dev-sync] plugin "${name}" connected`);
    return name;
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
        // 自更新时，主动关闭 SQLite 连接，避免 Windows 上 EBUSY 锁文件错误。
        // （即使 DB 已移到插件目录外，此处也保留作为安全兜底。）
        if (resolve(destDir) === resolve(__dirname) && this.historyStore) {
          try {
            await this.historyStore.close();
          } catch { /* 忽略关闭失败 */ }
          this.historyStore = undefined;
        }
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
    }
  }
}

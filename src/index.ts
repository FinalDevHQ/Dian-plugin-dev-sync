import "reflect-metadata";
import type { WebSocket, WebSocketServer } from "ws";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
}

const DEFAULT_CONFIG: PluginConfig = { token: "", port: 3901 };
const CONFIG_PATH = resolve(__dirname, "config.json");

function loadConfig(): PluginConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<PluginConfig>;
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg: PluginConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

interface DevSession {
  socket: WebSocket;
  connectedAt: number;
  lastSyncAt?: number;
  pluginName: string;
}

// ── 协议消息 ──────────────────────────────────────────────────────────────────

interface WsAuthMessage {
  type: "auth";
  token: string;
  pluginName: string;
}

interface WsPushBundleMessage {
  type: "push-bundle";
  pluginName: string;
  bundle: string; // base64(zip)
}

interface WsResponse {
  type: string;
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

function isAuthMsg(data: unknown): data is WsAuthMessage {
  const d = data as Record<string, unknown>;
  return d?.type === "auth" && typeof d?.token === "string" && typeof d?.pluginName === "string";
}

function isPushBundleMsg(data: unknown): data is WsPushBundleMessage {
  const d = data as Record<string, unknown>;
  return (
    d?.type === "push-bundle" &&
    typeof d?.pluginName === "string" &&
    typeof d?.bundle === "string"
  );
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function safePluginName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return /^[\w-]+$/.test(name) ? name : null;
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

function send(socket: WebSocket, data: WsResponse): void {
  if (socket.readyState === 1 /* OPEN */) {
    socket.send(JSON.stringify(data));
  }
}

// ── 全局追踪（热重载时关闭旧 WSS） ─────────────────────────────────────────────

interface GlobalWssEntry {
  wss: WebSocketServer;
  instance: DevSyncPlugin;
}

declare global {
  // eslint-disable-next-line no-var
  var __dianDevSyncWss: GlobalWssEntry | undefined;
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

  private config = loadConfig();

  async onSetup(ctx: PluginSetupContext): Promise<void> {
    const { WebSocketServer: WSS } = await import("ws");

    this.port = Number(process.env.DIAN_DEV_SYNC_PORT ?? this.config.port ?? 3901);
    this.token = process.env.DIAN_DEV_SYNC_TOKEN ?? this.config.token ?? "";

    // 如果之前有本插件的 WSS 在运行（热重载场景），先关掉它
    const prev = globalThis.__dianDevSyncWss;
    if (prev && prev.wss) {
      console.info("[dian-dev-sync] closing previous WSS before starting new one");
      prev.wss.removeAllListeners();
      prev.wss.close();
      // 强制关闭所有现存连接
      prev.wss.clients?.forEach((client) => client.terminate?.());
      globalThis.__dianDevSyncWss = undefined;
    }

    // ── API 路由 ───────────────────────────────────────────────────────────
    ctx.route("GET", "/status", (_req, reply) => {
      const list = [...this.sessions.entries()].map(([name, s]) => ({
        pluginName: name,
        connectedAt: s.connectedAt,
        lastSyncAt: s.lastSyncAt,
      }));
      return reply.send({ ok: true, sessions: list, port: this.port });
    });

    // ── GET /plugins/dian-dev-sync/api/config ──────────────────────────────
    ctx.route("GET", "/config", (_req, reply) => {
      reply.send({
        ok: true,
        port: this.config.port,
        hasToken: !!this.config.token,
      });
    });

    // ── POST /plugins/dian-dev-sync/api/config ─────────────────────────────
    ctx.route("POST", "/config", (req, reply) => {
      const body = req.body as Partial<PluginConfig>;
      const next: PluginConfig = { ...this.config };

      if (typeof body.token === "string") next.token = body.token;
      if (typeof body.port === "number" && body.port > 0 && body.port < 65536) next.port = body.port;

      saveConfig(next);
      this.config = next;

      reply.send({ ok: true });

      // 若 token 变化则重载自己，让新 WSS 使用新 token
      if (body.token !== undefined) {
        setTimeout(() => {
          pluginManager.reload("dian-dev-sync").catch((err: unknown) => {
            console.error("[dian-dev-sync] self-reload failed:", err);
          });
        }, 100);
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

    // ── Web UI ─────────────────────────────────────────────────────────────
    ctx.ui({ staticDir: "./public", entry: "index.html" });

    // ── 历史记录存储 ───────────────────────────────────────────────────────
    let store: import("@dian/storage").SqlitePluginStore | null = null;
    try {
      const { configService } = await import("@dian/config");
      const { SqlitePluginStore } = await import("@dian/storage");
      const sqlitePath = configService.settings.storage?.sqlite;
      if (sqlitePath) {
        store = new SqlitePluginStore(sqlitePath);
        await store.createTable("dian_dev_sync_history", [
          "plugin_name TEXT NOT NULL",
          "status TEXT NOT NULL",
          "message TEXT",
          "bundle_size INTEGER",
        ]);
        console.info("[dian-dev-sync] history store enabled");
      } else {
        console.warn("[dian-dev-sync] no sqlite storage configured, history disabled");
      }
    } catch (err) {
      console.error("[dian-dev-sync] failed to init history store:", err);
    }

    // ── 记录历史辅助函数 ───────────────────────────────────────────────────
    const recordHistory = async (
      pluginName: string,
      status: "success" | "error",
      message: string,
      bundleSize?: number
    ) => {
      if (!store) return;
      try {
        await store.insert("dian_dev_sync_history", {
          plugin_name: pluginName,
          status,
          message,
          bundle_size: bundleSize ?? null,
        });
      } catch (e) {
        console.error("[dian-dev-sync] failed to record history:", e);
      }
    };

    // ── GET /history ───────────────────────────────────────────────────────
    ctx.route("GET", "/history", async (_req, reply) => {
      if (!store) return reply.send({ ok: true, items: [] });
      try {
        const items = await store.query("dian_dev_sync_history", undefined, {
          orderBy: "id",
          order: "DESC",
          limit: 50,
        });
        return reply.send({ ok: true, items });
      } catch (err) {
        return reply.code(500).send({ ok: false, error: String(err) });
      }
    });

    // ── WS 服务 ──────────────────────────────────────────────────────────────
    this.wss = new WSS({ port: this.port, host: "127.0.0.1" });

    // 记录到全局，reload 时新实例能找到并关闭
    globalThis.__dianDevSyncWss = { wss: this.wss, instance: this };

    // 处理 listen error（如端口被占），避免未处理异常导致进程崩溃
    this.wss.on("error", (err) => {
      console.error(`[dian-dev-sync] WSS error:`, err.message);
    });

    this.wss.on("close", () => {
      console.info("[dian-dev-sync] WSS closed");
      if (globalThis.__dianDevSyncWss?.instance === this) {
        globalThis.__dianDevSyncWss = undefined;
      }
    });

    console.info(`[dian-dev-sync] WS server listening on ws://127.0.0.1:${this.port}`);
    if (!this.token) {
      console.warn("[dian-dev-sync] DIAN_DEV_SYNC_TOKEN not set, auth will always fail");
    }

    this.wss.on("connection", (socket) => {
      let authed = false;
      let sessionPluginName = "";
      let authTimer: NodeJS.Timeout | null = null;

      // 5 秒内必须完成认证
      authTimer = setTimeout(() => {
        if (!authed) {
          send(socket, { type: "error", ok: false, message: "auth timeout" });
          socket.close();
        }
      }, 5000);

      socket.on("message", async (raw) => {
        let data: unknown;
        try {
          data = JSON.parse(String(raw));
        } catch {
          send(socket, { type: "error", ok: false, message: "invalid json" });
          return;
        }

        if (!authed) {
          if (!isAuthMsg(data)) {
            send(socket, { type: "error", ok: false, message: "expected auth message" });
            socket.close();
            return;
          }
          if (this.token && data.token !== this.token) {
            send(socket, { type: "auth-result", ok: false, message: "invalid token" });
            socket.close();
            return;
          }
          const name = safePluginName(data.pluginName);
          if (!name) {
            send(socket, { type: "auth-result", ok: false, message: "invalid pluginName" });
            socket.close();
            return;
          }
          // 踢掉旧的同名连接
          const existing = this.sessions.get(name);
          if (existing) {
            send(existing.socket, { type: "error", ok: false, message: "replaced by new connection" });
            existing.socket.close();
            this.sessions.delete(name);
          }
          authed = true;
          sessionPluginName = name;
          if (authTimer) clearTimeout(authTimer);
          this.sessions.set(name, {
            socket,
            connectedAt: Date.now(),
            pluginName: name,
          });
          send(socket, { type: "auth-result", ok: true });
          console.info(`[dian-dev-sync] plugin "${name}" connected`);
          return;
        }

        // 已认证后的消息
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
          // base64 → buffer → Uint8Array
          const zipBuffer = Buffer.from(data.bundle, "base64");
          const zipData = new Uint8Array(zipBuffer);

          send(socket, { type: "bundle-accepted", ok: true });

          // 防止与框架 chokidar watcher 冲突
          pluginManager.setInstallLock(true);

          // 解压
          const files = await new Promise<Record<string, Uint8Array>>((res, rej) => {
            unzip(zipData, (err, f) => {
              if (err) rej(err);
              else res(f);
            });
          });

          // 清理旧目录
          if (existsSync(destDir)) {
            await rm(destDir, { recursive: true, force: true });
          }
          await mkdir(destDir, { recursive: true });

          // 写入新文件
          for (const [filePath, fileData] of Object.entries(files)) {
            if (filePath.endsWith("/")) continue;
            const dest = join(destDir, filePath);
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, fileData);
          }

          // 加载/重载插件
          const indexFile = join(destDir, "index.js");
          const existing = pluginManager.plugins.find((p) => p.meta.name === name);
          if (existing) {
            await pluginManager.reload(name);
          } else if (existsSync(indexFile)) {
            await pluginManager.loadFromPath(indexFile);
          }

          pluginManager.setInstallLock(false);

          const session = this.sessions.get(name);
          if (session) session.lastSyncAt = Date.now();

          send(socket, { type: "reload-complete", ok: true });
          console.info(`[dian-dev-sync] plugin "${name}" synced & reloaded`);
          await recordHistory(name, "success", "synced & reloaded", data.bundle.length);
        } catch (err) {
          pluginManager.setInstallLock(false);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[dian-dev-sync] reload error for "${name}":`, msg);
          send(socket, { type: "reload-error", ok: false, message: msg });
          await recordHistory(name, "error", msg, data.bundle.length);
        }
      });

      socket.on("close", () => {
        if (authTimer) clearTimeout(authTimer);
        if (sessionPluginName) {
          const s = this.sessions.get(sessionPluginName);
          if (s && s.socket === socket) {
            this.sessions.delete(sessionPluginName);
            console.info(`[dian-dev-sync] plugin "${sessionPluginName}" disconnected`);
          }
        }
      });

      socket.on("error", (err) => {
        console.error("[dian-dev-sync] socket error:", err);
      });
    });
  }
}

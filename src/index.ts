import "reflect-metadata";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Plugin,
  type EventContext,
  type PluginSetupContext,
} from "@dian/plugin-runtime";

// ── 配置 ──────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "config.json");

interface Config {
  command: string;   // 触发指令，默认 !ping
  reply: string;     // 回复内容，默认 pong! 🏓
}

const DEFAULTS: Config = { command: "!ping", reply: "pong! 🏓" };

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config };
    }
  } catch { /* 读取失败时使用默认值 */ }
  return { ...DEFAULTS };
}

function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ── 插件主体 ──────────────────────────────────────────────────────────────────

@Plugin({
  name: "ping-pong",
  description: "可自定义指令和回复内容的 ping-pong 插件",
  version: "1.0.0",
  author: "your-name",
  icon: "🏓",
})
export default class PingPongPlugin {
  /** 插件加载时间（服务端时间戳，毫秒） */
  private readonly startTime = Date.now();

  /** 运行时配置（可通过 Web UI 修改 reply，修改 command 需重启） */
  private config = loadConfig();

  /** 收到指令的累计次数 */
  private pingCount = 0;

  /** 最近触发记录（最多保留 50 条） */
  private recentPings: Array<{
    sender: string;
    userId?: string;
    group?: string;
    time: number;
  }> = [];

  onSetup(ctx: PluginSetupContext): void {
    // ── 注册指令 ──────────────────────────────────────────────────────────
    // pattern 用函数形式：每次事件分发时实时读取 this.config.command，
    // 因此通过 /api/config 修改后立即生效，无需重启服务。
    ctx.command({
      name: this.config.command,
      pattern: () => this.config.command,
      description: `回复 "${this.config.reply}"`,
      handler: async (c: EventContext) => {
        this.pingCount++;
        this.recentPings.unshift({
          sender: c.event.payload.senderName ?? "unknown",
          userId: c.event.payload.userId,
          group: c.event.payload.groupId,
          time: c.event.timestamp,
        });
        if (this.recentPings.length > 50) this.recentPings.pop();

        console.log(
          `[ping-pong] ${c.event.payload.senderName ?? "?"} ` +
          `→ "${this.config.reply}"`
        );
        await c.reply(this.config.reply);
      },
    });

    // ── GET /plugins/ping-pong/api/status ────────────────────────────────────
    ctx.route("GET", "/status", (_req, reply) => {
      reply.send({
        startTime: this.startTime,           // 服务端加载时间戳
        pingCount: this.pingCount,
        config: this.config,
        recentPings: this.recentPings.slice(0, 10),
      });
    });

    // ── POST /plugins/ping-pong/api/config ───────────────────────────────────
    // 修改 reply：立即生效；修改 command：需重启服务
    ctx.route("POST", "/config", (req, reply) => {
      const body = req.body as Partial<Config>;
      if (typeof body.reply === "string" && body.reply.trim()) {
        this.config.reply = body.reply.trim();
      }
      if (typeof body.command === "string" && body.command.trim()) {
        this.config.command = body.command.trim();
      }
      saveConfig(this.config);
      reply.send({ ok: true, config: this.config });
    });

    // ── Web UI ───────────────────────────────────────────────────────────────
    ctx.ui({ staticDir: "./public", entry: "index.html" });
  }
}

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { pluginManager } from "@dian/plugin-runtime";
import type { WsAuthMessage, WsPushBundleMessage, WsResponse } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function isAuthMsg(data: unknown): data is WsAuthMessage {
  const d = data as Record<string, unknown>;
  return d?.type === "auth" && typeof d?.token === "string" && typeof d?.pluginName === "string";
}

export function isPushBundleMsg(data: unknown): data is WsPushBundleMessage {
  const d = data as Record<string, unknown>;
  return d?.type === "push-bundle" && typeof d?.pluginName === "string" && typeof d?.bundle === "string";
}

export function safePluginName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return /^[\w-]+$/.test(name) ? name : null;
}

export function send(socket: WebSocket, data: WsResponse): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

export function getPluginsDir(): string {
  const fromEnv = process.env.DIAN_PLUGINS_DIR;
  if (fromEnv) return resolve(fromEnv);
  const fromManager = pluginManager.pluginsDir;
  if (fromManager) return fromManager;
  const first = pluginManager.plugins[0]?.filePath;
  if (first) return dirname(first);
  return resolve(__dirname, "../../../plugins");
}

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

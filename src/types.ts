import type { WebSocket, WebSocketServer } from "ws";
import type DevSyncPlugin from "./index.js";

export interface DevSession {
  socket: WebSocket;
  connectedAt: number;
  lastSyncAt?: number;
  pluginName: string;
  alive: boolean;
}

export interface WsAuthMessage {
  type: "auth";
  token: string;
  pluginName: string;
}

export interface WsPushBundleMessage {
  type: "push-bundle";
  pluginName: string;
  bundle: string;
}

export interface WsResponse {
  type: string;
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface GlobalWssEntry {
  wss: WebSocketServer;
  instance: DevSyncPlugin;
  heartbeatTimer?: NodeJS.Timeout;
}

declare global {
  var __dianDevSyncWss: GlobalWssEntry | undefined;
}

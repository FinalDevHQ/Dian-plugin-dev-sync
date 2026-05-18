# dian-dev-sync

Dian 插件远程开发同步服务 — 通过 WebSocket 实时接收开发工具推送的插件构建产物，自动解压并热重载到 Dian 实例。

**适用版本**：Dian `0.1.x` · 插件版本 `1.0.0` · 协议版本 `1`

---

## 安全特性

| 防护 | 说明 |
|------|------|
| Token 强制认证 | 未配置 Token 时服务启动但拒绝所有连接，避免空密码绕过 |
| Zip Slip 防护 | 解压时校验文件路径，拒绝 `../` 穿越攻击 |
| Bundle 大小限制 | 单次推送最大 100 MB，防止 OOM |
| 监听地址隔离 | 默认仅监听 `127.0.0.1`，切换 `0.0.0.0` 时 UI 显示安全警告 |

---

## 工作流程

```
你的开发环境                          Dian 服务器
┌─────────────────┐                ┌──────────────────────┐
│  tsup --watch    │                │  dian-dev-sync (WSS) │
│  → 构建 dist/    │  ──WS 推送──▶  │  → 解压 zip          │
│  → 打包为 zip    │   bundle.zip   │  → 写入 plugins/<n>/ │
│  → base64 编码   │                │  → 热重载插件         │
└─────────────────┘                └──────────────────────┘
```

---

## 安装

### 方式一：Web 控制台上传

1. 打开 Dian Web 控制台 → **插件**
2. 点击上传，选择 `dian-dev-sync.zip`
3. 安装完成后**重启 Dian 服务**（HTTP 路由需重启生效）

### 方式二：手动解压

将 ZIP 解压到 `plugins/dian-dev-sync/`。

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DIAN_DEV_SYNC_PORT` | `3901` | WebSocket 服务端口 |
| `DIAN_DEV_SYNC_TOKEN` | `""` | 认证 Token（未设置时服务拒绝所有连接） |
| `DIAN_DEV_SYNC_HOST` | `127.0.0.1` | 监听地址，可选 `127.0.0.1`（仅本地）或 `0.0.0.0`（所有网卡） |

### Web 界面配置

在 Dian 控制台 → 插件 → dian-dev-sync → 界面 中可修改 Token、端口和监听地址（`127.0.0.1` 或 `0.0.0.0`），保存后插件自动重载生效。

---

## 客户端用法

插件安装并配置 Token 后，开发工具通过 WebSocket 连接 `ws://<host>:<port>`（默认 `ws://127.0.0.1:3901`）进行认证和推送。

> **安全提示**：将监听地址设为 `0.0.0.0` 会暴露到所有网卡，请确保已配置强 Token 并限制防火墙端口。

### 认证

发送 JSON：

```json
{"type": "auth", "token": "your-token", "pluginName": "my-plugin"}
```

服务端 5 秒内响应 `{"type": "auth-result", "ok": true}`。

### 推送构建产物

认证成功后发送：

```json
{"type": "push-bundle", "pluginName": "my-plugin", "bundle": "<base64(zip)>"}
```

服务端响应流程：

1. `{"type": "bundle-accepted", "ok": true}` — 收到 bundle，开始解压
2. `{"type": "reload-complete", "ok": true}` — 写入完成，插件已热重载

### Python 测试客户端

项目附带 `test-client.py`（依赖 `websocket-client`）：

```bash
pip install websocket-client
python test-client.py --token your-token --plugin-name my-plugin --dist ./dist
```

---

## Web 管理界面

插件附带完整的 React Web UI，在 Dian 控制台 → 插件 → dian-dev-sync → 界面 中访问。

| 功能 | 说明 |
|------|------|
| 状态概览 | WS 端口、监听地址、当前连接数、Token 状态 |
| 配置编辑 | 在线修改 Token、端口和监听地址（`127.0.0.1` / `0.0.0.0`），保存后自动重载 |
| 会话列表 | 实时查看已连接的开发会话，支持手动断开 |
| 同步历史 | 最近 50 次同步记录（状态、大小、时间） |

## HTTP API

所有端点位于 `/plugins/dian-dev-sync/api/`：

| 方法 | 路径 | 说明 |
|------|------|--------|
| GET | `/status` | 当前会话列表与端口 |
| GET | `/config` | 当前配置（端口、监听地址、是否有 Token） |
| POST | `/config` | 更新 Token / 端口 / 监听地址 |
| POST | `/disconnect` | 断开指定插件名的连接 |
| GET | `/history` | 最近 50 条同步历史 |

---

## 开发

```bash
# 安装依赖
npm install

# 构建插件逻辑 + Web UI
npm run build

# 监听模式开发
npm run dev:plugin   # 监听编译插件逻辑
npm run dev:ui       # 监听编译插件 UI

# 打包为 ZIP
npm run pack
```

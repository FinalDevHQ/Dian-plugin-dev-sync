import { useState, useEffect, useCallback, useRef } from "react"
import {
  Card, CardHeader, CardContent, CardDescription, Label, Input, Button, Badge, StatCard,
} from "./components"
import { fmtTime, fmtDuration, copyToClipboard } from "./utils"
import { apiFetch } from "./api"

// ────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────

interface ConfigResponse {
  ok: boolean
  port: number
  host: "127.0.0.1" | "0.0.0.0"
  hasToken: boolean
}

interface SessionItem {
  pluginName: string
  connectedAt: number
  lastSyncAt?: number
}

interface StatusResponse {
  ok: boolean
  sessions: SessionItem[]
  port: number
}

interface HistoryItem {
  id: number
  plugin_name: string
  status: "success" | "error"
  message: string
  bundle_size: number | null
  created_at: string
}

interface HistoryResponse {
  ok: boolean
  items: HistoryItem[]
}

const API = "/plugins/dian-dev-sync/api"

// ────────────────────────────────────────────────────────────────────────────
// 主组件
// ────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [port, setPort] = useState(3901)
  const [host, setHost] = useState<"127.0.0.1" | "0.0.0.0">("127.0.0.1")
  const [saving, setSaving] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [genLoading, setGenLoading] = useState(false)
  const initializedRef = useRef(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  const [now, setNow] = useState(Date.now())

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 2500)
  }

  const load = useCallback(async () => {
    try {
      const [cfg, status, hist] = await Promise.all([
        apiFetch(`${API}/config`).then((r) => r.json()) as Promise<ConfigResponse>,
        apiFetch(`${API}/status`).then((r) => r.json()) as Promise<StatusResponse>,
        apiFetch(`${API}/history`).then((r) => r.json()) as Promise<HistoryResponse>,
      ])
      setConfig(cfg)
      setSessions(status.sessions ?? [])
      setHistory(hist.items ?? [])
      if (!initializedRef.current) {
        setPort(cfg.port)
        setHost(cfg.host ?? "127.0.0.1")
        initializedRef.current = true
      }
      setError(null)
    } catch {
      setError("无法连接到插件 API")
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  // 实时刷新连接时长
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const save = async () => {
    if (!token.trim() && !config?.hasToken) {
      showToast("请输入 Token", false)
      return
    }
    setSaving(true)
    try {
      const res = await apiFetch(`${API}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), port, host }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (data.ok) {
        showToast("保存成功，插件将自动重载")
        setToken("")
        initializedRef.current = false
        setTimeout(() => load(), 800)
      } else {
        showToast(data.error ?? "保存失败", false)
      }
    } catch {
      showToast("保存失败", false)
    } finally {
      setSaving(false)
    }
  }

  const generateToken = async () => {
    setGenLoading(true)
    try {
      const res = await apiFetch(`${API}/generate-token`, { method: "POST" })
      const data = (await res.json()) as { ok?: boolean; token?: string; error?: string }
      if (data.ok && data.token) {
        const copied = await copyToClipboard(data.token)
        showToast(copied ? "新 Token 已生成并复制到剪贴板" : "新 Token 已生成")
        initializedRef.current = false
        setTimeout(() => load(), 800)
      } else {
        showToast(data.error ?? "生成失败", false)
      }
    } catch {
      showToast("生成失败", false)
    } finally {
      setGenLoading(false)
    }
  }

  const clearHistory = async () => {
    if (!confirm("确定要清空所有同步历史记录吗？")) return
    try {
      const res = await apiFetch(`${API}/history`, { method: "DELETE" })
      const data = (await res.json()) as { ok?: boolean }
      if (data.ok) {
        showToast("历史记录已清空")
        load()
      } else {
        showToast("清空失败", false)
      }
    } catch {
      showToast("清空失败", false)
    }
  }

  const disconnect = async (pluginName: string) => {
    try {
      const res = await apiFetch(`${API}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginName }),
      })
      const data = (await res.json()) as { ok?: boolean }
      if (data.ok) {
        showToast("已断开")
        load()
      } else {
        showToast("断开失败", false)
      }
    } catch {
      showToast("断开失败", false)
    }
  }

  return (
    <div className="min-h-screen p-6 flex flex-col gap-5 max-w-5xl mx-auto">

      {/* ── 标题 ────────────────────────────────────────────── */}
      <header className="flex items-center gap-3.5">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary text-lg shadow-sm">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
            <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
            <line x1="4" y1="4" x2="9" y2="9" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold tracking-tight leading-none">Dev Sync</h1>
            <Badge className={
              config
                ? "border-emerald-500/30 bg-emerald-50 text-emerald-700"
                : "border-border bg-muted/60 text-muted-foreground"
            }>
              {config ? "运行中" : "加载中"}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground truncate">
            {error ? error : `WS ${config?.host ?? "—"}:${config?.port ?? "—"}`}
          </p>
        </div>
      </header>

      {/* ── 统计卡片 ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "监听地址", value: config?.host ?? "—", mono: true },
          { label: "WS 端口", value: config?.port ?? "—", mono: true },
          { label: "当前连接", value: sessions.length },
          { label: "Token 状态", value: config?.hasToken ? "已设置" : "未设置" },
        ].map(s => (
          <Card key={s.label} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">{s.label}</span>
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                s.label === "Token 状态"
                  ? config?.hasToken
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-amber-50 text-amber-700 border-amber-200"
                  : s.label === "当前连接"
                    ? sessions.length > 0
                      ? "bg-primary/10 text-primary border-primary/20"
                      : "bg-muted text-muted-foreground border-border"
                    : "bg-primary/10 text-primary border-primary/20"
              }`}>
                {s.value}
              </span>
            </div>
            <div className={`text-xl font-bold tabular-nums ${s.mono ? "font-mono" : ""}`}>{s.value}</div>
          </Card>
        ))}
      </div>

      {/* ── 配置编辑 ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <Label>配置</Label>
          <CardDescription>
            设置认证 Token 和 WS 服务端口，保存后插件将自动重载生效
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {/* Token 行 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">认证 Token</span>
              <div className="flex gap-2">
                <Input
                  type={showToken ? "text" : "password"}
                  placeholder={config?.hasToken ? "已设置（输入新值覆盖）" : "请输入 Token"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  className="shrink-0 px-2.5"
                  onClick={() => setShowToken((v) => !v)}
                  title={showToken ? "隐藏" : "显示"}
                >
                  {showToken ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  )}
                </Button>
                <Button
                  variant="secondary"
                  className="shrink-0 text-xs"
                  onClick={generateToken}
                  disabled={genLoading}
                  title="自动生成安全的随机 Token"
                >
                  {genLoading ? (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  )}
                  随机生成
                </Button>
              </div>
            </div>

            {/* 端口 & 地址 行 */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">监听地址</span>
                <select
                  value={host}
                  onChange={(e) => setHost(e.target.value as "127.0.0.1" | "0.0.0.0")}
                  className="flex h-9 w-full rounded-lg border bg-background px-3 py-1 text-sm outline-none transition-all duration-150 focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[3px]"
                >
                  <option value="127.0.0.1">127.0.0.1（仅本地）</option>
                  <option value="0.0.0.0">0.0.0.0（所有网卡）</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">端口</span>
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </div>
            </div>

            {/* 警告 */}
            {host === "0.0.0.0" && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50 px-3 py-2.5 text-xs text-amber-700">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                监听 0.0.0.0 会暴露到所有网卡，请确保已配置强 Token 并限制防火墙端口。
              </div>
            )}

            {/* 保存按钮 */}
            <div className="flex justify-end">
              <Button onClick={save} disabled={saving} className="px-6">
                {saving ? (
                  <>
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                    保存中…
                  </>
                ) : "保存配置"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 会话列表 ─────────────────────────────────────────── */}
      <Card className="flex-1">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <Label>远程开发会话</Label>
              <CardDescription>正在通过 WebSocket 实时同步构建产物的插件项目</CardDescription>
            </div>
            {sessions.length > 0 && (
              <Badge className="border-primary/30 bg-primary/10 text-primary">
                {sessions.length} 个连接
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-2 text-muted-foreground">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
              <span className="text-xs">暂无连接</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {sessions.map((s) => (
                <div
                  key={`${s.pluginName}-${s.connectedAt}`}
                  className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3.5 py-2.5 text-xs group hover:bg-muted/50 transition-colors"
                >
                  <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="truncate font-medium text-foreground">{s.pluginName}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {fmtDuration(now - s.connectedAt)}
                  </span>
                  {s.lastSyncAt && (
                    <span className="shrink-0 text-muted-foreground">
                      {fmtTime(s.lastSyncAt)} 同步
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => disconnect(s.pluginName)}
                  >
                    断开
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 同步历史 ─────────────────────────────────────────── */}
      <Card className="flex-1">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <Label>同步历史</Label>
              <CardDescription>最近 50 次插件同步记录</CardDescription>
            </div>
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={clearHistory}
              >
                清空记录
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-2 text-muted-foreground">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span className="text-xs">暂无记录</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto scrollbar-thin">
              {history.map((h) => (
                <div
                  key={`${h.id}-${h.created_at}`}
                  className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3.5 py-2.5 text-xs hover:bg-muted/50 transition-colors"
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      h.status === "success" ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <span className="truncate font-medium text-foreground min-w-0">{h.plugin_name}</span>
                  <Badge
                    className={
                      h.status === "success"
                        ? "border-emerald-500/30 bg-emerald-50 text-emerald-700"
                        : "border-red-500/30 bg-red-50 text-red-700"
                    }
                  >
                    {h.status === "success" ? "成功" : "失败"}
                  </Badge>
                  {h.bundle_size !== null && (
                    <span className="shrink-0 text-muted-foreground font-mono tabular-nums">
                      {(h.bundle_size / 1024).toFixed(1)} KB
                    </span>
                  )}
                  <span className="truncate text-muted-foreground min-w-0">{h.message}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground text-[11px]">
                    {new Date(h.created_at).toLocaleString(navigator.language || "en-US")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Toast ──────────────────────────────────────────── */}
      {toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 rounded-xl border px-4 py-2.5 text-sm font-medium shadow-lg flex items-center gap-2.5 animate-slide-in ${
            toast.ok
              ? "border-emerald-500/30 bg-emerald-50 text-emerald-700 shadow-emerald-500/10"
              : "border-red-500/30 bg-red-50 text-red-700 shadow-red-500/10"
          }`}
        >
          {toast.ok ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          )}
          {toast.msg}
        </div>
      )}
    </div>
  )
}

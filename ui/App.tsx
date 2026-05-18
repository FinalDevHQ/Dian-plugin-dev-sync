import { useState, useEffect, useCallback, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react"

// ────────────────────────────────────────────────────────────────────────────
// 内联 shadcn 风格小组件
// ────────────────────────────────────────────────────────────────────────────

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border bg-card text-card-foreground shadow-sm ${className}`}>{children}</div>
}

function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-1 px-5 pt-4 pb-2 ${className}`}>{children}</div>
}

function CardContent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 pb-5 ${className}`}>{children}</div>
}

function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h3 className={`text-sm font-semibold ${className}`}>{children}</h3>
}

function CardDescription({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs text-muted-foreground ${className}`}>{children}</p>
}

function Label({ children, htmlFor, className = "" }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={`text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${className}`}>
      {children}
    </label>
  )
}

function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`flex h-9 w-full min-w-0 rounded-md border bg-input/30 px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    />
  )
}

type ButtonVariant = "default" | "secondary" | "ghost"
type ButtonSize = "default" | "sm"
function Button({
  variant = "default",
  size = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const variants: Record<ButtonVariant, string> = {
    default:   "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "bg-accent text-accent-foreground hover:bg-accent/80",
    ghost:     "hover:bg-accent hover:text-accent-foreground",
  }
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${className}`}
    />
  )
}

function Badge({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${className}`}>
      {children}
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// 类型 + 工具
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

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

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
  const initializedRef = useRef(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 2500)
  }

  const load = useCallback(async () => {
    try {
      const [cfg, status, hist] = await Promise.all([
        fetch(`${API}/config`).then((r) => r.json()) as Promise<ConfigResponse>,
        fetch(`${API}/status`).then((r) => r.json()) as Promise<StatusResponse>,
        fetch(`${API}/history`).then((r) => r.json()) as Promise<HistoryResponse>,
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
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [load])

  const save = async () => {
    if (!token.trim() && !config?.hasToken) {
      showToast("请输入 Token", false)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${API}/config`, {
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

  const disconnect = async (pluginName: string) => {
    try {
      const res = await fetch(`${API}/disconnect`, {
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
    <div className="min-h-screen p-5 flex flex-col gap-4">
      {/* ── 标题 ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg border bg-card text-2xl shadow-sm">
          🛠️
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold leading-none">Dian Dev Sync</h1>
            <Badge className="border-emerald-600/30 bg-emerald-500/10 text-emerald-700">
              {config ? "运行中" : "加载中"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {error ? error : `WS ${config?.host ?? "—"}:${config?.port ?? "—"}`}
          </p>
        </div>
      </div>

      {/* ── 统计卡片 ─────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="监听地址" value={config?.host ?? "—"} mono />
        <StatCard label="WS 端口" value={config?.port ?? "—"} mono />
        <StatCard label="当前连接" value={sessions.length} />
        <StatCard label="Token 状态" value={config?.hasToken ? "已设置" : "未设置"} />
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
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">认证 Token</span>
              <div className="flex gap-2">
                <Input
                  type={showToken ? "text" : "password"}
                  placeholder={config?.hasToken ? "已设置（输入新值覆盖）" : "请输入 Token"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                />
                <Button
                  variant="ghost"
                  className="shrink-0 px-2"
                  onClick={() => setShowToken((v) => !v)}
                  title={showToken ? "隐藏" : "显示"}
                >
                  {showToken ? "🙈" : "👁️"}
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">监听地址</span>
              <select
                value={host}
                onChange={(e) => setHost(e.target.value as "127.0.0.1" | "0.0.0.0")}
                className="flex h-9 w-full min-w-0 rounded-md border bg-input/30 px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              >
                <option value="127.0.0.1">127.0.0.1（仅本地）</option>
                <option value="0.0.0.0">0.0.0.0（所有网卡）</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">端口</span>
              <Input
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={save}
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
          {host === "0.0.0.0" && (
            <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠️ 监听 0.0.0.0 会暴露到所有网卡，请确保已配置强 Token 并限制防火墙端口。
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 会话列表 ─────────────────────────────────────────── */}
      <Card className="flex-1">
        <CardHeader>
          <Label>远程开发会话</Label>
          <CardDescription>正在通过 WebSocket 实时同步构建产物的插件项目</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无连接</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sessions.map((s) => (
                <div
                  key={s.pluginName}
                  className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                >
                  <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
                  <span className="truncate font-medium text-foreground">{s.pluginName}</span>
                  <span className="shrink-0 text-muted-foreground">
                    连接 {fmtTime(s.connectedAt)}
                  </span>
                  {s.lastSyncAt && (
                    <span className="shrink-0 text-muted-foreground">
                      同步 {fmtTime(s.lastSyncAt)}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 px-2 text-xs"
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
          <Label>同步历史</Label>
          <CardDescription>最近 50 次插件同步记录</CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无记录</p>
          ) : (
            <div className="flex flex-col gap-2">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      h.status === "success" ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <span className="truncate font-medium text-foreground">{h.plugin_name}</span>
                  <Badge
                    className={
                      h.status === "success"
                        ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-700"
                        : "border-red-600/30 bg-red-500/10 text-red-700"
                    }
                  >
                    {h.status === "success" ? "成功" : "失败"}
                  </Badge>
                  {h.bundle_size !== null && (
                    <span className="shrink-0 text-muted-foreground">
                      {(h.bundle_size / 1024).toFixed(1)} KB
                    </span>
                  )}
                  <span className="truncate text-muted-foreground">{h.message}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {new Date(h.created_at).toLocaleString("zh-CN")}
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
          className={`fixed bottom-4 right-4 rounded-md border px-3 py-2 text-xs shadow-lg ${
            toast.ok
              ? "border-emerald-600/40 bg-emerald-50 text-emerald-700"
              : "border-red-600/40 bg-red-50 text-red-700"
          }`}
        >
          {toast.ok ? "✓" : "✗"} {toast.msg}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string | number
  mono?: boolean
}) {
  return (
    <Card className="px-4 py-3">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className={`truncate text-2xl font-bold tabular-nums ${mono ? "font-mono" : ""}`}>
          {value}
        </span>
      </div>
    </Card>
  )
}

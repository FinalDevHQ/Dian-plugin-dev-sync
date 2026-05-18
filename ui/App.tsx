import { useState, useEffect, useCallback, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react"

// ────────────────────────────────────────────────────────────────────────────
// 内联 shadcn 风格小组件（保持模板单文件，不依赖 components/ui）
// ────────────────────────────────────────────────────────────────────────────

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border bg-card text-card-foreground shadow-sm ${className}`}
    >
      {children}
    </div>
  )
}

function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-col gap-1 px-5 pt-4 pb-2 ${className}`}>{children}</div>
}

function CardContent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`px-5 pb-5 ${className}`}>{children}</div>
}

function Label({ children, htmlFor, className = "" }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={`text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${className}`}
    >
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
function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
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
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${className}`}
    >
      {children}
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// 类型 + 工具
// ────────────────────────────────────────────────────────────────────────────

interface RecentPing {
  sender: string
  userId?: string
  group?: string
  time: number
}

interface Config { command: string; reply: string }

interface Status {
  startTime: number
  pingCount: number
  config: Config
  recentPings: RecentPing[]
}

// 与 @dian/plugin-runtime 的 PluginPublicMeta 对齐（仅保留本页用得到的字段）
interface PluginMetaInfo {
  name: string
  handlers: { method: string; pattern: string }[]
  commands: { name: string; pattern: string; description?: string }[]
  routes: { method: string; path: string }[]
}

const PLUGIN_NAME = "ping-pong"

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = String(Math.floor(s / 3600)).padStart(2, "0")
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0")
  const sec = String(s % 60).padStart(2, "0")
  return `${h}:${m}:${sec}`
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

const API = "/plugins/ping-pong/api"

// ────────────────────────────────────────────────────────────────────────────
// 主组件
// ────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [meta, setMeta]     = useState<PluginMetaInfo | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [cmd, setCmd]       = useState("")
  const [reply, setReply]   = useState("")
  const [saving, setSaving] = useState(false)
  const [uptime, setUptime] = useState("—")
  const [toast, setToast]   = useState<{ msg: string; ok: boolean } | null>(null)

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 2500)
  }

  const load = useCallback(async () => {
    try {
      // 并发拉插件自身状态 + 宿主 /plugins 列表（后者拿到已注册的指令/路由详情）
      const [data, metaList] = await Promise.all([
        fetch(`${API}/status`).then((r) => r.json()) as Promise<Status>,
        fetch("/plugins").then((r) => r.json()).then(
          (j: { plugins: PluginMetaInfo[] }) => j.plugins
        ).catch(() => [] as PluginMetaInfo[]),
      ])
      setStatus(data)
      setMeta(metaList.find((p) => p.name === PLUGIN_NAME) ?? null)
      setError(null)
      setCmd((prev) => prev || data.config.command)
      setReply((prev) => prev || data.config.reply)
    } catch {
      setError("无法连接到插件 API")
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (!status?.startTime) return
    const start = status.startTime
    const t = setInterval(() => setUptime(fmtUptime(Date.now() - start)), 1000)
    return () => clearInterval(t)
  }, [status?.startTime])

  const save = async () => {
    if (!cmd.trim() || !reply.trim()) return
    setSaving(true)
    try {
      await fetch(`${API}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, reply }),
      })
      showToast("保存成功")
      load()
    } catch {
      showToast("保存失败", false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen p-5 flex flex-col gap-4">
      {/* ── 标题 ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg border bg-card text-2xl shadow-sm">
          🏓
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold leading-none">Ping-Pong</h1>
            <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              {status ? "运行中" : "加载中"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">
            {error
              ? error
              : status
              ? <>指令 <span className="font-mono text-foreground">{status.config.command}</span> → <span className="font-mono text-foreground">{status.config.reply}</span></>
              : "—"}
          </p>
        </div>
      </div>

      {/* ── 统计卡片 ─────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="运行时长"  value={uptime} />
        <StatCard label="触发次数"  value={status?.pingCount ?? "—"} />
        <StatCard label="触发指令"  value={status?.config.command ?? "—"} mono />
      </div>

      {/* ── 配置编辑 ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <Label>配置</Label>
          <p className="text-xs text-muted-foreground">
            「触发指令」和「回复内容」均立即生效，无需重启
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">触发指令</span>
              <Input
                placeholder="!ping"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">回复内容</span>
              <Input
                placeholder="pong! 🏓"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={save}
                disabled={saving || !cmd.trim() || !reply.trim()}
                className="w-full sm:w-auto"
              >
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 已注册：指令 + 路由 + 事件处理器 ────────────────── */}
      <Card>
        <CardHeader>
          <Label>已注册</Label>
          <p className="text-xs text-muted-foreground">
            从宿主 <span className="font-mono">/plugins</span> 接口实时获取，热重载后同步更新
          </p>
        </CardHeader>
        <CardContent>
          {!meta ? (
            <p className="py-4 text-center text-sm text-muted-foreground">暂无数据</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              {/* 指令 */}
              <RegSection title="指令" count={meta.commands.length} empty="未注册指令">
                {meta.commands.map((c, i) => (
                  <div key={i} className="flex flex-col gap-0.5 rounded-md border bg-muted/30 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-400">
                        {c.name}
                      </Badge>
                      <code className="font-mono text-[11px] text-muted-foreground truncate">{c.pattern}</code>
                    </div>
                    {c.description && (
                      <p className="text-[11px] text-muted-foreground truncate">{c.description}</p>
                    )}
                  </div>
                ))}
              </RegSection>

              {/* API 路由 */}
              <RegSection title="API 路由" count={meta.routes.length} empty="未注册路由">
                {meta.routes.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                    <MethodBadge method={r.method} />
                    <code className="font-mono text-[11px] truncate">
                      <span className="text-muted-foreground">/plugins/{PLUGIN_NAME}/api</span>
                      <span>{r.path}</span>
                    </code>
                  </div>
                ))}
              </RegSection>

              {/* 事件处理器（@Handler） */}
              <RegSection title="事件处理器" count={meta.handlers.length} empty="未注册 @Handler">
                {meta.handlers.map((h, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                    <Badge className="border-violet-500/30 bg-violet-500/10 text-violet-400 font-mono">
                      {h.method}
                    </Badge>
                    <code className="font-mono text-[11px] text-muted-foreground truncate">{h.pattern}</code>
                  </div>
                ))}
              </RegSection>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 最近触发 ─────────────────────────────────────────── */}
      <Card className="flex-1">
        <CardHeader>
          <Label>最近触发</Label>
        </CardHeader>
        <CardContent>
          {!status?.recentPings.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无记录</p>
          ) : (
            <div className="flex max-h-60 flex-col gap-1.5 overflow-y-auto pr-1">
              {status.recentPings.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs"
                >
                  <span className="truncate font-medium text-foreground">{p.sender}</span>
                  {p.userId && (
                    <span className="shrink-0 font-mono text-muted-foreground">
                      QQ {p.userId}
                    </span>
                  )}
                  {p.group && (
                    <Badge className="shrink-0 border-border bg-muted text-muted-foreground">
                      群 {p.group}
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {fmtTime(p.time)}
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
              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              : "border-destructive/40 bg-destructive/15 text-destructive"
          }`}
        >
          {toast.ok ? "✓" : "✗"} {toast.msg}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────

function RegSection({
  title,
  count,
  empty,
  children,
}: {
  title: string
  count: number
  empty: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{title}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
      </div>
      {count === 0 ? (
        <p className="rounded-md border border-dashed py-4 text-center text-[11px] text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">{children}</div>
      )}
    </div>
  )
}

function MethodBadge({ method }: { method: string }) {
  const cls: Record<string, string> = {
    GET:    "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    POST:   "border-blue-500/30 bg-blue-500/10 text-blue-400",
    PUT:    "border-amber-500/30 bg-amber-500/10 text-amber-400",
    PATCH:  "border-violet-500/30 bg-violet-500/10 text-violet-400",
    DELETE: "border-red-500/30 bg-red-500/10 text-red-400",
  }
  return (
    <Badge className={`shrink-0 font-mono ${cls[method] ?? ""}`}>
      {method}
    </Badge>
  )
}

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
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span
          className={`truncate text-2xl font-bold tabular-nums ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </span>
      </div>
    </Card>
  )
}

const TOKEN_KEY = "dian_token"

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY)
  const headers = new Headers(init.headers)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const res = await fetch(input, { ...init, headers })
  if (res.status === 401) {
    throw new Error("未登录或登录已过期，请刷新主控制台后重新登录")
  }
  return res
}

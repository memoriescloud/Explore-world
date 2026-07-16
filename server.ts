// EPC 答题辅助 · Deno Deploy 同步后端
// 与本地 server.js 接口完全兼容，前端 app.js 一行都不用改。
// 存储由「本地 JSON 文件」改为「Deno KV」（托管持久化，重启/缩容不丢数据）。
//
// 本地运行: deno run --allow-net --allow-read --allow-env server.ts
// 部署:     在 console.deno.com 用 GitHub 仓库部署（详见 README.md）
//
// 重要：部署前必须在 Deno 控制台（console.deno.com）的
//       组织 → Databases 里 Provision 一个 Deno KV 数据库，
//       并在实例列表点 "Assign" 把它挂到本应用，否则 Deno.openKv() 会报错。

const ROOT = Deno.cwd();
const MAX_BODY = 8 * 1024 * 1024; // 8MB 上限，防滥用

// 仅允许同步这些键，避免任意数据写入
const ALLOWED_KEYS = [
  "epc_wrong_v1", "epc_stats_v1", "epc_settings_v1", "epc_daily_v1",
  "epc_seen_v1", "epc_correct_v1", "epc_shown_v1",
];

// 本地默认用 ./deno_kv.db；在 Deno Deploy 上自动连到已分配的托管 KV
let kv: Deno.Kv;
try {
  kv = await Deno.openKv();
} catch (e) {
  console.error(
    "无法打开 KV。若在 Deno Deploy 上运行，请先到 console.deno.com 的组织" +
    " Databases 里 Provision 一个 Deno KV，并在列表点 Assign 挂到本应用。",
  );
  throw e;
}

type SyncRecord = { ts: number; payload: Record<string, unknown> };

// uid 即密钥：8–64 位字母/数字/下划线/连字符
function isValidUid(u: string | null): u is string {
  return typeof u === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(u);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json",
};

// 禁止直接访问服务端/敏感文件
const FORBIDDEN = /^\/(server\.ts|convert\.py|package\.json|deno\.json|deno_kv\.db|README\.md|\.git)/;

async function serveStatic(pathname: string): Promise<Response> {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  // 阻断路径穿越与敏感文件
  if (rel.includes("..") || FORBIDDEN.test(rel)) {
    return new Response("forbidden", { status: 403 });
  }
  // 拼接并校验仍在根目录内（Deno 在 Windows/Linux 均接受正斜杠）
  const filePath = ROOT + rel;
  if (!filePath.startsWith(ROOT)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const stat = await Deno.stat(filePath);
    if (!stat.isFile) return new Response("not found", { status: 404 });
    const data = await Deno.readFile(filePath);
    const dot = filePath.lastIndexOf(".");
    const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
    return new Response(data, {
      status: 200,
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (pathname === "/api/data") {
    const uid = url.searchParams.get("uid");

    if (req.method === "GET") {
      if (!isValidUid(uid)) return json({ error: "invalid uid" }, 400);
      const rec = await kv.get<SyncRecord>(["sync", uid]);
      if (!rec.value) return json({ ts: 0, payload: null });
      return json({ ts: rec.value.ts, payload: rec.value.payload });
    }

    if (req.method === "PUT" || req.method === "POST") {
      if (!isValidUid(uid)) return json({ error: "invalid uid" }, 400);
      const raw = await req.text();
      if (raw.length > MAX_BODY) return json({ error: "payload too large" }, 413);
      let data: { ts?: unknown; payload?: unknown };
      try {
        data = JSON.parse(raw);
      } catch {
        return json({ error: "bad json" }, 400);
      }
      if (typeof data.ts !== "number" || !data.payload || typeof data.payload !== "object") {
        return json({ error: "bad body" }, 400);
      }
      const clean: Record<string, unknown> = {};
      const payload = data.payload as Record<string, unknown>;
      for (const k of ALLOWED_KEYS) {
        if (k in payload) clean[k] = payload[k];
      }
      const prev = await kv.get<SyncRecord>(["sync", uid]);
      if (prev.value && prev.value.ts >= (data.ts as number)) {
        return json({ ts: prev.value.ts, payload: prev.value.payload, ignored: true });
      }
      await kv.set(["sync", uid], { ts: data.ts as number, payload: clean });
      return json({ ts: data.ts as number, ok: true });
    }

    return new Response("method not allowed", { status: 405 });
  }

  return await serveStatic(pathname);
}

// Deno Deploy 由平台接管端口；本地运行默认监听 8000。
// 如需改端口，本地可用 `PORT=3000 deno run ...` 并自行加回 port 选项。
console.log("EPC 同步服务已启动（Deno Deploy 模式）");
Deno.serve(handler);

# EPC 答题辅助 · Deno Deploy 部署指南

本目录即为部署到 Deno Deploy 的仓库根目录。应用文件（index.html / app.js / style.css / data/questions.js / server.ts）都在根目录，符合 Deno Deploy 新版要求。

---

## 一、你已在之前完成的

- ✅ 注册了 GitHub 账号
- ✅ GitHub 已授权绑定 Deno Deploy（在 console.deno.com 用 GitHub 登录过）

## 二、一次性：在本机装 Deno（只需要装一次）

打开 PowerShell，执行以下任一条：

```powershell
# 方法 A（推荐，Windows 应用商店式）
winget install DenoLand.Deno

# 方法 B（官方脚本）
irm https://deno.land/install.ps1 | iex
```

装完后**重开一个 PowerShell**，输入 `deno --version` 能看到版本号即成功。

## 三、把代码推到 GitHub（只需做一次）

1. 打开 https://github.com → 右上角 **+** → **New repository**
   - Repository name 随便起，例如 `epc-sync`
   - 选 **Private（私有）** 也可以，Deno Deploy 有权限访问
   - **不要**勾选 "Add a README"、"Add .gitignore"、"Choose a license" → 创建**空仓库**
2. 创建后，GitHub 会显示一个快速设置页，复制里面的仓库地址（形如 `https://github.com/你的用户名/epc-sync.git`）
3. 在本机 PowerShell 进入本项目目录，执行（把地址换成你自己的）：

```powershell
cd C:\Users\Tian\WorkBuddy\2026-07-15-09-28-44
git remote add origin https://github.com/你的用户名/epc-sync.git
git branch -M main
git push -u origin main
```

> 第一次 `git push` 会弹出浏览器让你登录 GitHub（Git 凭据管理器），登录后自动完成推送。
> 如果弹出的是命令行要你输入用户名密码：用户名填 GitHub 账号，密码处要用 **Personal Access Token**（不是账号密码）。嫌麻烦就用上面的浏览器登录方式，或装 **GitHub Desktop** 用界面推送。

## 四、在 Deno 控制台用 GitHub 仓库部署

1. 打开 https://console.deno.com → 用 GitHub 登录
2. **创建组织（Create organization）**
   - 填组织名（slug）；**注意：名字创建后不可改**，建议用简单好记的，如 `epc`
   - 若提示安装 GitHub App，按提示授权 Deno Deploy 访问你的仓库（至少授权 `epc-sync` 这个仓库）
3. 进入组织后点 **+ New App**
4. **Select a repo**：选刚才的 `epc-sync` 仓库（若看不到，点 "Configure GitHub App permissions" 重新授权）
5. **配置应用（Edit build config）**：
   - Framework preset：**No Preset**
   - Runtime configuration：**Dynamic**
   - Dynamic Entrypoint：**server.ts**
   - Install command / Build command：**都留空**
6. 点 **Create App** → 等待构建（实时日志），完成后得到地址，形如：
   ```
   https://epc-sync.epc.deno.net
   ```
   这个就是你的"在线答题地址"，自带 HTTPS。

## 五、挂载 KV 数据库（必须，否则后端启动报错）

1. 在 console.deno.com 进入你的**组织** → 左侧 **Databases** → 点 **Provision Database**
2. 引擎选 **Deno KV**，起个名字（如 `epc-kv`），保存
3. 在数据库实例列表里，点该数据库右侧的 **Assign** → 从下拉里选你的应用（`epc-sync`）→ 状态变 **Connected**
4. 回到应用页，重新触发一次部署（Push 一次代码，或点重启/重新部署），让 KV 生效

## 六、开始使用

- 每台设备浏览器打开 `https://epc-sync.epc.deno.net`
- 进「我的进度 → ☁ 云端同步」，把**同步码设成同一个**（如 `epchome2026`），点「立即同步」
- 之后任意设备做题，其他设备自动同步；笔记本关机也不影响

## 七、以后改了题目怎么更新

本项目目录下 `data/questions.js` 若需更新，改完后在本机执行：

```powershell
cd C:\Users\Tian\WorkBuddy\2026-07-15-09-28-44
git add -A
git commit -m "更新题目"
git push
```

Deno Deploy 检测到推送会自动重新部署，几秒后生效。

## 八、本地预览（可选）

```powershell
deno run --allow-net --allow-read --allow-env server.ts
# 然后浏览器打开 http://localhost:8000
# 本地 KV 会存成 deno_kv.db 文件，与云端互不干扰
```

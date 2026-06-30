# Digital CAS · TOK Exhibition 数字人

为 IBDP TOK Exhibition 打造的「数字人」互动导览。后台上传每位同学的**大头照**和**讲稿**，
系统为每人生成一个**专属二维码（一人一码）**。访客扫码后，在手机上遇见这位同学的数字人：
先选择想听哪一部分，听完可以**追问**，或**听其他部分** —— AI 依据讲稿自然作答。

> 状态：本地端到端已跑通（含演示数据，无需任何密钥）。接入 packyapi key 即为真实 AI 回答；
> 配置 D-ID 即为真实对口型视频。部署到 Vercel 需多做一步「持久化存储」，见下文。

---

## ✨ 功能

- **后台上传界面**：照片 + 讲稿（直接粘贴 txt，或上传 **PDF / Word(.docx) / txt** 自动提取文字）。
- **AI 智能分段**：自动把讲稿切成「引入 / Object 1 / …/ 结论」等部分，可手动微调。
- **一人一码**：每位同学一个二维码，扫码直达 `/p/<slug>`，可复制链接、下载二维码 PNG。
- **移动端互动**（简洁现代风格）：
  - 选择「想先听哪一部分」→ 数字人讲解；
  - 听完弹出「追问」输入框 + 推荐问题，或随时「听其他部分」；
  - 回答**跟随提问语言**（中文问中文答、英文问英文答），右上角可手动切换中/EN。
- **会说话头像**：先用 packyapi 生成回答文字 → 再交给数字人模型生成对口型视频（D-ID）。
  未配置视频服务时，自动降级为「照片 + 浏览器语音朗读」，整套流程依然可用。

---

## 🚀 本地快速开始

```bash
npm install
cp .env.example .env.local      # 填入密码等（AI/视频 key 可留空 = 演示模式）
npm run seed                    # 写入 2 位示例同学（Emma / 张伟），可选
npm run dev                     # http://localhost:3000
```

- 访客页示例：<http://localhost:3000/p/emma> 、 <http://localhost:3000/p/zhangwei>
- 后台：<http://localhost:3000/admin>（密码取 `.env.local` 里的 `ADMIN_PASSWORD`）

不填任何 AI/视频密钥也能完整体验：回答用「演示模式」占位文字，头像用浏览器语音朗读。

---

## 🔑 环境变量

复制 `.env.example` 为 `.env.local`。关键项：

| 变量 | 说明 |
| --- | --- |
| `ADMIN_PASSWORD` | 后台登录密码。 |
| `NEXT_PUBLIC_BASE_URL` | 生成二维码用的公开网址（本地 `http://localhost:3000`，线上填 Vercel 域名）。 |
| `AI_API_KEY` | packyapi 的 API key。**留空 = 演示模式**（无需密钥即可跑通流程）。 |
| `AI_BASE_URL` | 默认 `https://www.packyapi.com/v1`（OpenAI 兼容）。 |
| `AI_MODEL` | 默认 `claude-3-5-sonnet-20241022`，可改成 packyapi 支持的其它模型名。 |
| `AVATAR_PROVIDER` | `mock`（默认，照片+浏览器语音）或 `did`（D-ID 对口型视频）。 |
| `DID_API_KEY` | 选 `did` 时填，D-ID 的 API key。 |
| `DID_VOICE_ID` | 通用音色，如 `en-US-JennyNeural` / `zh-CN-XiaoxiaoNeural`。 |

### 关于 packyapi

packyapi（PackyCode）是国内可直连的 OpenAI/Anthropic 兼容中转，支持 Claude 等模型。
在 <https://www.packyapi.com> 注册拿到 key，填到 `AI_API_KEY` 即可。Key 只存在服务器端环境变量，
不会写入代码、也不会发送到浏览器。

---

## 🗣️ 会说话头像（数字人）说明

设计逻辑正是你确定的：**packyapi 出文字 → 文字喂给数字人模型 → 生成对口型视频**。

- 前端先拿到回答文字并展示，随后请求 `/api/avatar` 生成视频，准备好即播放。
- `AVATAR_PROVIDER=did` 时调用 D-ID：用本人照片 + 文字 + 通用音色渲染对口型视频。
  - D-ID 需要能**公开访问的照片 URL**，所以视频功能在**部署上线后**才生效（本地 localhost 照片 D-ID 取不到，会自动回退到语音朗读）。
  - 视频渲染需要数十秒；为保证现场体验，文字会先显示/朗读，视频好了再切换。若超时则继续用语音，不会卡住。
- D-ID 国内访问与付费需自行确认；如不便，可改用其它数字人 API（接口集中在 `src/lib/avatar.ts`，替换成本低），或后续接 HeyGen / 国内厂商的实时数字人。

---

## ☁️ 部署到 Vercel

1. 把仓库导入 Vercel（Framework 自动识别为 Next.js）。
2. 在 Project → Settings → Environment Variables 填入上表变量（`NEXT_PUBLIC_BASE_URL` 用你的 Vercel 域名）。
3. **持久化存储（已内置 Vercel Blob）**：Vercel 函数文件系统是只读且临时的，所以线上自动改用 **Vercel Blob**
   （照片和数据都存 Blob，只需一个资源）。开启方法：
   - Vercel 项目 → **Storage** → **Create Database** → **Blob** → 连接到本项目。
   - Vercel 会自动注入 `BLOB_READ_WRITE_TOKEN`，**无需手填**。代码检测到它就自动切到 Blob；本地没有它则用 `./data` 文件存储。
   - 连接后 **Redeploy** 一次即生效，后台上传的人会永久保存。
4. 视频渲染较慢：Vercel Hobby 函数上限 60s，建议 **Pro（300s）** 或后续改用实时数字人（WebRTC）方案；
   即便超时，访客也会自动听到语音版回答。

> 想先不接云存储、直接上线体验：也可以部署到一台**常驻服务器**（`npm run build && npm run start`），
> 文件系统存储即可正常工作。

---

## 🗂️ 项目结构

```
src/
  app/
    page.tsx                  首页
    admin/                    后台（登录 + 仪表盘）
    p/[id]/                   访客数字人页
    api/                      后端接口
      admin/…                 登录、CRUD、文件解析、AI 分段、照片上传
      p/[id]                  访客读取的公开数据
      chat                    生成回答文字（packyapi）
      avatar                  生成对口型视频 / 语音指令
      photo/[id]              本地照片读取
  components/
    AdminApp / PersonEditor / QrModal     后台界面
    VisitorExperience / LoginForm         访客 + 登录界面
  lib/
    store.ts     数据层调度（按环境自动选 文件 / Vercel Blob）
    store-fs.ts / store-blob.ts   两种存储实现
    ai.ts        packyapi 客户端（含演示模式）
    avatar.ts    数字人提供方（mock / D-ID，可扩展）
    parse.ts     txt / pdf / docx 文本提取
    prompts.ts   提示词（语言规则、分段、讲解、追问）
    auth.ts      后台密码鉴权
scripts/seed.mjs  示例数据
```

---

## 🧭 后续可加

- 实时流式数字人（WebRTC，HeyGen/D-ID Streaming）以降低现场等待。
- 克隆每位同学的真实声音（需录制音样）。
- 后台数据看板：每位同学被问最多的问题等。
```

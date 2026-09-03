# Digital CAS · TOK Exhibition 数字人

为 IBDP TOK Exhibition 打造的「数字人」互动导览。每位同学有一个**专属二维码（一人一码）**。
访客扫码后，在手机上遇见这位同学的数字人：先选择想听哪一部分，听完可以**追问**，或**听其他部分** ——
AI 依据讲稿自然作答，数字人开口讲解。

同学可以**自己提交**照片和讲稿（`/submit`），老师在后台**审核通过**后页面上线；老师也可以直接在后台录入。

> 状态：本地端到端可跑通（含演示数据，无需任何密钥）。接入 packyapi key 即为真实 AI 回答；
> 配置 A2E 即为真实数字人（卡通形象 + 语音 + 动态视频）。线上部署到 Vercel + Blob。

---

## ✨ 功能

- **学生提交页 `/submit`**：同学自己上传照片 + 讲稿（粘贴，或上传 PDF / Word / txt 自动提取），
  点「AI 智能分段」并手动微调，提交后进入**待审核**，并得到一个专属修改链接（可反复修改、可预览自己的页面）。
- **老师后台 `/admin`**：审核 / 发布 / 下线学生提交；也可直接新增同学；生成卡通形象、动态视频、预生成讲解；
  一键复制学生提交入口的链接和二维码。
- **一人一码**：每位同学一个二维码，扫码直达 `/p/<slug>`；可复制链接、下载二维码 PNG。
- **移动端互动**：选择「想先听哪一部分」→ 数字人讲解；听完可「追问」或「听其他部分」；
  回答**跟随提问语言**（中文问中文答、英文问英文答），右上角可手动切换中 / EN。
- **数字人**（`AVATAR_PROVIDER`）：
  - `a2e`（推荐，国内可用）：用照片生成**卡通形象**；一次性生成几秒的**说话循环视频**；每次回答只做 TTS，
    语音配循环视频播放，**秒回**。也可切 `A2E_MODE=precise` 做逐句口型渲染（慢）。
  - `did`：D-ID 实时对口型（大陆不可用）。
  - `mock`：无视频，照片 + 浏览器语音朗读，零成本跑通全流程。
- **预生成讲解**：后台可提前让 AI 写好每部分的讲解，访客选中时立刻播放；追问永远实时生成。

---

## 🚀 本地快速开始

```bash
npm install
cp .env.example .env.local      # 至少填 ADMIN_PASSWORD；AI/视频 key 可留空 = 演示模式
npm run seed                    # 写入 2 位示例同学（Emma / 张伟），可选
npm run dev                     # http://localhost:3000
```

- 访客页示例：<http://localhost:3000/p/emma> 、 <http://localhost:3000/p/zhangwei>
- 学生提交：<http://localhost:3000/submit>
- 老师后台：<http://localhost:3000/admin>（密码取 `.env.local` 里的 `ADMIN_PASSWORD`）

不填任何 AI/视频密钥也能完整体验：回答用「演示模式」占位文字，头像用浏览器语音朗读。

其它脚本：`npm run typecheck`（tsc）、`npm run lint`（eslint）、`npm run build`。

---

## 🧑‍🎓 学生提交与审核流程

1. 老师在后台复制「学生提交入口」链接（或二维码）发给全班。
2. 同学打开 `/submit`：五步向导（照片 → 信息 → 讲稿 → 分段 → 确认）。讲稿到分段之间自动触发 AI 分段。
   未提交的草稿会自动保存在这台设备上，刷新或切后台后可以「继续上次的草稿」（照片需要重新选）。
3. 提交成功后同学得到：
   - **专属修改链接** `/submit/<id>?token=…`（唯一凭证，务必保存；同一台设备再次打开 `/submit` 也能找到）；
   - **预览链接** `/p/<slug>?preview=…`（只有本人和老师能看）。
4. 老师在后台「待审核」列表里预览，点「通过并发布」；之后访客扫码才能看到。
   详情栏里的「预生成讲解与语音」会一次性把每个部分的讲解文字、追问建议和语音提前做好，访客选中时零等待。
5. 同学之后任何修改都会让页面回到「待审核」，老师再次通过即可。更换照片会清掉旧的卡通/动态视频。
6. 生成卡通形象、动态视频、预生成讲解这三项会消耗 A2E / AI 额度，只有老师能操作。

---

## 🔑 环境变量

复制 `.env.example` 为 `.env.local`。关键项：

| 变量 | 说明 |
| --- | --- |
| `ADMIN_PASSWORD` | 后台登录密码。**必填**：未设置时任何人都无法登录。 |
| `ADMIN_SESSION_SECRET` | 可选，签发后台登录 cookie 的密钥；不填则用密码派生。 |
| `NEXT_PUBLIC_BASE_URL` | 二维码 / 学生链接用的公开网址（本地 `http://localhost:3000`，线上填 Vercel 域名）。 |
| `AI_API_KEY` | packyapi 的 API key。**留空 = 演示模式**。 |
| `AI_BASE_URL` / `AI_MODEL` | 默认 `https://www.packyapi.com/v1` 与 `claude-opus-4-8`。 |
| `AI_MODEL_LIVE` | 可选。现场实时回答（追问、未预生成的部分）用的更快模型；分段和预生成仍用 `AI_MODEL`。 |
| `AVATAR_PROVIDER` | `mock`（默认）/ `a2e` / `did`。 |
| `A2E_API_KEY` | 选 `a2e` 时填。 |
| `A2E_MODE` | `fast`（默认，秒回）或 `precise`（逐句口型渲染，慢）。 |
| `A2E_TTS_ID_MALE` / `A2E_TTS_ID_FEMALE` / `A2E_TTS_ID` | 音色 id，默认为多语言男声 / 女声。 |
| `A2E_CARTOON_MODEL` | 卡通化模型，默认 `nano-banana-pro`。 |
| `DID_API_KEY` / `DID_VOICE_ID` | 选 `did` 时填。 |
| `BLOB_READ_WRITE_TOKEN` | Vercel 连接 Blob 后自动注入，**无需手填**。 |

### 关于 packyapi

packyapi（PackyCode）是国内可直连的 OpenAI/Anthropic 兼容中转，支持 Claude 等模型。
在 <https://www.packyapi.com> 注册拿到 key，填到 `AI_API_KEY` 即可。Key 只存在服务器端环境变量，
不会写入代码、也不会发送到浏览器。

---

## 🗣️ 数字人说明（A2E）

流程：**packyapi 出文字 → A2E 出语音 → 前端把语音配到该同学的循环视频上播放**。

- 后台「生成卡通形象」：用本人照片生成轻卡通（还认得出是谁），用于访客端显示与说话。
- 后台「生成动态视频」：从卡通（或照片）生成一段几秒的说话状态循环视频，只做一次。
- 访客提问时：`/api/chat` **流式**返回文字，服务器每凑齐一句就调一次 A2E 合成语音并推给前端，第一句合成好就开始播，后面的句子排队接上；文字比语音先上屏。A2E 不可用时自动降级为浏览器语音朗读，流程不会卡住。
- 后台「预生成讲解」会把每个部分的讲解文字、追问建议**和语音**一起提前生成并永久保存，访客选这个部分时零等待。
- `A2E_MODE=precise`：每个回答单独做口型渲染（几十秒），需要 Vercel Pro 的函数时长。

---

## 🛡️ 安全与限流

- 后台：单一密码，登录 cookie 带签名和 12 小时有效期；未设置密码时拒绝所有登录。
- 学生提交：公开入口，提交后**必须审核**才上线；每条记录有独立的随机修改 token。
- 上传图片按文件头校验，只接受 JPG / PNG / WebP（拒绝 SVG 等可执行内容）。
- 公开的 AI / TTS / 提交接口有基于 IP 的限流（按实例计数，阈值对同一校园网出口留了余量）。

---

## ☁️ 部署到 Vercel

1. 把仓库导入 Vercel（Framework 自动识别为 Next.js）。
2. 在 Project → Settings → Environment Variables 填入上表变量（`NEXT_PUBLIC_BASE_URL` 用你的 Vercel 域名）。
3. **持久化存储（Vercel Blob）**：Vercel 函数文件系统是只读且临时的，所以线上自动改用 Vercel Blob。
   - Vercel 项目 → **Storage** → **Create Database** → **Blob** → 连接到本项目。
   - Vercel 会自动注入 `BLOB_READ_WRITE_TOKEN`；代码检测到它就自动切到 Blob，本地没有它则用 `./data` 文件存储。
   - 连接后 **Redeploy** 一次即生效。
4. 数据布局：每位同学一个 Blob（`people/<id>.json`）+ 一个 slug 索引（`slugs/<slug>.txt`），
   多人同时提交互不覆盖。旧版本的单文件 `data/people.json` 会在首次访问时自动拆分迁移。
5. 登录后打开 `/api/admin/health` 可查看线上实际生效的配置（只显示布尔值，不显示密钥）。

> 也可以部署到一台**常驻服务器**（`npm run build && npm run start`），文件系统存储即可正常工作
> （每人一个文件在 `data/people/`）。

---

## 🗂️ 项目结构

```
src/
  app/
    page.tsx                  首页
    submit/                   学生提交（/submit 与 /submit/[id]?token=…）
    admin/                    老师后台（登录 + 仪表盘）
    p/[id]/                   访客数字人页（未审核时显示“准备中”，本人可用 ?preview= 预览）
    api/
      submit/…                学生：创建 / 读取 / 修改 / 传照片 / 解析文件 / AI 分段（限流）
      admin/…                 老师：登录、CRUD、审核状态、照片、卡通、动态视频、预生成、健康检查
      p/[id]                  访客读取的公开数据
      chat                    生成回答文字（packyapi；限流；未发布需 token）
      avatar                  数字人语音 / 视频（限流）
      photo/[id]              本地照片 / 视频读取（文件系统模式）
  components/
    AdminApp                  后台列表 + 审核
    PersonEditor              同一个表单，admin / student 两种模式
    SubmitApp                 学生提交流程
    VisitorExperience         访客互动
    QrModal / LoginForm / Unpublished / Loading
  lib/
    store.ts                  数据层调度（按环境自动选 文件 / Vercel Blob）
    store-fs.ts / store-blob.ts   两种存储实现（每人一条记录 + 旧数据迁移）
    validate.ts               输入校验与长度上限
    access.ts                 谁能看未发布页面（本人 token / 老师）
    ratelimit.ts              内存限流
    image.ts                  上传图片文件头校验
    auth.ts                   后台密码鉴权与签名 cookie
    ai.ts / prompts.ts        packyapi 客户端（含演示模式）与提示词
    avatar.ts / a2e.ts / did-stream.ts   数字人提供方
    parse.ts                  txt / pdf / docx 文本提取
    editor-api.ts             前端表单用的 API 封装（admin / student）
scripts/seed.mjs              示例数据
```

---

## 🧭 后续可加

- 克隆每位同学的真实声音（需录制音样）。
- 后台数据看板：每位同学被问最多的问题等。
- 用 Redis / KV 做跨实例的精确限流。

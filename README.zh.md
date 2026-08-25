# dsh-plugin-subscriptions [![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

把你的 **ChatGPT(Codex)**、**Claude**、**Grok(X Premium)** 订阅当作 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM provider 使用 —— 不需要 API key。Codex 和 Grok 通过 dsh web 界面 OAuth 登录(设置 → 订阅);Claude 在存在 Claude Code 会话时直接导入凭据(macOS Keychain 或 `~/.claude/.credentials.json`),否则回退到同样的浏览器 OAuth 流程,因此不要求安装 Claude Code CLI。Token 保存在 `~/.dsh/plugins/subscriptions/auth.json`(权限 0600),过期自动刷新。

## 演示

设置 → **订阅**:每个 provider 的登录/退出,无需 API key。Claude 有 Claude Code 会话时导入凭据,否则和 Codex、Grok 一样走 OAuth(截图中账号已打码):

![订阅设置页](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/subscriptions.png)

已登录的 provider 会带着实时模型目录进入会话模型选择器:

![模型选择器中的订阅模型](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-picker.png)

声明了推理等级的模型会在同一菜单里多出**推理等级**选择 —— Codex 系列模型、Grok 4.6 / 4.5,以及 Copilot 的推理模型(档位和默认值来自各 provider 的实时目录,不是硬编码列表;Copilot 的 `capabilities.supports.reasoning_effort` 数组会按协议映射为 chat completions 的 `reasoning_effort` 或 Responses 的 `reasoning.effort`)。同时声明两个 Copilot 端点的模型(gpt-5.4、gpt-5-mini)默认走 chat completions,但请求同时携带函数工具和推理等级时会自动改走 `/responses` —— Copilot 在 chat 线路上拒绝这种组合:

![推理等级选择器](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/model-effort.png)

目录声明了 fast tier(即 codex CLI 的 fast 模式)的 Codex 模型,会在输入框工具行(模型选择器旁)多出一个**速度**开关 —— 标准 / 快速(`service_tier: priority`),按会话生效。`/fast` 斜杠命令提供同样的弹窗选择;当前模型不支持快速档时会提示原因。

![速度开关及其标准/快速菜单](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/speed-toggle.png)

`image_generate` 工具生成的图片直接内联显示在对话里:

![image_generate 内联显示生成的图片](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-inline.png)

`provider` 参数可选择生图后端——同一条提示词分别走 GPT(`gpt-image-2`,上)和 Grok(`grok-imagine-image-2.0`,下):

![image_generate 的 provider 参数对比 gpt 与 grok](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/image-generate-providers.png)

`video_generate` 工具生成的视频直接内联播放:

![video_generate 内联播放生成的视频](https://raw.githubusercontent.com/V1ki/dsh-plugin-subscriptions/main/docs/images/video-generate-inline.png)

## Provider 一览

| 路由     | 订阅             | 模型 |
|----------|------------------|------|
| `codex`  | ChatGPT Plus/Pro | 从 `chatgpt.com/backend-api/codex/models` 实时获取 |
| `claude` | Claude Pro/Max   | 订阅内所有可用模型(Opus、Sonnet、Haiku、Fable —— 静态目录,随插件更新) |
| `grok`   | X Premium (xAI)  | 从 `api.x.ai/v1/models` 实时获取(仅对话模型);推理等级来自 Grok CLI 目录(`cli-chat-proxy.grok.com/v1/models`) |
| `copilot` | GitHub Copilot  | 从 `api.githubcopilot.com/models` 实时获取(两种 wire 的对话模型,含按模型的视觉标记与推理等级);登录使用 OAuth 设备码流程(在 `github.com/login/device` 输入页面显示的验证码) |

只有已登录的 provider 才会出现在会话模型选择器里;登录/退出后列表自动刷新。支持视觉的模型会声明 `['text', 'image']` 输入模态,图片内容会被翻译成各 provider 的 wire 格式。

已登录的卡片还会显示**订阅用量**——按限额窗口(5 小时会话窗、每周窗,以及计划包含的按模型每周窗)展示已用百分比、进度条和重置时间,并带刷新按钮。Codex 用量来自 `chatgpt.com/backend-api/wham/usage`(同时报告计划类型),Claude 用量来自 `api.anthropic.com/api/oauth/usage`,Grok 用量来自 Grok Build CLI 代理的 `cli-chat-proxy.grok.com/v1/billing`(即 CLI `/usage` 面板的数据源,报告共享每周额度和订阅档位)。Copilot 没有用量接口,其卡片不显示用量区块。

随 provider 启用自动注册的工具:

- **`x_search`**(Grok)—— xAI 托管的 X 搜索,返回 `{ answer, citations }`。
- **`image_generate`**(ChatGPT 或 Grok)—— 经 Codex 后端调用 `gpt-image-2`,或经 `api.x.ai/v1/images/generations` 调用 `grok-imagine-image-2.0`。`provider` 参数指定首选提供方(`gpt` 为默认值,可选 `grok`);首选方未登录时自动回退到另一方。图片保存到 `~/.dsh/plugins/subscriptions/images/` 并返回路径。Grok 路径上 `size`/`quality` 参数会映射为 Grok 的 `aspect_ratio`/`quality`。
- **`video_generate`**(Grok)—— 经 `api.x.ai/v1/videos` 调用 `grok-imagine-video-1.5`(异步提交 + 轮询);MP4 保存到 `~/.dsh/plugins/subscriptions/videos/` 并返回路径,视频直接在对话里内联播放。支持时长(1–15 秒)、宽高比、分辨率,以及通过 `image_url` 做图生视频。

## 安装

本机已有 `dsh` CLI 时,从 npm 安装(预构建产物,无需构建授权):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
```

也可以从 GitHub 安装源码:

```sh
dsh plugin --profile web add github:V1ki/dsh-plugin-subscriptions
```

首次安装 pnpm 会要求允许该包的构建脚本(git 安装拉取的是源码而非构建产物);把打印出的包名加进 profile 的 `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-plugin-subscriptions: true
```

然后重新执行 `add`。该授权会在安装时执行包的代码,只授给你信任的来源。

本地检出安装:

```sh
git clone https://github.com/V1ki/dsh-plugin-subscriptions.git
cd dsh-plugin-subscriptions && pnpm install && pnpm build
dsh plugin --profile web add ./dsh-plugin-subscriptions
```

不装进 profile 的 headless 用法(先在 web 界面登录过 —— token 文件是共享的):

```sh
cp overlay.example.yml overlay.yml   # 然后把 name: 改成本检出的 lib/index.js 绝对路径
dsh --profile headless --patch <检出目录>/overlay.yml "你的任务"
```

## 更新

npm 安装的:

```sh
dsh plugin --profile web update --latest dsh-plugin-subscriptions
```

GitHub 安装的:重新执行一遍 `add github:V1ki/dsh-plugin-subscriptions` —— 会重新拉取源码并构建。link 的本地检出只需在检出目录里 `git pull && pnpm build`。

无论哪种方式,更新后都要重启 `dsh web` 才会加载新版本。

## 使用

1. `dsh web`,打开打印的 URL。
2. **设置 → 订阅**:点对应 provider 的「连接」。若先运行过 `claude` 并登录,Claude 会即时导入凭据;没有凭据时,Claude 也和其他 provider 一样在浏览器里授权。Codex 和 Grok 在打开的标签页里授权;无浏览器环境下可展开手动兜底,粘贴回调 URL 或授权码。
3. 在任意会话里打开模型选择器(`/model`),选择 **ChatGPT (Codex)** / **Claude (Subscription)** / **Grok (Subscription)** 下的模型。

未登录时:该 provider 不出现在选择器里;直接请求会报 `MISSING_CREDENTIAL` 并提示去设置页登录,不影响其他功能。

## 配置

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    providers: [codex, claude]        # 子集;默认三个全启用
    streamIdleTimeoutMs: 300000
    models:                            # 覆盖实时发现/内置目录
      codex:
        - { id: gpt-5.6-sol, name: GPT-5.6 Sol, contextWindow: 272000, inputModalities: [text, image] }
      copilot:                         # 手工条目会关闭 Copilot 目录发现
        - { id: gpt-5.6-sol, wire: responses }   # 仅 copilot:强制指定上游协议
```

`wire`（仅 copilot 条目）把模型固定到 `chat-completions` 或 `responses`。不加该字段手工条目照常
工作——它存在的原因是:实时目录不认识的手工模型否则会默认走 `/chat/completions`，而
responses-only 系列（gpt-5.5/5.6 等）会拒绝该端点。固定为 `chat-completions` 也会退出上文所述
tools+effort 的自动改道。

## 模型池

启用至少两个 provider 后,插件还会注册一个虚拟的 **Subscription Pool** 路由,把各订阅聚合成逻辑模型:

- **家族池(自动聚合)**：同一模型家族经多个订阅可达时——例如 `claude-sonnet-4.5` 可走 Claude 直连或 Copilot 代理,`gpt-5.4` 可走 Codex 或 Copilot——自动合并为一个池模型,成员间 failover 底层模型不变。只有 ≥2 条路由的家族才成池;未登录的 provider 自然不入池。注意自动家族的 id 是动态的:某次登出让家族掉到两条路由以下时,该池模型会从目录中消失直到重新登录——需要跨登出稳定的 id 时,请在 `families` 里显式钉住成员。
- **档位池(手动配置)**：异构成员池,failover 会有意切换模型(例如 `smart` 档从 Claude 退到 GPT 再退到 Grok)。

成员选择按会话粘性(prompt 缓存不失效),两种策略:`priority`(按顺序取第一个健康成员)和 `quota_aware`(默认——按"必需消耗速率 = 剩余配额 / 距重置时间"给成员打分,快重置且剩余多的窗口优先被用掉而不是浪费;粘性成员除非被挑战者以 `switchMargin` 倍分差击败否则不换)。任一用量窗口超过 95% 的成员会被硬门槛挡下;首个流式 chunk 之前的失败会记冷却并切换下一家(provider 给了 `retry-after` 就用它)——配额与认证类失败按整个 provider 冷却(配额是账号级的;Claude 的分模型窗口则只冷却出错成员),瞬时服务端失败只冷却出错成员。Copilot 没有用量接口,恒为 0 分,自然充当最后的保底。

```yaml
- id: llm-subscriptions
  name: dsh-plugin-subscriptions
  config:
    pool:
      enabled: true                   # 默认开;需 ≥2 个 provider
      strategy: quota_aware           # 或 priority
      switchMargin: 2                 # quota_aware 的滞后切换倍率
      autoFamilies: true              # 自动聚合同家族模型
      families:                       # 显式家族池;同 id 覆盖自动聚合结果
        claude-sonnet-4.5:
          - { provider: claude, model: claude-sonnet-4-5-20250929 }
          - { provider: copilot, model: claude-sonnet-4.5 }
      tiers:                          # 异构档位池
        smart:
          - { provider: claude, model: claude-sonnet-5 }
          - { provider: codex, model: gpt-5.6-sol }
          - { provider: grok, model: grok-4.6 }
```

## 代理

所有订阅相关请求 —— token 交换、模型 API 流式调用、用量查询、模型目录发现,以及 `x_search` / `image_generate` / `video_generate` 工具 —— 都可以通过 HTTP(S) 代理发出。在 **设置 → 订阅 → 代理 → 配置…** 中设置:勾选启用,填写代理地址(`http://127.0.0.1:7890`)、可选用户名/密码,以及可选的逗号分隔绕过列表(保持直连的主机名,如 `127.0.0.1`、`localhost`、`*.example.com`)。密码保存在 `~/.dsh/plugins/subscriptions/proxy.json`(权限 0600),不会回传给浏览器;「测试」按钮会用当前配置探测一次端点,显示 HTTP 状态码与耗时。

保存后立即对后续请求生效,无需重启。OAuth 授权页在浏览器中打开,走浏览器/系统自身的代理设置,不受此配置影响;不支持 socks 代理。

## 开发

```sh
pnpm install   # devDependencies 用 link: 指向本地 deepseek-harness 检出 —— 先改成你的路径
pnpm build     # tsc(lib/)+ tsdown(lib/client.js 浏览器 bundle)
pnpm test      # 编译后跑 node --test 单测
```

`prepare`(git 安装时触发)执行 `tsdown.prepare.config.ts`:自包含打包两个面,所有 `@deepseek-ai/*` 依赖外部化 —— 运行时从 dsh 安装解析,保证不会引入第二份 cordis。

改了代码后 `pnpm build` 并重启 `dsh web` 生效。

## 目录结构

- `src/index.ts` —— 插件入口:配置 schema、adapter 注册、登录态变更通告、RPC 接线
- `src/auth/` —— PKCE/JWT 工具、token 存储、OAuth 流程引擎(临时本地回调服务)、Claude Code 凭据读取器(Keychain/文件)、`/subscriptions-auth` RPC 通道
- `src/providers/` —— 各 provider 的 OAuth 常量/换发/刷新 + `LlmAdapter` 实现,以及模型池(`pool.ts` + `pool-health.ts` / `pool-usage.ts` / `pool-family.ts`)
- `src/translate/` —— dsh `Message[]` 与 OpenAI Responses / Anthropic Messages 格式互转,SSE → `StreamChunk`
- `src/tools/` —— `x_search`、`image_generate` 与 `video_generate`
- `src/client/` —— 设置 → 订阅页面(浏览器面,中英文,跟随明暗主题)

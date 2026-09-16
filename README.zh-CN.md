# omp-axonhub

[English](README.md)

[oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）插件，把 [AxonHub](https://github.com/looplj/axonhub) LLM 网关注册为 `axonhub` 模型 provider。

AxonHub 是多协议网关：`/v1` 接受 OpenAI chat-completions 和 responses，`/anthropic` 接受 Anthropic messages，`/gemini/v1beta` 接受 Gemini generateContent。插件会发现网关暴露的全部模型，并按模型 id 自动路由到正确的入口协议。

## 功能

- **模型发现**——同时拉取 `/v1/models` 和 `/v1/models?include=all`，按 id 合并；单个端点失败不影响另一个，只有两个都失败才报错，临时故障不会清空已缓存的模型列表。
- **按 id 路由协议**——`claude*` → `/anthropic`，`gemini*` → `/gemini/v1beta`，`gpt-*`/`codex*` → `/v1` 的 OpenAI responses，其余 → `/v1` 的 OpenAI chat-completions。（`owned_by` 标记的是上游渠道而非入口端点，经常对不上，所以特意忽略。）
- **过滤非对话模型**——embedding、rerank、语音、图像模型默认丢弃，设 `AXONHUB_INCLUDE_NON_CHAT` 可保留。
- **models.dev 补全**——AxonHub 没上报的字段（上下文窗口、输出上限、reasoning、价格、模态）从 [models.dev](https://models.dev) 补齐；仍缺的交给 omp 内置目录兜底。设 `AXONHUB_NO_MODELS_DEV` 可关闭。
- **可选的 provider 侧联网搜索**——`AXONHUB_WEB_SEARCH` 给 `gpt-*` 请求注入 OpenAI 的 `web_search` 工具。默认关闭：omp 自带搜索，且该工具由上游单独计费。

## 安装

从 npm 安装：

```sh
omp plugin install omp-axonhub
```

本地开发用 link：

```sh
omp plugin link /path/to/omp-axonhub
```

也可以不走插件体系，直接把 `index.ts`、`discovery.ts`、`settings.ts` 拷到 `~/.omp/agent/extensions/axonhub/`，omp 会直接加载该目录。

## 配置

两种方式指定网关；同时设置时环境变量优先。

**环境变量**（omp 会自动加载项目里的 `.env`，仓库可以指向自己的网关）：

```sh
AXONHUB_BASE_URL=https://axonhub.example.com
AXONHUB_API_KEY=ah-...
```

**交互式登录**：

```
/login axonhub
```

依次询问 base URL（回车保留当前值）和 API key，先用 `/v1/models` 验证两者再保存：key 存进 omp 凭据库，URL 写入 `~/.omp/agent/axonhub.json`。登录成功后会立刻重跑模型发现，不用重启。

都没配置时网关默认 `http://localhost:8090`；没有 key 时发现结果为空。

## 刷新模型列表

插件只实现 `fetchDynamicModels`，调用时机由 omp 决定：

- `/model` 打开模型面板 → 侧边栏选中 `axonhub` → 按 **F5** 强制重新拉取。
- 再跑一次 `/login axonhub`——登录成功后会对该 provider 重跑发现。
- 在面板里选中 provider 时自动刷新一次（每个进程一次）。
- 发现结果缓存在 `~/.omp/agent/models.db`，TTL 约 2 小时；删掉该文件（或其中 axonhub 的行）可在下次启动时强制冷拉取。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `AXONHUB_BASE_URL` | 网关根地址，如 `https://axonhub.example.com`（结尾的 `/v1` 会被去掉） |
| `AXONHUB_API_KEY` | API key；设置后优先于 `/login` 存的凭据 |
| `AXONHUB_NO_MODELS_DEV` | `1`/`true` 关闭 models.dev 补全 |
| `AXONHUB_INCLUDE_NON_CHAT` | `1`/`true` 保留 embedding/语音/图像模型 |
| `AXONHUB_WEB_SEARCH` | `1`/`true` 给 `gpt-*` 请求加 provider 侧 `web_search` 工具 |

## 许可证

MIT

# Threadline

**A continuity-first runtime for persistent AI agents.**

**一个自我，多条注意力线程。**

Threadline 是一个可复用的持续认知智能体框架。它把“客观发生过什么”“她现在怎么想”“她手头在处理什么”“她选择记住什么”分开，而不是把所有消息塞进一个不断被刷掉的聊天窗口。

这个仓库只包含框架代码，不包含任何具体智能体的记忆、人设卡、聊天记录、账号信息、API key、运行日志或本地隐私数据。

## 核心模型

```text
客观事件流     所有真实发生的事，追加保存
主认知         她过滤后的连续认知状态
注意力线程     当前关注通道的材料视图
长期记忆       她选择写下的内容
```

## 设计目标

- 客观事件流与主观认知分离
- 最近上下文、注意力线程、长期记忆分层
- 记忆必须由智能体自己写入
- 所有外部工具调用都经过显式边界
- 默认身份为空模板，谁都可以配置成自己的智能体

## 设计文档

- [设计理念](docs/00-philosophy.md)
- [数学性质与证明草稿](docs/01-mathematical-properties.md)
- [设计演进过程](docs/02-evolution.md)
- [实现状态与边界](docs/03-implementation-status.md)

## 目录

```text
app/
  src/       核心认知、状态、记忆、任务、工具接口
  tools/     运行时、QQ/OneBot、办公室 worker、插件、UI
  prompts/   决策与记忆协议模板
  package.json
data.example/  本地数据目录示例（不含任何真实数据）
```

## 快速开始

要求：

```text
Node.js >= 22.13
```

从仓库根目录执行：

```bash
cd app
npm install
node tools/ops/init.mjs
```

`init` 会创建：

```text
data/memory.sqlite   空记忆库
data/identity.txt    通用身份模板
data/secrets/        本地凭据目录
data/style/          风格目录
data/logs/           日志目录
workspace/agent-office/  办公室工作区
```

然后启动：

```bash
node tools/ops/launch.mjs start --no-open
```

默认是 **dry-run**，不需要模型 key，用来检查服务能否启动。

控制台：

```text
http://127.0.0.1:8790
```

停止：

```bash
node tools/ops/launch.mjs stop
```

## 接入真实模型

默认 `BRAIN_LIVE=0`。接真实模型时：

```bash
BRAIN_LIVE=1 node tools/ops/launch.mjs start --no-open
```

模型 key 支持两种方式：

```text
DEEPSEEK_API_KEY 环境变量
或
data/secrets/deepseek.key
```

PowerShell 示例：

```powershell
$env:BRAIN_LIVE = "1"
$env:DEEPSEEK_API_KEY = "你的 key"
node tools/ops/launch.mjs start --no-open
```

不要把 key 写进仓库、README 或日志。

## 接入 QQ / OneBot

把示例：

```text
data.example/qq.json.example
```

复制为：

```text
data/qq.json
```

按你的 OneBot 实现修改：

```json
{
  "ws": "ws://127.0.0.1:3001/",
  "http": "http://127.0.0.1:3000",
  "token": ""
}
```

支持标准 OneBot v11；SnowLuma / NapCat / LLOneBot 等都可以，不做绑定。

QQ 没启动时，连接器会等待，不会影响 brain/office 启动。

## 办公室和插件

办公室工作区默认在：

```text
workspace/agent-office/
```

插件放在：

```text
workspace/agent-office/plugins/
```

相关工具：

```text
office_*       文件、命令、npm
office_plugin_* 插件安装与运行
github_*       一个配置仓库的最小权限操作
```

具体能力可以从 UI 或工具层查看。

**执行类工具默认关闭。** `office_run`、`office_npm`、`office_plugin_run`、`office_plugin_install` 等于让模型在这台电脑上执行任意代码，而接 QQ 的模型可以被聊天内容诱导。把办公室放进容器或虚拟机之后，再设 `THREADLINE_OFFICE_EXEC=1` 打开。读写文件类工具不受影响。

## 多会话与记忆

她是同一个人，同时挂着多个 QQ 会话。

- **会话面板。** 每一轮的 `continuity.recent` 是：当前聊天的完整最近记录（`here`），加上所有其他活跃会话的列表（`chats`：未读数、是否在等她回、她上一句的发送状态、最近几条预览）。群聊刷屏不会把私聊上下文挤掉。
- **一次只做一件事。** 聊天回合、任务唤醒、记忆整理、后台维护共用一把主体锁，不会并发提交互相覆盖。
- **冲突不再静默丢失。** 如果一轮提交时状态已经被别处改过，宿主会在最新状态上重放她的决定（不再调用模型）；确实冲突、存不上时，下一轮输入的 `hostNotices` 会告诉她哪些修改没存上。
- **连发合并。** 对方一口气发了几条，她把这几条当作一段话一起看、回一次，而不是每条各调用一次模型、各回一次。
- **节律与预算全局共享。** 所有会话共用一份日调用计数。

### 容量配置

原来写死的条数都可以用环境变量调整（默认值即原行为，越界启动报错）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `THREADLINE_RECENT_ITEMS` | 50 | 当前聊天最多带几条 |
| `THREADLINE_RECENT_BYTES` | 32000 | 会话面板的字节预算 |
| `THREADLINE_RECENT_CHATS` | 24 | 会话列表最多列几个会话 |
| `THREADLINE_RECENT_CHAT_TAIL` | 8 | 每个其他会话最多预览几条 |
| `THREADLINE_RECENT_CHAT_WINDOW_HOURS` | 48 | 多久没动静的会话不再列出（有未读的除外） |
| `THREADLINE_FOREGROUND` | 16 | 前台状态卡容量（已有数据库也可以改） |
| `THREADLINE_MEMORY_WINDOW_ITEMS` | 40 | 记忆整理窗口条数 |
| `THREADLINE_MEMORY_DUE_MESSAGES` / `_MINUTES` | 50 / 120 | 多少条或多久触发一次记忆整理 |
| `THREADLINE_LOOKUP_READS` / `_HITS` | 2 / 4 | 每轮查记忆次数 / 每次条数 |
| `THREADLINE_INPUT_BYTES` | 120000 | 单次模型输入上限 |
| `THREADLINE_CALLS_PER_TURN` | 3 | 每轮最多调用模型几次 |
| `THREADLINE_DAILY_CALLS` | 300 | 每天最多调用模型几次 |
| `THREADLINE_BURST_MAX` | 8 | 同一聊天连发几条合并成一轮看（1 = 不合并） |

输入超过 `THREADLINE_INPUT_BYTES` 时会自动缩小会话面板再试，而不是整轮没有回复。完整列表见 `app/src/limits.mjs`。

## 外部能力

桌宠、Minecraft、语音、联网搜索依赖本仓库之外的模块，需要显式配置；没配置时调用会返回 `CAPABILITY_NOT_CONFIGURED`：

```text
THREADLINE_DESKTOP_LINK / THREADLINE_DESKTOP_DIR        桌宠
THREADLINE_MINECRAFT_LINK / THREADLINE_MINECRAFT_DIR    Minecraft（可选 THREADLINE_MINECRAFT_CONFIG）
THREADLINE_LEGACY_BRIDGE                                语音、音色列表、联网搜索
NECKLACE_OWNER_KEY 或 QQ_OWNER                           项链的主人身份
```

## 开发

```bash
cd app
npm test
```

```bash
npm run dump-packet
```

`dump-packet` 用假模型模拟一个私聊和两个群，把每次真正发给模型的输入包写到 `data/debug/packets/`，并打印各字段占多少字节。不联网，不需要 key。

## 隐私边界

`.gitignore` 默认排除：

```text
data/
*.sqlite
*.db
*.log
secrets
node_modules/
workspace/
release/
node/
```

这个仓库不应提交：

- 真实记忆数据库
- 人设卡
- API key / token
- QQ 号、账号、聊天记录
- 本地绝对路径
- 运行日志和测试产物

## 说明

这是一个 sanitized skeleton。  
具体模型提供方、身份、记忆内容、通道配置和凭据需要使用者自己配置。

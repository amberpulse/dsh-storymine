# dsh-storymine

把 [storymine](https://github.com/amberpulse/storymine) 那个叙事手法库接进 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)。

写东西卡住了就问一句"别人怎么写这一段"，条目推到右侧面板，正文里不刷屏。

> 这是 DSH 插件（host + client 两半），不是 storymine 内核本身。
> 内核（`storymine.py`）负责把书切章、提取、入库；本插件负责在 DSH 里用起来。

## 快速开始（三步）

**1. 装进你的 profile**（桌面版也可以走侧栏「插件 → 添加插件 → 本地路径」）

```bash
dsh plugin --profile <你的profile> add /path/to/dsh-storymine
```

**2. 在 profile 的 `cordis.patch.yml` 里指一下库在哪**（不配会明确报错，不会静默失败）

```yaml
- id: storymine
  name: 'dsh-storymine'
  config:
    dbPath: '/abs/path/to/storymine.db'
    kernelPath: '/abs/path/to/storymine.py'   # 只跑 query 的话可以不填
```

**3. 重启 DSH**

然后随便问一句「用 storymine_query 找几条：角色刚摊牌，下一拍该收还是该抬」，
条目会出现在右侧「手法库」面板里，正文只留一行播报。

### 怎么确认装好了

- 右侧栏的「开始」引导页里多了一格 **storymine 手法库**（点开就是面板）
- 面板底部有输入框，直接在里面问一句，条目当场出来（这条路径不经过主对话）
- 主对话里问同样的问题，正文只有播报 + 一句提议，条目在面板

---

## 能干什么

六个工具：

| 工具 | 作用 |
|---|---|
| `storymine_query` | 给一句处境描述，从库里找可复用的叙事手法 |
| `storymine_stats` | 家底：几本书、几条动作、动作分布、各书进度 |
| `storymine_list` | 按动作分组浏览整张手法表 |
| `storymine_failures` | 列出提取失败 / 切分可疑的章 |
| `storymine_extract` | 把 txt 逐章提取入库（慢，需分批） |
| `storymine_delete` | 删条目（默认只预览，`confirm` 才动手） |

加上一个右侧面板（`手法库`）：

- 历次查询的条目卡片，按**动作**分组，带出处
- 面板底部自带输入框——**在面板里问，结果只进面板，主对话一个字都不占**
- 按会话分区，可清空
- 底色跟 DSH 主题走（`--dsw-*` token）

## 前置

- **DSH ≥ 0.2.0**（web profile 或桌面版都行）
- **一个 `storymine.db`** —— SQLite，storymine 内核提取出来的库。没有库就没东西可查
- **Python 3.10+ 和 `storymine.py`** —— 只有 `stats / list / failures / extract / delete` 用得到；
  `query` 不需要内核（它直接在 Node 里读 SQLite、用 DSH 的模型）

## 装

```bash
# CLI
dsh plugin --profile <你的profile> add /path/to/dsh-storymine

# 或者桌面版：侧栏「插件」→ 添加插件 → 安装第三方插件 → 填本地绝对路径
```

装完重启 DSH（Host 代码在宿主进程里跑，热替换不生效）。

## 配

插件不猜任何人的机器，**库路径必须显式给**（不配会明确报错，不会静默失败）。

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: storymine
  name: 'dsh-storymine'
  config:
    dbPath: '/abs/path/to/storymine.db'        # 必填
    kernelPath: '/abs/path/to/storymine.py'    # 用 extract/stats 等时才需要
```

也可以用环境变量（`config` 优先）：

| 环境变量 | 对应配置 | 说明 |
|---|---|---|
| `STORYMINE_DB` | `dbPath` | 手法库路径 |
| `STORYMINE_KERNEL` | `kernelPath` | 内核脚本路径 |
| `STORYMINE_PYTHON` | `pythonPath` | 解释器，默认 `python` |
| `STORYMINE_BASE_URL` / `STORYMINE_MODEL` | `baseUrl` / `model` | 内核通道的端点与模型覆盖 |

其余可调项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `queryMode` | `two-stage` | `two-stage` 两轮精选（省 token）/ `single` 老做法（全库一次塞） |
| `shortlistSize` | `20` | 两轮模式第一轮挑多少候选 |
| `queryMaxEntries` | `1200` | 一次塞进模型的条目上限 |
| `modelSource` | `auto` | `auto` 宿主优先失败回退内核 / `host` 只用宿主 / `kernel` 只用内核 |
| `provider` / `modelId` | 空 | 留空则跟随 DSH 里选的默认模型 |
| `stateFile` | 系统临时目录下 `dsh-storymine/history.json` | 面板读的查询存档 |

## 两轮精选是怎么回事

全库 873 条时，把每条的完整做法一次塞给模型约 7 万 token，注意力被稀释，库越大越慢。

所以默认走两轮：

```
第一轮：全库每条只给「[id] 手法:… | 局面:…」（约 25 token/条）
        → 按「局面是不是同一类问题」挑 20 个候选
第二轮：只把这 20 条的完整做法给它
        → 精选 n 条 + 写「为什么能用在你这里」
```

实测（同一句处境，`deepseek-v4.1-flash`）：单轮 63.2s / 两轮 64.0s，**耗时几乎一样，token 省约 65%**。
候选数由 `shortlistSize` 控制。

## 正文为什么不刷屏

条目**不进对话**：工具的返回值只有「推了多少条 + 动作分布」，条目正文直接进面板和 store。
想细看就翻右侧面板。

（副作用：模型看不到条目内容，所以不会再在正文里替你品评"这条适配度有问题"——那个判断交回给你。）

## 架构

```
host 半（index.js）
  ├─ 六个工具
  ├─ store.js        最近 30 次查询（内存 + JSON 文件，按会话分区）
  └─ GET  /storymine/api/history | latest | ping
     POST /storymine/api/ask      ← 面板输入框直接查询，不经过主对话
     POST /storymine/api/clear

client 半（client/client.js）
  └─ 右侧栏 tab「手法库」：按动作分组渲染、会话过滤、清空、底部输入框
```

client 半边是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle，**没有构建步骤**——
改完直接重启 DSH 就生效。

## 常见问题

| 现象 | 原因 / 怎么办 |
|---|---|
| `没配置手法库路径` | `dbPath` 没给。见上面「配」一节 |
| `没配置 storymine 内核路径` | 只有 `stats/list/failures/extract/delete` 需要它；`query` 不需要 |
| 右侧面板里没有「storymine 手法库」 | 先确认重启过 DSH（Host 代码在宿主进程里跑）；再看启动日志里有没有 `[storymine]` 开头的行 |
| `Invalid schema for function ... type: null` | 插件版本和 DSH 版本不匹配——本插件要求 `engines.dsh: >=0.2.0 <0.3.0` |
| `no session surface is mounted` | 面板要在已打开的会话里用；没有任何会话时 `openTab` 会拒绝（DSH 的设计） |
| `RATE_LIMIT` / 429 | 上游渠道限流，不是插件问题；换个模型或等一会儿 |
| 查询要等几十秒 | 两轮模式各一次模型往返。可以先调小 `shortlistSize`，或者把 `queryMode` 设成 `single` 对比 |

## 已知限制

- **`query` 会花几十秒**（两轮各一次模型往返）。早期在别的模型上测到过 6.5 秒，慢的原因还在查，
  怀疑是 `reasoningEffort` 设得高。
- **面板需要已打开的会话面**：`openTab` 在没开会话时会抛 `no session surface is mounted`（DSH 的设计）。
- **正文长度只做了一半**：工具不再交条目，但模型仍可能自己展开方案/大纲。再往下压就得在渲染层折叠，
  那不该由工具插件干。
- `extract` 的模型调用走内核自己的渠道（`storymine/config.json`），不吃 DSH 的 provider——
  要让它也跟 DSH 走，等于把提取循环搬到插件里重写一遍。

## 开发

```bash
# 沙坑里跑（不碰你的 ~/.dsh）
DSH_HOME=/tmp/dsh-sandbox \
ELECTRON_RUN_AS_NODE=1 "/path/to/DeepSeek Harness" \
  "<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile scratch --from-default-profile web --patch ./dev.patch.yml --no-open --port 3099
```

几个踩过的坑（改代码时容易再踩）：

1. **`inject` 要写全**：用 `ctx.tools` 就 `inject: ['tools']`，用 `ctx.llm` 再加 `'llm'`。
   漏了会报 `cannot get property "X" without inject`。
2. **客户端侧栏服务不要 inject**：`slots` / `sidebarRightTabs` / `sidebarRight` 一律 `ctx.get()` 探测。
   Cordis 没有可选依赖，inject 一个组合里没有的服务会让 fiber 停住，进而**整个 web boot 失败（白屏）**。
3. **探测要重试**：服务可能比插件晚就绪（实测差几百毫秒），探一次就放弃 = 面板不出现。
4. **`parameters` 必须是原始 JSON Schema**：`{ type:'object', properties, required, additionalProperties:false }`。
   无参数工具也要写完整节点，给 `{}` 会被 provider 判成 `type: null` 直接拒。
5. **别 import `@deepseek-ai/*`**：安装版没有祖先 `node_modules`，会 `ERR_MODULE_NOT_FOUND`。
6. **`guide` 是数组**：`guide: [{ id, order, title, description }]`，写成对象会让 entry 激活失败。

## License

MIT

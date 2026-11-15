# self-learn · Claude Code 的自学习自进化消费端

一个 **Claude Code 插件**（函数 hook / mod 形态）：把「公共经验库」接成自动的读写回路——动手前按任务注入相关经验，踩坑时提醒反思并附上库里可能相关的条目，收口后由模型用工具把新经验写回去。**不复制库**：读写都直达库的唯一 CLI 实现（`tools/learn.py`）。

## 它做什么

| 时机 | 行为 |
|---|---|
| 每轮提示词 | 按任务描述跑严档检索（`rank`），命中经 `prompt.submit` 的 `e.context` 注入：**模型可见、用户不可见**；同标题只在会话内注入一次，每次 ≤4 条、会话上限 30 条。对话性短句（去标点后 <12 个内容字）不触发；连续 3 条无命中后降频抽样（每 3 条查一次，命中即恢复）。 |
| 同一错误第二次出现 | 在工具结果的 `context` 里附一条反思提醒（全会话一次），**并先替模型查库**，把命中的 top2 标题直接附上。 |
| 系统提示词 | 追加「自学习协议」段（session 段）；若被上游插件整段跳过（实测 `cc-plugin-sec-default`），改由会话首条提示词的 `context` 一次性补投。 |
| 模型工具 | `learn_search`（严档→宽档自动降档）、`learn_add`（固定署名 `claude-code`）、`learn_supersede`（先写新条目，再标记旧条目被取代）。 |
| 人工命令 | `/learn [query\|rank\|review\|status\|stats]` —— 只读。 |

跨会话计数存在 `$.store`（key `self-learn:stats`），`/learn stats` 可看注入 / 检索 / 写入 / 提醒的读数。

## 依赖

- Claude Code **2.1.x+**（函数 hook / mod API）。
- **Python 3**：`python` 在 PATH，或 Windows 的 `py -3`。
- 一个兼容的经验库：目录里有 `tools/learn.py`，支持 `add / query / rank / supersede / review / status`（append-only 的 markdown 经验库）。
  **库目录由环境变量 `SELF_LEARN_LIB` 指定**（仓库不内置本机路径）。

## 安装

**方式 A（推荐，改文件即热重载）**：把 `self-learn/` 放到任意位置，在 `~/.claude/settings.json` 里：

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "<self-learn 目录的绝对路径>" } }
```

新会话自动加载；编辑 `hooks/register.ts` 保存后，当前会话在下一轮自动重载。

**方式 B（单会话试用）**：`claude --plugin-dir <self-learn 目录>`。

## 判据

```bash
claude plugin validate .   # 0 警告
claude plugin test .       # 10 用例：协议补投 / compose 段 / 注入去重 / 短对话不触发 / 抽样降频 / 同签名错误提醒带库命中 / 不同错误不累计 / 检索降档 / 署名参数 / supersede argv
```

## 文件

```
.claude-plugin/plugin.json   清单（name: self-learn）
hooks/hooks.json             指向唯一入口模块
hooks/register.ts            插件本体（全部行为都在这里）
hooks/self-learn.test.ts     官方 test kit 用例
```

## 已知限制

- 工具返回值必须是**字符串**：引擎契约里 `result` 只接受 string / 内容块数组 / undefined，普通对象会被真引擎拒（而 test kit 不校验）。
- `prompt.compose` 可能被上游安全插件整段跳过，协议段有一次性补投兜底。
- 检索是词法（中文 bigram），无语义；查不到 ≠ 没有，换关键说法再查。
- 命中的检索会启动一次 Python 进程（约数百毫秒），由降频机制控制频率。

研发署名：claude-code

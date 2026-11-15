# claude-code

**Claude Code 的 Agent 自有总库。** 这里按「分库」存放我（`claude-code`）的插件、工具与消费层实现；每个分库一个文件夹、自包含，可以单独取用。

## 分库

| 分库 | 内容 |
|---|---|
| [`self-learn/`](self-learn/) | **自学习自进化的消费层**：直连公共经验库（append-only 的 `learn.py` 库），按任务注入经验、失败提醒，并向模型提供 `learn_search` / `learn_add` / `learn_supersede` 工具与 `/learn` 命令。 |

## 约定

- 每个分库自包含：自己的 `README`、清单（`.claude-plugin/plugin.json`）与判据（`claude plugin validate` / `claude plugin test`），互不依赖。
- 研发署名固定 `claude-code`（与公共经验库的署名分布一致）。
- 仓库只放**实现**；经验库的**内容**不在这里（那是所有 Agent 共用的独立数据目录，不随仓库分发）。

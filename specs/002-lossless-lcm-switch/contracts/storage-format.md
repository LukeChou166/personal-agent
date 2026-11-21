# Contract: 磁盘格式（v1）

**Feature**: `002-lossless-lcm-switch` | **Version**: 1（`schemaVersion: 1`）

## 1. 目录布局

```text
<storeRoot>/                          # 默认 <claudeConfigHome>/lossless，权限 0700
└── <projectKey>/                     # 项目标识，复用现有 projects 目录命名
    └── <sessionId>/                  # 会话标识（getSessionId()）
        ├── messages.jsonl            # 追加写，一行一条 MessageRecord，权限 0600
        ├── nodes.jsonl               # 追加写，一行一条 SummaryNode，权限 0600
        └── meta.json                 # 原子替换写，权限 0600
```

`<claudeConfigHome>` 由现有配置目录解析函数提供（与 `getProjectsDir()` 同源，见 `src/utils/sessionStorage.ts:199`）。**禁止**写入仓库工作区（FR-017）。

## 2. 写入语义

| 文件 | 写方式 | 原子性 | 崩溃后果 |
|---|---|---|---|
| `messages.jsonl` | `append`，单次一行 | 追加写 | 最多丢最后一行，前序记录完好 |
| `nodes.jsonl` | `append`，单次一行 | 追加写 | 同上；节点由 `id` 去重 |
| `meta.json` | 写临时文件 + `rename` | 原子替换 | 保持上一次完整快照 |

- 每条记录写入前序列化为单行 JSON（不含换行）；`\n` 由写入端保证。
- 写入成功后更新内存计数；`meta.json` 的刷新节流（每 N 条或每 2 秒，取先到者），避免每条消息都重写元数据。
- 会话目录首次创建时写入 `{"schemaVersion":1}`，重复创建幂等。

## 3. 读取语义

- 逐行读取；`JSON.parse` 失败的行计入 `corruptLines` 并跳过，不中断读取（FR-011）。
- `schemaVersion` 高于当前支持；进入只读模式：允许检索既有数据，不再写入，`/lossless status` 明确提示升级。
- `schemaVersion` 低于当前支持：按已知旧字段尽力解析；不自动迁移（迁移不在 v1 范围）。

## 4. 记录约束

- 字段定义见 [data-model.md](../data-model.md) 的 `MessageRecord` / `SummaryNode`。
- 每条记录以 `v`（记录版本）开头，便于未来单行演进。
- 记录内不得包含绝对仓库路径以外的隐私字段；工具结果按现有 `toolResultStorage` 的引用方式保存（`sourceRef`），不重复存整块内容。

## 5. 容量与隔离

- 单会话软上限 50MB；超过时停止写入新消息并在状态中标 `capped: true`（不删除旧数据）。
- 文件权限：目录 `0700`，文件 `0600`；Windows 上依赖用户目录 ACL。
- 并发：单进程假设。写入前检查 `meta.json` 的 `lastUuid` 是否被其他进程推进；发现冲突时停止写入并提示（不保证多进程协同，见 Out of Scope）。

## 6. 版本演进规则

- 新增可选字段：不提升 `schemaVersion`。
- 重命名字段或改变语义：提升 `schemaVersion`，并在读取端保留一个版本的兼容分支。
- 删除文件或改变目录结构：必须提供只读回退路径与状态提示，不得静默丢弃数据。

# Application Command Framework

## 设计结论

引擎层使用 `ApplicationCommandRuntime` 执行应用已经认可的副作用命令，使用
`ApplicationQueryRuntime` 执行只读查询。两者共享 `ApplicationAccessScheduler`，以显式资源
读写声明处理 Query/Command 之间的冲突。应用自行注册具体 Query/Command Definition；引擎
不包含 Session、窗口、文件、MCP 或 Electron 业务类型。

`CommandProposal` 与 `CommandReceipt` 不是直接执行的必要条件。UI、快捷键、确定性规则和
应用内部代码可以构造权威 `ApplicationCommand` 并直接调用 Runtime。Agent 只能产生不可信
Proposal，由 `AgentApplicationCommandBridge` 调用应用提供的编译函数，完成目标解析、权限、
确认和 revision 校验后才能得到 Command；执行结果也必须经过应用提供的投影函数才能进入
Agent Receipt。

```text
直接应用入口
 UI / 快捷键 / 确定性规则
           -> ApplicationCommand
           -> ApplicationCommandRuntime

Agent 入口
 Router / 未来 WorkAgent
           -> CommandProposal（不可信）
           -> AgentApplicationCommandBridge
              -> 应用 compileProposal / Policy / Confirmation
              -> ApplicationCommand（权威）
              -> ApplicationCommandRuntime
              -> 应用 projectResult
           -> CommandReceipt（有界 Agent 事实）
```

当前首批实现位于 `packages/application-command-runtime`，只提供框架和测试，不注册具体桌面
操作，也不改变现有 Router、Task Manager 或 Session Monitor 协议。Session 窗口放置是后续
第一个应用 Definition；WorkAgent 继续保持待设计。

## 为什么不用 OperationCoordinator

`OperationCoordinator` 容易同时持有自然语言理解、目标解析、确认、权限、调度、执行和结果
表达，最终成为应用 God Object。`Action` 又与 Avatar/Live2D 动作目录冲突，`Tool` 会错误地
把应用领域能力绑定到 Agent 或 MCP。框架采用 Command/Query：

- Query：只读事实，不产生应用副作用；
- Command：应用认可的写意图，可能改变应用或外部系统；
- Definition：应用注册的具体能力；
- Runtime：通用校验、并发、幂等和执行生命周期；
- Bridge：Proposal/Receipt 与核心 Runtime 之间的 Agent 边界。

`ApplicationCommandRuntime` 是框架公共执行门面；内部可以使用 dispatcher/bus，但
`CommandBus` 不作为公共顶层概念，因为它不能表达读写冲突、幂等和桥接边界。

## 引擎契约

### Application Query

```ts
interface ApplicationQuery {
  schemaVersion: 'desktop-char.application-query.v1';
  type: string;
  parameters: ApplicationData;
  contextRevision: number;
  target?: {
    kind: string;
    id: string;
    expectedRevision?: string;
  };
}
```

Query 没有 `queryId` 或 Receipt。调用者直接等待返回值；如果应用需要缓存、订阅或 Agent
展示，在 Query Runtime 之外建立对应投影。Definition 必须校验并规范化 parameters，返回值
必须是 JSON-compatible `ApplicationData`。

### Application Command

```ts
interface ApplicationCommand {
  schemaVersion: 'desktop-char.application-command.v1';
  commandId: string;
  type: string;
  parameters: ApplicationData;
  contextRevision: number;
  target?: {
    kind: string;
    id: string;
    expectedRevision?: string;
  };
}
```

Command 已经是权威输入，不再包含置信度、自然语言引用或候选集合。相同 `commandId` 与相同
内容共享第一次执行 Promise；相同 ID 被用于不同内容时以 `idempotency-conflict` 拒绝。成功、
失败和取消均保留有界执行记录，避免失败命令被同一 ID 隐式重试。

### Definition Catalog

应用通过 `ApplicationQueryCatalog` 和 `ApplicationCommandCatalog` 注册 Definition：

```ts
commandCatalog.register({
  type: 'session.window.place',

  validateParameters(value) {
    return validateSessionWindowPlacement(value);
  },

  access(command) {
    return [{
      resource: `session-window:${command.target!.id}`,
      mode: 'write',
    }];
  },

  execute({ command, parameters, signal }) {
    return taskManager.placeSessionWindow(command.target!.id, parameters, signal);
  },
});
```

重复类型注册失败；注册返回 disposer，只有仍指向原 Definition 时才移除，避免迟到 disposer
删除新注册。Definition 只声明领域类型和 Handler，不保存 Router 或 Agent 状态。

## 读写冲突与并发

Query 和 Command 必须共享同一个 `ApplicationAccessScheduler` 才能形成完整读写边界。应用应优先使用组合入口，避免分别构造时意外形成两套锁域：

```ts
const applicationCommands = createApplicationCommandFramework();

applicationCommands.queryCatalog.register(queryDefinition);
applicationCommands.commandCatalog.register(commandDefinition);
```

需要测试替身或嵌入已有生命周期时，仍可显式构造 Catalog、Scheduler 和两个 Runtime；此时必须向两个 Runtime 注入同一个 Scheduler。

每次执行声明一个或多个不透明资源键：

```ts
interface ApplicationAccessClaim {
  resource: string;
  mode: 'read' | 'write';
}
```

冲突规则：

| 已运行 | 新请求 | 同资源结果 |
|---|---|---|
| read | read | 并行 |
| read | write | 等待 |
| write | read | 等待 |
| write | write | 等待 |

不同资源不冲突。一个请求声明多个资源时，只有全部资源均可获得后才整体开始，因此不会在
Handler 中持有半套锁。Scheduler 对冲突请求保持队列公平：已排队 Writer 不能被后来的同资源
Reader 越过，但无关资源仍可前进，避免全局队首阻塞。

Definition 未声明 access 时使用安全默认值：

- Query：`application/read`；
- Command：`application/write`。

因此默认 Query 可以互相并发，默认 Command 与全部默认 Query/Command 冲突。只有应用明确
证明操作边界时才缩小资源键，例如 `session-window:{sessionId}`。资源键当前按完全相等判断，
不隐含路径或层级语义；需要同时保护父级与子级时，Definition 必须同时声明两个 claim。

Scheduler 只协调进程内访问，不替代目标系统 revision 校验。Handler 执行前仍须用
`expectedRevision`、Session instance/window revision 等事实防止外部状态漂移。

## Proposal 与 Receipt 桥接

Agent Proposal 保留置信度和模糊引用：

```ts
interface ApplicationCommandProposal {
  schemaVersion: 'desktop-char.application-command-proposal.v1';
  proposalId: string;
  type: string;
  parameters: ApplicationData;
  contextRevision: number;
  confidence?: number;
  targetReference?: {
    kind: string;
    reference: string;
  };
}
```

Bridge 不自行猜测领域规则，而要求应用注入两个函数：

```ts
new AgentApplicationCommandBridge({
  runtime: commands,

  compileProposal(proposal, signal) {
    // 解析候选、检查 capability、执行确认、冻结 revision，返回权威 Command。
  },

  projectResult(command, internalResult) {
    // 删除 HWND、绝对路径、内部错误等，只返回允许交给 Agent 的事实。
  },
});
```

编译失败产生 `rejected` Receipt，执行失败产生 `failed`，AbortError 产生 `cancelled`。同一
`proposalId` 与相同内容共享第一次桥接 Promise；不同内容重用相同 ID 失败。Receipt 是 Agent
可见事实，不是 Runtime 内部审计记录，也不是自动转化为下一条 Command 的输入：

```ts
interface ApplicationCommandReceipt {
  schemaVersion: 'desktop-char.application-command-receipt.v1';
  receiptId: string;
  proposalId: string;
  type: string;
  status: 'succeeded' | 'rejected' | 'failed' | 'cancelled';
  completedAtMs: number;
  commandId?: string;
  result?: ApplicationData;
  error?: { code: string; message: string };
}
```

目标候选接近、危险操作确认和权限判断应发生在 `compileProposal` 对应的应用桥接服务中，
在生成 Command 之前完成。核心 Command Runtime 不理解 Agent confidence，也不允许 Handler
绕过确认策略自行向用户索要授权。

## 应用接入与命名

具体命令采用稳定领域名，不包含实现技术：

```text
session.window.place
session.window.focus
application.panel.open
service.task-manager.set-enabled
file.reveal
```

避免：

```text
session-monitor.move-hwnd
electron.open-panel
mcp.call-window-tool
```

应用新增能力需要：

1. 定义并验证 parameters/result；
2. 选择准确的资源 read/write claims；
3. 注册 Query 或 Command Definition；
4. 实现 Electron、TaskManager、MCP 或其他外围 Handler；
5. 若允许 Agent 使用，再增加 Proposal 编译与 Receipt 投影；
6. 若允许自然语言触发，再扩展确定性路径/Router Suggestion；
7. 增加并发、冲突、revision、失败和前台验收测试。

未经过第 5、6 步的命令仍可由 UI、快捷键和应用代码使用，确保无需 Agent 的操作是一等能力。

## 首版实现与后续顺序

当前已实现：

- `ApplicationAccessScheduler`：多资源公平读写调度；
- `createApplicationCommandFramework`：创建共享 Catalog 与 Scheduler 的应用级组合根；
- `ApplicationQueryCatalog` / `ApplicationCommandCatalog`；
- `ApplicationQueryRuntime`：默认共享读；
- `ApplicationCommandRuntime`：默认独占写、`commandId` 幂等和有界状态；
- `AgentApplicationCommandBridge`：Proposal 编译、Result 投影和 Receipt；
- 同资源并发读、读写公平、无关资源并行、默认全局冲突、幂等和桥接隔离测试。

后续按以下顺序接应用：

1. Session Monitor 声明并实现受限 `sessionWindow` capability；
2. Task Manager 增加语义化窗口 Query/Command Handler；
3. Desktop main 注册 `session.window.bounds` 与 `session.window.place` Definition；
4. 增加确定性窗口意图入口；
5. 扩展 Router Agent 为 `character/session/command/confirm/no-match` Suggestion；
6. 将 Receipt 投影给现有 Char/表情/TTS 展示链；
7. 等没有合适 Session 仍需自主 MCP/文件工作的需求稳定后，再把 WorkAgent 作为新的 Proposal
   来源，不修改 Runtime 或具体 Handler。

# DeepPilot: Sui AI Intent Trading Terminal

## Summary

把项目从 **Sui Intent Guardian** 升级成更高级、更容易讲故事的 **DeepPilot**。

定位：

> DeepPilot 是一个运行在 Web 与 Telegram Mini App 里的 Sui AI intent trading terminal。用户用自然语言表达交易目标，AI 将其编译为 DeepBook/PTB 交易计划，Guardian 在签名前检查滑点、流动性、价格过期和执行风险，最后通过钱包或 sponsored transaction 完成确认与执行，并把 intent/risk/action 记录到链上。

核心卖点：

- 用 **DeepBookV3** 做真实 Sui order book 交易，而不是泛泛 swap wrapper。
- 用 **PTB** 表达可审计、可组合的交易计划。
- 用 **AI Guardian** 做签名前风险解释和阻断。
- 用 **Sponsored Transactions / Gasless Stablecoin Transfers** 降低用户 gas 感知。
- 用 **Telegram Mini App** 做高传播、高完成率入口。
- 前端做成高端 Web3 交易终端，不做普通聊天机器人。

参考资料：

- Agentic Web 题目：https://mystenlabs.notion.site/agentic-web-problem-statement
- Sui PTB：https://docs.sui.io/develop/transactions/ptbs/prog-txn-blocks
- DeepBookV3：https://docs.sui.io/onchain-finance/deepbookv3/deepbook
- Sponsored Transactions：https://docs.sui.io/develop/transaction-payment/sponsor-txn
- Gasless Stablecoin Transfers：https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers
- Telegram Mini Apps：https://core.telegram.org/bots/webapps

## Product Direction

### 推荐名称

主推名称：**DeepPilot**

备选：

- **FlowPilot**
- **Aegis Flow**
- **SignalFlow**
- **TidePilot**
- **DeepFlow AI**

推荐用 **DeepPilot**，原因是短、好记、和 DeepBook 有关联，也比 Intent Guardian 更像一个高级 Web3 产品。

一句话：

> DeepPilot turns plain-language trading goals into guarded DeepBook transactions on Sui.

中文：

> DeepPilot 把自然语言交易目标变成经过风险守护的 Sui DeepBook 交易。

### Demo 主线

用户打开 Web App 或 Telegram Mini App，输入：

> Buy 20 USDC worth of SUI on DeepBook, but only if slippage is below 0.5%.

系统展示：

- AI 解析出的 intent
- DeepBook 订单/成交路径
- PTB commands preview
- Guardian risk score
- 预计滑点、盘口深度、quote freshness
- 是否使用 sponsored gas
- 用户确认按钮

确认后：

- 构建 PTB
- 钱包签名或 zkLogin/sponsored flow
- 执行 DeepBook 交易
- 写入链上 `IntentRecord`
- 展示 tx digest 和 explorer link

## Key Implementation Changes

### 1. 前端体验升级

技术栈：

- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- Framer Motion
- `@mysten/sui`
- `@mysten/dapp-kit-react`
- shadcn/ui 或自定义高端组件
- Vercel 部署

视觉方向：

- 黑色/深灰底，不做俗套紫蓝渐变。
- 使用玻璃质感、细线边框、柔和发光、动态 depth map。
- 主界面像高级交易终端，而不是聊天页。
- 关键状态用流畅动画：intent parsing、quote fetching、risk scanning、PTB compiling、signing、executing。
- 所有交互 60fps，移动端优先，按钮和面板尺寸稳定。

核心页面布局：

- 左侧/顶部：自然语言 intent 输入区。
- 中间：AI 编译流程 timeline。
- 右侧/下方：PTB preview、DeepBook quote、Guardian risk panel。
- 底部：确认执行栏，显示 wallet、gas mode、risk state。

关键动效：

- 输入后 intent 被分解成 token chips。
- PTB commands 逐条生成。
- Guardian 扫描时显示风险雷达或 risk pulse。
- 风险项用 expandable cards 展示原因。
- 交易执行后 tx digest 以 success receipt 动画出现。
- Telegram 中使用 haptic feedback、fullscreen mode、safe area 适配。

### 2. 前端提示词与文案风格

把原来的“普通工具说明”改成高端 Web3 金融终端语气。

产品文案原则：

- 短句。
- 专业。
- 不解释废话。
- 像交易系统，不像教程。
- 每个状态都有清楚反馈。

Hero 文案：

```text
Trade by intent. Execute with proof.
```

副标题：

```text
DeepPilot compiles plain-language goals into guarded DeepBook transactions on Sui.
```

输入框 placeholder：

```text
Buy 20 USDC of SUI on DeepBook if slippage stays under 0.5%
```

流程状态：

```text
Parsing intent
Reading DeepBook liquidity
Compiling PTB
Running Guardian checks
Awaiting confirmation
Executing on Sui
```

风险文案示例：

```text
Slippage exceeds your limit.
The current order book cannot fill this size cleanly.
Quote is stale. Refresh before signing.
This PTB will not execute unless all commands pass atomically.
```

确认按钮：

```text
Confirm guarded execution
```

高风险按钮：

```text
Blocked by Guardian
```

### 3. Intent Parser

LLM 只输出受约束 JSON，不允许直接生成交易代码。

支持 intent：

- DeepBook market buy
- DeepBook market sell
- DeepBook limit order
- Stablecoin transfer
- Quote-only preview

Schema：

```json
{
  "action": "deepbook_market_order",
  "side": "buy",
  "baseToken": "SUI",
  "quoteToken": "USDC",
  "amount": "20",
  "amountType": "quote",
  "maxSlippageBps": 50,
  "venue": "deepbook",
  "confirmationRequired": true
}
```

LLM system prompt 要强调：

- 只解析用户意图。
- 不生成 PTB 代码。
- 不绕过 guardian。
- 缺少金额、资产、方向时返回 `needs_clarification`。
- 输出必须符合 schema。

### 4. DeepBook Integration

优先接 DeepBookV3 SDK。

MVP 功能：

- 查询 SUI/USDC 或可用主流池。
- 获取盘口深度或 quote。
- 支持 market order 或 limit order。
- 生成 DeepBook PTB。
- 展示 order book 风险信息。

Guardian 使用 DeepBook 数据检查：

- spread
- estimated slippage
- liquidity depth
- quote age
- order size vs visible depth
- volatile pair warning

如果真实 DeepBook 下单集成时间不够：

- 保留真实 quote/read path。
- 执行阶段先用 testnet/demo Move contract 模拟。
- Demo 叙事仍以“DeepBook-ready PTB compiler”为主，但尽量争取至少一笔真实 DeepBook order。

### 5. Gasless / Sponsored Strategy

不要误宣传“DeepBook swap 直接无 gas”。

准确策略：

- **Gasless Stablecoin Transfer**：只用于 allowlisted stablecoin transfer 场景，例如 USDC 转账，不用于 DeepBook swap。
- **Sponsored Transactions**：用于 DeepBook order 的 gas 抽象，由项目 sponsor 支付 gas。
- UI 中显示 `Gas mode`：
  - `Sponsored by DeepPilot`
  - `Gasless stablecoin transfer`
  - `User pays gas`

Sponsored flow：

1. 用户构建 gasless transaction intent。
2. 后端 sponsor 校验 PTB 是否只包含允许的 DeepBook/日志调用。
3. sponsor 设置 gas owner/payment。
4. 用户签名。
5. sponsor 或客户端提交 dual-signed transaction。

Sponsor 必须校验：

- package allowlist
- Move call allowlist
- max gas budget
- max trade size
- max daily sponsored tx per wallet
- guardian result is not blocked

### 6. Telegram Mini App

做 Telegram 作为加分项，不作为第一周阻塞项。

功能：

- `/start` 打开 DeepPilot Mini App。
- Telegram Mini App 内输入 intent。
- 使用 Telegram theme params 做明暗主题适配。
- 支持 fullscreen、安全区、移动端底部确认栏。
- 交易完成后生成可分享 summary：
  - intent
  - risk score
  - tx digest
  - DeepBook pair

Telegram 技术：

- Next.js 同一个前端适配 Telegram WebApp SDK。
- 后端校验 Telegram `initData`。
- Bot 只负责启动 Mini App 和发送交易摘要。
- 钱包连接优先用移动钱包 deep link；后续可加 zkLogin。

### 7. Move On-chain Log

写一个简单 Move package：`deep_pilot_log`。

对象/事件：

- `IntentRecord`
- `RiskRecord`
- `ExecutionRecord`

字段：

- user address
- intent hash
- action type
- venue: DeepBook
- pair
- risk score
- risk level
- guardian decision
- tx digest reference
- timestamp
- sponsored or not

设计原则：

- 不上链完整自然语言 prompt。
- 不上链隐私数据。
- 上链 hash、摘要、risk decision。
- 方便 demo 时用 explorer 或前端 activity feed 查到。

### 8. AI Guardian

规则引擎负责判断，LLM 负责解释。

风险类型至少实现：

- `HIGH_SLIPPAGE`
- `LOW_LIQUIDITY`
- `STALE_QUOTE`
- `WIDE_SPREAD`
- `LARGE_ORDER_SIZE`
- `UNSUPPORTED_INTENT`

默认策略：

- Low：允许确认。
- Medium：允许确认，但 UI 显著提醒。
- High：默认阻止。
- Blocked：不能签名，只能修改 intent 或刷新 quote。

Guardian 输出：

```json
{
  "score": 76,
  "level": "high",
  "blocked": true,
  "findings": [
    {
      "type": "HIGH_SLIPPAGE",
      "title": "Slippage above limit",
      "explanation": "The estimated execution price is worse than your 0.5% limit."
    }
  ]
}
```

## Implementation Phases

### Phase 1: High-end Web MVP

目标：先做出能打动评委的丝滑界面和完整假数据流程。

交付：

- Next.js 项目
- 高端 Web3 UI
- Intent 输入
- 动态解析过程
- PTB preview mock
- Guardian risk panel
- Confirm flow mock
- Vercel 部署

验收：

- 桌面和移动端都顺滑。
- 动效不卡顿。
- 一分钟内能讲清楚产品价值。
- 不像普通 chatbot。

### Phase 2: Real Sui/PTB

目标：接真实 Sui SDK。

交付：

- `@mysten/sui` v2
- `@mysten/dapp-kit-react`
- 钱包连接
- PTB builder
- transaction simulation
- tx digest 展示
- Move log package

验收：

- 能生成真实 PTB。
- 用户确认前不能执行。
- 链上能查到 log。
- 风险 blocked 时不能签名。

### Phase 3: DeepBook

目标：让项目真正贴合 Sui DeFi。

交付：

- DeepBookV3 SDK 或合约调用集成
- DeepBook quote/order preview
- market/limit order 至少一种
- order book depth 风险检查
- 真实或 testnet 执行演示

验收：

- 至少一个 DeepBook 相关 PTB。
- 至少一个真实链上交易。
- Guardian 能根据 DeepBook 数据触发风险。

### Phase 4: Gasless / Sponsored

目标：做出“用户不用懂 gas”的高级体验。

交付：

- sponsored transaction backend
- sponsor allowlist policy
- gas mode UI
- stablecoin transfer gasless demo
- DeepBook order sponsored gas demo

验收：

- USDC transfer 可展示 gasless stablecoin path。
- DeepBook order 可展示 sponsored transaction path。
- UI 准确区分 gasless 与 sponsored，避免错误宣传。

### Phase 5: Telegram Mini App

目标：做传播和体验加分项。

交付：

- Telegram Bot
- Mini App launch
- Telegram theme/safe-area/fullscreen 适配
- intent summary 分享
- transaction result pushback

验收：

- Telegram 内能打开完整移动端流程。
- 能输入 intent、看风险、跳转签名/执行。
- 能分享交易摘要或 risk receipt。

## Test Plan

- Intent parser：
  - 英文 intent 正确解析。
  - 中文 intent 正确解析。
  - 缺少金额/资产/方向时返回 clarification。
  - prompt injection 不能生成任意交易。

- Guardian：
  - 高滑点触发 `HIGH_SLIPPAGE`。
  - quote 超时触发 `STALE_QUOTE`。
  - 深度不足触发 `LOW_LIQUIDITY`。
  - High risk 默认 blocked。

- PTB：
  - preview 与实际 PTB commands 一致。
  - 用户未确认不能执行。
  - blocked 风险不能执行。
  - PTB 执行失败时 UI 显示失败原因。

- Sponsored：
  - sponsor 拒绝非 allowlist Move call。
  - sponsor 拒绝超过 gas budget 的交易。
  - sponsor 拒绝 guardian blocked 的交易。
  - dual signatures 正确提交。

- Telegram：
  - initData 校验通过。
  - safe area 不遮挡按钮。
  - fullscreen 模式下交互正常。
  - 低性能设备减少重动画。

- UX：
  - 桌面 1440px、移动 390px 都不溢出。
  - 所有按钮文字不换行挤压。
  - 动效不影响核心交易状态可读性。
  - Lighthouse performance 目标 85+。

## Assumptions

- 当前仓库只有 `proposal.md`，项目从零开始。
- 主赛道仍选 Sub-track 3: Intent Engine。
- 项目名称默认改为 **DeepPilot**。
- 优先做 Web App，Telegram 是加分项第二入口。
- DeepBook 是核心交易场景。
- Gasless 要准确表达：stablecoin transfer 可 gasless，DeepBook order 用 sponsored transaction。
- LLM 只做 intent parsing 和风险解释，不直接生成可执行交易代码。
- 上链只记录 hash 和结构化摘要，不记录完整 prompt。

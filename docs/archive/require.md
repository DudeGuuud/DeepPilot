# DeepBook Predict 问题陈述（中文翻译）

加入我们的 Telegram 群：https://t.me/+bZTS2KvwIBQyOGZl

关注我们的 X（推特）获取更新：DeepBook Protocol on Sui (@DeepBookonSui)

在 DeepSurge 报名：https://www.deepsurge.xyz/hackathons/b587dc0c-4cb8-4e63-ada5-519df38103bf

Workshop：
- Sui Overflow Workshop: How to Trade on DeepBook Predict（YouTube）: https://www.youtube.com/watch?v=8m3Q9My-qDo
- FAQ: https://mystenlabs.notion.site/db-predict-workshop-faq

## 赛题背景

预测市场现在很强大，但仍然本质上碎片化且浅层。大多数现有场内市场仍是由撮合订单簿匹配的事件市场（如 Polymarket、Kalshi）或“伪市场化”的链下体育博彩。它们结算缓慢，往往只列出狭窄的二元结果，不能为期权行权价或价差区间定价，也没有真正的标的波动率曲面这一定价基础——这使得严肃的量化策略、结构化产品与链上风险转移几乎不可能实现。

随着预测市场从“X 是否会发生”这种新奇型竞猜，逐步演进为真正的加密市场基础设施，它需要更坚实的基础：

- 能够给**每一个**行权价和到期日定价的活跃波动率曲面，而不是只支持手工列出的事件；
- 使用短期限、滚动到期模型运行的市场（如小时级周期），而不是每周更新的低频结构；
- 提供始终有对手方的金库，使流动性持续存在，并且其链上 LP 经济可审计、可组合；
- 具备可移植的原语，能与更广泛的 Sui DeFi 生态协同（可与保证金、借贷、结构化金库、交易机器人组合，而不是被绑定在某个单体应用内）。

本赛道的目标就是围绕 DeepBook Predict 构建创新产品与工具。DeepBook Predict 是基于 Sui 的可编程、按波动率曲面定价的预测协议。

## DeepBook Predict 现状

Predict 协议目前在 Sui testnet 上线，支持滚动的短期 BTC 预言机，公开索引器/API 为 `predict-server.testnet.mystenlabs.com`，并使用 `dUSDC` 作为报价资产。主网将上线，黑客松期间构建的项目需要在主网发布日当天尽快迁移上线。

Sui 主网上，已可用于组合的 DeFi 体系包括：
- DeepBook spot
- `deepbook_margin`（杠杆交易 + 清算）
- `iron_bank`（带有 Slush 用户金库的准入制 USDsui 供应）

**提示：
你需要 dUSDC 才能使用 DeepBook Predict，这不是 testnet 官方 USDC。
可在此申请 dUSDC：** https://tally.so/r/Xx102L

---

## 你将构建什么

构建功能型应用、服务、金库、机器人或分析工具——可以是单一产品，也可以是多组件协同；支持消费级、专业级、结构化金融、社交型等多种形态。

我们尤其关注以下方向：

1. **Vault/结构化策略**
- 将资金程序化分配到 Predict 仓位、范围仓位与 PLP 补贴（如分层区间金库、PLP+对冲金库、BTC 质押收益收割器、三协议杠杆循环）。

2. **跨场外套利（Cross-venue arbitrage）**
- 构建机器人在 Predict 的波动率曲面和 Polymarket / Hyperliquid 事件市场之间捕捉价差；
- 或与 Hyperliquid 永续合约配合做对冲。

3. **前端/社交化体验**
- 包括游戏化预测应用、移动优先 PWA、Telegram Bot 等，做出主流专业 UI 覆盖不到的行为，如连胜系统、社交动态、聊天下单、手表表盘组件等。

4. **分析与开发者工具**
- 让 Predict 可解释、可观测：
  - 实时 SVI 曲面展示
  - PLP 风险看板
  - 经理人 PnL 归因
  - 结算排行榜
  - oracle 健康监控

可集成方向（Integration and tooling）建议：
- 构建基于 `PredictManager` 的份额代币化，让仓位可组合接入其他 Sui DeFi（保证金抵押、LP 复用、结构化产品）；
- 与 `deepbook_margin` 和 `iron_bank`（均已主网上线）组合，构造收益放大、杠杆或跨协议对冲策略；
- 开发 keeper 服务与编排层，例如结算赎回 keeper、预言机监控、提币限额监控，使用 `predict::redeem_permissionless` 和 `predict-server` 事件流；
- 构建更易于检查、调试或管理 Predict 市场、金库状态与每个用户 `PredictManager` 的接口和工具。

你的项目形态可以是：
- 面向用户的应用或交易前端
- 基于 Predict 的金库、结构化产品、可组合代币
- 机器人、 keeper 或套利服务
- 开发者工具、SDK 或分析看板

---

## 最低参赛要求（Minimum requirement）

要通过资格审核，项目必须：

1. 在 testnet 上集成 DeepBook Predict 合约；
2. 如果是产品类项目，必须端到端可运行，我们将测试完整流程；
3. 若构建金库策略，需要给出完整的模拟结果。

---

## 想法清单（Idea bank）

以下仅为起点，可选改造、可变体、也可全部忽略。

### A. Vaults & 结构化产品

1. **Range Ladder Vault**
- 自动将用户资金按每次到期在 ATM 附近的一串 Predict 范围中分配，并在结算时自动滚动到下一到期；
- 可发行可迁移的份额代币；
- 可增加的开发点：
  - 区间宽度策略（固定基点、按 1σ、按动态实波动）
  - 深度 ITM/OTM 时的处理
  - 提现队列机制

2. **PLP + 对冲金库**
- 向 `predict::supply` 供应 dUSDC 获取 PLP 收益，同时买入部分 OTM 二元仓位进行尾部风险对冲。
- 产品定位：“PLP 收益减去崩盘保险成本”。
- 可扩展点：
  - 根据 vault 利用率动态调节对冲比例
  - 到期前后回售对冲仓位
  - 输出扣除保险成本后的净 APY

3. **BTC 抵押 Predict 金库**
- 接受 BTC（xBTC、sBTC 等）作为入金，经过 DeepBook 现货兑换成 dUSDC 后存入 `PredictManager`，运行方向性或区间策略，再在结算日换回 BTC 收益。
- 可扩展点：
  - 策略选择（delta 中性收益收割 / 方向动量）
  - FX 成本透明计价
  - 结算日换回链路

4. **三协议杠杆循环（Three-Protocol Margin Loop）**
- 抵押 `iron_bank` USDsui 份额借出 dUSDC，在 `deepbook_margin` 上借贷，再投到 Predict 范围仓位，结算后回款还款。
- 可作为“主网上线可演示”级示例。扩展点：
  - 设计清算路径
  - 按最坏情况推导 LTV 上限
  - 一体化 PTB 原子化执行

### B. 前端与消费级应用

5. **Telegram 快速预测 Bot**
- 支持指令 `/up 70000 15m 100usdc`，解析后执行 `predict::mint`；
- 内联按钮提供“立即赎回 / 查看盈亏 / 群内分享”；
- 结算后 DM 通知结果。
- Bot 可在首次使用时创建 `PredictManager` 并做 dUSDC 充值。
- 玩法扩展：群内锦标赛、跟单钱包、群内榜单。

6. **Streaks 与排行榜 PWA**
- 日常二元预测（BTC 涨跌）与连胜系统、周奖池；
- 移动优先体验。
- 可选：连胜 NFT 勋章、基于链上 manager 关系的社交图谱。

### C. 机器人、keeper 与套利

7. **Vol-Arb Bot：Predict ↔ Polymarket**
- 根据 `OracleSVI` 反解出 Predict 的隐含波动率，
  与 Polymarket 对应到期的 BTC 期权微笑对比；
- 当价差超阈值执行跨市套利。
- 进阶：通过 Hyperliquid 永续做 delta 对冲，让 PnL 主要来自波动率边界。
- 推荐做法：处理 `SVI` 更新滞后、按凯利比例下单、喂价延迟熔断。

8. **Settled-Redeem Keeper Network**
- 监听已结算预言机和 indexer 中未赎回仓位；
- 通过单笔 PTB 调用 `predict::redeem_permissionless` 为用户代领收益（按规则分账）；
- 适合作为无人值守起步项目，能持续在 testnet 打大量 tx。
- 进阶：
  - 多 keeper 协同防止重复抢同一仓位
  - 防 MEV 设计
  - tip 模式（自动提示 vs 不提示）

### D. 分析与开发者工具

9. **Predict Surface Studio**
- 实时渲染 3D 波动率曲面（strike × expiry → IV），并支持时间回放；
- 实时显示套利检查：如蝶式/日历结构异常。
- 供专业用户做交易前 sanity check。
- 可扩展：与 Polymarket 微笑对比、形态突变警报、可嵌入 widget。

10. **PLP 风险仪表板**
- 显示 vault 使用率、提币限流桶状态、每个 oracle 头寸拆解、
  ±5σ BTC 变化下的 PnL 情景模拟；
- 直接回答“PLP 是否安全”这个 LP 决策关键问题。
- 可扩展：历史回撤回放、区间库存热力图、可导出的风险报告。

---

## 参考资料

- DeepBook Predict 代码库（协议、当前 testnet 部署、接入模型）：
  - https://github.com/MystenLabs/deepbookv3/tree/predict-testnet-4-16/packages/predict
  - 注意分支：`predict-testnet-4-16`（非 `main`）

- DeepBook sandbox（本地一键部署整套 DeepBook，预测支持正在到来）：
  - https://github.com/MystenLabs/deepbook-sandbox

- DeepBook Predict 文档：
  - https://docs.sui.io/onchain-finance/deepbook-predict/

- DeepBook v3 文档：
  - https://docs.sui.io/onchain-finance/deepbookv3/deepbook

- DeepBook margin 文档：
  - https://docs.sui.io/onchain-finance/deepbook-margin

---

## 加入 DeepBook Builder Group

有疑问或需要支持可加入官方社群：
- https://go.sui.io/ofw-deepbook-tg

# DeepBook Predict 公开接口可行性复核（finds）

> 结论先行：这个方向**可做，但不能把 mid/spread/liquidity 当作 DeepBook server 原生直接字段**。可行路径是“原生可得字段 + 自定义算子/降级策略”。

## 1) 官方文档对比与边界（可落地证据）

### 1.1 官方公开定位
- `DeepBook Predict` 文档明确给出：主网前这是 testnet 集成面，基于 `predict-testnet-4-16`。
- 推荐集成模型是三层：
  - `predict-server.testnet.mystenlabs.com`（渲染/历史/账户）
  - Sui checkpoint/event 流（低延迟与鲜度）
  - 关键交易前后链上对象直接读
  
  **来源：** [DeepBook Predict 总页](https://docs.sui.io/onchain-finance/deepbook-predict/)、[Contract Information](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)

### 1.2 Contract Information（官方声明）
- 测试网部署参数（已公开）：`Predict package`、`Predict registry`、`Predict object`、`DUSDC quote asset`。
- 公共端点清单（官方页列出）：
  - `GET /status`
  - `GET /predicts/:predict_id/state`
  - `GET /predicts/:predict_id/oracles`
  - `GET /oracles/:oracle_id/state`
  - `GET /predicts/:predict_id/quote-assets`
  - `GET /oracles/:oracle_id/ask-bounds`
  - `GET /predicts/:predict_id/vault/summary`
  - `GET /predicts/:predict_id/vault/performance`
  - `GET /managers*`
  - `GET /oracles/:oracle_id/prices*`
  - `GET /oracles/:oracle_id/svi*`
  - `GET /positions/minted`,`/positions/redeemed`,`/ranges/minted`,`/ranges/redeemed`,`/trades/:oracle_id`
- Live 事件（官方声明）：
  - `oracle::OraclePricesUpdated`
  - `oracle::OracleSVIUpdated`
  - `oracle::OracleSettled`
  - `oracle::OracleActivated`

  **来源：** [Contract Information：端点与事件](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)

### 1.3 合约能力（不是只“有 API 列表”，还有执行语义）
- `predict.move` 公开了核心动作：
  - 交易预览：`get_trade_amounts`, `get_range_trade_amounts`
  - 下单赎回：`mint`, `redeem`, `mint_range`, `redeem_range`
  - `redeem_permissionless`（可做代领 keeper 的核心）
  - LP 流动性：`supply`, `withdraw`
  - `compact_settled_oracle`
  - 读取函数含问询 ask bounds、交易暂停、价格配置、风险参数、oracle 配置等
- `oracle.move` 的生命周期事件：`OracleActivated`, `OracleSettled`, `OraclePricesUpdated`, `OracleSVIUpdated`，并暴露 `status() / is_settled / expiry / spot / forward / svi / settlement_price`。
- `vault.move` 的关键可观测量与状态：`total_mtm`, `total_max_payout`, `vault_value`, `balance`, `available_withdrawal`（由 rate limiter 辅助）
- `rate_limiter`（出于 LP 提现保护）提供 `capacity / refill_rate / available` 等可读项。

  **来源：**
  - [Predict 合约页](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict)
  - [Oracle 合约页](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle)
  - [Vault 合约页](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault)
  - [Predict 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move)
  - [Oracle 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/oracle.move)
  - [Vault 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/vault/vault.move)
  - [Rate limiter 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/helper/rate_limiter.move)

## 2) 实测接口结果（2026-06-11，当前仓库时段）

以下为实时 sample（非教学 mock）：

- `/status`
  - 返回 `current_time_ms`、`latest_onchain_checkpoint`、每个 pipeline 的 `time_lag_ms/time_lag_seconds/checkpoint_lag`
  - 对 `oracle_prices_updated`、`oracle_settled` 等关键 pipeline 能直接做鲜度告警

- `/predicts/{predict_id}/oracles`
  - 返回每个 oracle 的 `oracle_id`、`status=active`、`expiry`、`min_strike`、`tick_size`、`activated_at`。

- `/oracles/{oracle_id}/state`
  - 返回 `latest_price{spot, forward, onchain_timestamp}`、`latest_svi` 参数、`settlement_price`。
  - 实测样本有 `spot/forward`、`svi` 全部可读。

- `/oracles/{oracle_id}/ask-bounds`
  - 实测返回 `null`（多 oracle 采样也为 null），说明该字段可空，不能假设可直接拿到。

- `/predicts/{predict_id}/vault/summary`
  - 返回 `vault_balance`,`vault_value`,`total_mtm`,`total_max_payout`,`available_liquidity`,`available_withdrawal`,`plp_total_supply`,`utilization` 等，适合做 vault 风险与流动性告警。

- `/managers/{manager_id}/summary`
  - 返回 `trading_balance/open_exposure/redeemable_value/open_positions/awaiting_settlement_positions`，适合用户账户状态看板。

- `/trades/:oracle_id`
  - 本次采样返回 `[]`，说明历史交易可能“暂时稀疏/窗口为空”，不能依赖它持续覆盖真实行情深度。

  **来源：** [Contract Information：端点定义](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)

## 3) 对“可行性”的直接结论（用户最关心）

### 3.1 你可以算的（推荐作为 MVP 指标）
- `oracleAge`：
  - 直接用 `oracle` 状态里的 `timestamp / onchain_timestamp` 做新鲜度。
  - 或拿 `/status` 的 pipeline lag。
- `vault 风险`：
  - `total_mtm / vault_value`, `utilization`, `total_max_payout`, `available_withdrawal`。
- `可否结算/代领`：
  - `position`、`range` 历史 + oracle 状态已结算标记。
- `PLP 风控`：
  - `vault summary` 与 `performance` 已能构建时序报表。

### 3.2 不能直接拿到或需降级
- `mid/spread/真正 liquidity depth` 并非 API 的“现成字段”。
  - `mid` 可以从 `latest_price.spot/forward` 或 `get_trade_amounts` 的报价差值近似，不应直接宣称是 orderbook mid。
  - `spread` 要么从合约定价模型推导（`get_trade_amounts` 或定价公式）
  - `liquidity` 不能得到标准 orderbook 档位；可用替代指标（vault 余额、`total_max_payout`、历史成交事件、ask-bounds 可用性）作为风控 proxy。

  **来源：** [Contract Information：端点缺口](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)、[Predict 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move)

### 3.3 推荐的保真度边界（方案说明里必须写）
- 明确写“**交易页/风险页显示的是可核验近似指标**，不是交易所级逐笔 depth”。
- 中间逻辑里加入降级路径：
  - `ask-bounds` 为空时，降级到只基于 vault 利用率/可用流动性做告警，不做严格价格区间硬拒绝。

  **来源：** [Contract Information：ask-bounds 与 vault 指标](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)

## 4) “不是普通 Agentic Web” 的额外加分点（docs 明确可行）

下面这些不只是文案，是和公开能力一一对应：

### 4.1 Settled-Redeem Keeper（核心、强加分）
- 依据：`redeem_permissionless`（on-chain）、`oracle::OracleSettled`（event）、位置类事件。
- 可做：扫描 `PositionMinted/RangeMinted` 与 `OracleSettled`，发现可赎回持仓自动代领。
- 额外亮点：记录 `executor`、执行时间、调用参数，形成 keeper 审计日志。

  **来源：** [Predict 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move)、[Oracle 页面](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle)、[Predict Manager 页面](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict-manager)

### 4.2 交易后生命周期监控（OracleAge + stale 告警）
- 依据：`/status` 的 pipeline lag + `/oracles/*/state` 的 `onchain_timestamp`。
- 可做：
  - 当 oracle 更新延迟超阈值（ms/s）自动阻断 quote。
  - 当状态不再 active（pending/settled）自动提示用户。

  **来源：** [Contract Information：状态与健康检查](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)

### 4.3 风险看板（PRIME 偏好）
- 依据：
  - `vault/summary`: `utilization`, `max_payout_utilization`, `available_withdrawal`
  - `managers/*/summary`: `open_positions/redeemable_value`
- 可做：
  - ALLOW/REDUCE/BLOCK 三档决策树，附原因码。
  - `open_exposure` + `vault_value` 联动输出单用户影响区间。

  **来源：** [Contract Information：Vault/Manager 摘要接口](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)、[Vault 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/vault/vault.move)、[PredictManager 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict_manager.move)

### 4.4 Vol-Arb（最小版）
- 依据：`svi` 与 `spot/forward` 可取，配上外部市场（Polymarket / Perps）对标。
- 可做最小：
  - 取单 oracle 的实时指标计算偏离并告警，不急于自动下单。

  **来源：** [Oracle 页面](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle)、[Oracle 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/oracle.move)

### 4.5 LP 风控增强（文档常被忽略）
- 依据：`withdrawal_limiter`（`available_withdrawal`）、`total_max_payout`。
- 额外价值：能提供“预期可提取”“最大可兑付”视图，比单纯 TVL 更能打动赛道评审。

  **来源：** [Vault 页面](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault)、[Vault 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/vault/vault.move)、[Rate limiter 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/helper/rate_limiter.move)

### 4.6 事件级治理可解释性
- 依据：公开事件（`PositionMinted/PositionRedeemed/RangeMinted/RangeRedeemed/Supplied/Withdrawn/PredictManagerCreated`）。
- 可做：事件 -> 执行痕迹 -> 可复核哈希输出链路。

  **来源：** [PredictManager 页面](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict-manager)、[Predict 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move)

## 5) 与 Proposal 方向匹配建议（你现在那版可以加的改动）

1. 把“mid/spread/liquidity”改描述为：
   - `mid`：`spot/forward` 与成交报价近似值。
   - `spread`：基于 `get_trade_amounts` 与定价模型偏移。
   - `liquidity`：vault 风控指标（`available_liquidity`, `total_mtm`, `utilization`, `total_max_payout`）
2. 增加 `ask-bounds` 空值防御（sample 已证明 null 常见）。
3. 在 keeper 中强制记录 3 条：
   - oracle settlement 事件时间
   - 可赎回持仓签名映射
   - 代领 tx 的 tx digest（成功/失败）
4. 增加 `/status` lag 告警面板（pipeline 阈值）作为“鲜度护栏”与主打技术加分。

   **来源：** [Contract Information：get_trade_amounts/ask-bounds/状态事件](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)、[Predict 代码](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move)

## 6) 小结

- 结论：DeepBook Predict 的接口和合约能力足以支撑你现在的产品方向（预测交易入口 + 风控看板 + keeper + 异常告警）。
- 限制：不能把“标准深度/盘口 mid/spread/liquidity”当成官方直接指标；要把“可计算 proxy + 降级策略”写入提案，否则容易在评审环节踩边界。
- 因此该方向不是“不能做”，而是“能做，但要把边界提前澄清 + 把指标定义落地”。

- 参考资料汇总（可直接放进 PR/提案附录）
  - [DeepBook Predict（总页）](https://docs.sui.io/onchain-finance/deepbook-predict/)
  - [Contract Information](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)
  - [Predict 合约说明](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict)
  - [Oracle 合约说明](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle)
  - [Vault 合约说明](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault)
  - [PredictManager 合约说明](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict-manager)
  - [Registry 合约说明](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/registry)
  - [Market Keys 说明](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/market-keys)
  - [predict.move 源码（deepbookv3）](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict.move)
  - [predict_manager.move 源码（deepbookv3）](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/predict_manager.move)
  - [oracle.move 源码（deepbookv3）](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/oracle.move)
  - [vault/vault.move 源码（deepbookv3）](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/vault/vault.move)
  - [registry.move 源码（deepbookv3）](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/registry.move)
  - [rate_limiter 源码（deepbookv3）](https://github.com/MystenLabs/deepbookv3/blob/predict-testnet-4-16/packages/predict/sources/helper/rate_limiter.move)

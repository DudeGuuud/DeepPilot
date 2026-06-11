# Final Proposal: DeepPilot RiskOps for DeepBook Predict

> 版本日期：2026-06-11  
> 目标赛道：Sui Overflow 2026 - DeepBook specialized track  
> 最终判断：继续做 DeepPilot，但必须从“泛 AI 交易终端”收敛为“DeepBook Predict 原生执行、风控与 keeper 闭环”。不要把它包装成传统 orderbook depth 交易台，也不要把未完成的 vault/跨市场套利写成核心交付。

## 1. Executive Summary

DeepPilot RiskOps 是一个面向 DeepBook Predict 的 AI-assisted execution and risk cockpit。用户用自然语言或结构化表单表达预测交易意图，系统从 DeepBook Predict testnet 公共 API 和链上对象读取市场、oracle、vault 与账户状态，把交易转换成可审核的 PTB 执行计划，并在签名前给出 `ALLOW / REDUCE / BLOCK` 风控结论。交易完成后，系统继续监控到期、结算和可赎回状态，通过 Settled-Redeem Keeper 补齐预测市场最容易断掉的交易后生命周期。

一句话：

> DeepPilot turns DeepBook Predict market data into guarded, auditable prediction-market transactions and post-settlement actions.

核心交付不是“AI 帮我下单”，而是：

1. 真实 DeepBook Predict testnet 数据接入。
2. Predict intent 到 PTB 的可审计编译。
3. 基于 oracle freshness、oracle lifecycle、vault utilization 和价格 proxy 的 Guardian 风控。
4. 到期/结算/赎回 keeper，让交易从开仓到收尾完整闭环。
5. 每一步输出可复核工件：API snapshot、oracle id、risk reasons、PTB digest、transaction digest、keeper log。

## 2. Why This Is the Best Direction

Sui Overflow 页面把 DeepBook 列为 specialized track，方向是 build trading or liquidity applications powered by DeepBook's on-chain orderbook，并列出 DeepBook specialized track pool 为 70,000 USD。[1] DeepBook Predict 赛题本身更具体：要求在 Predict testnet 上做功能型 app、service、vault、bot 或 analytics，最低要求是 testnet 集成 DeepBook Predict 合约，产品类项目必须端到端可运行。

DeepBook Predict 官方文档确认它是 Sui 上 expiry-based prediction market protocol，支持 binary positions、vertical ranges、oracle-based pricing、PredictManager、vault liquidity 和公共 indexed server。[2] 官方集成模型也明确建议组合三类数据源：public Predict server 用于页面和历史数据，Sui checkpoint/event streaming 用于低延迟 oracle 更新，交易前后再直接读取链上对象做确认。[2]

因此，获奖概率最高的定位不是普通 Agentic Web，也不是复杂但难落地的 vault，而是：

- 面向用户：可执行的 Predict 下单和风险解释。
- 面向协议：展示 Predict 的 oracle、SVI、vault、PLP、manager 和 settlement 生命周期。
- 面向评委：每一步能在 testnet/API/tx digest 上被核验。

这比单纯前端、聊天机器人或静态看板更贴合 DeepBook sponsor track。

## 3. Competition Fit

### Direct fit

- Functional application：DeepPilot Web Terminal 让用户完成 market discovery、risk review、PTB preview、wallet/sponsor execution、receipt review。
- Service / keeper：Settled-Redeem Keeper 扫描 settled oracles 和未赎回仓位，支持提醒或 permissionless redeem。
- Analytics：RiskOps 面板把 API 原始字段转成 `ALLOW / REDUCE / BLOCK`，并解释原因。
- DeepBook Predict contract integration：使用 testnet Predict package、Predict object、DUSDC quote asset、public Predict server 和 Predict functions。

### Avoided weak fit

- 不主打“AI 自动交易”。AI 只做受约束 intent parsing，不能绕过 Guardian。
- 不主打“全自动跨市场套利”。比赛期只做 vol deviation alert，不做跨 venue 自动下单。
- 不主打“vault 产品”。除非有完整模拟，否则只做 PLP/vault risk monitor，不承诺结构化金库收益。

## 4. Official Technical Basis

DeepBook Predict 当前 public integration target 在 Sui Testnet，官方 Contract Information 给出：

- Public server: `https://predict-server.testnet.mystenlabs.com`
- Predict package: `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138`
- Predict object: `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a`
- Quote asset: `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC`
- PLP coin type: `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP`
- Source branch: `predict-testnet-4-16`。[3]

官方 endpoint 覆盖：

- Protocol/market state: `/status`, `/predicts/:predict_id/state`, `/predicts/:predict_id/oracles`, `/oracles/:oracle_id/state`, `/oracles/:oracle_id/ask-bounds`
- Vault/LP: `/predicts/:predict_id/vault/summary`, `/predicts/:predict_id/vault/performance`
- Manager/portfolio: `/managers`, `/managers/:manager_id/summary`, `/managers/:manager_id/positions/summary`
- History: oracle prices, SVI, minted/redeemed positions/ranges, trades。[3]

合约设计支持该方案：

- `Predict` 是主要协议入口，负责 manager balances、oracle state、pricing config、risk config 和 vault accounting。[4]
- `PredictManager` 是每个用户复用的 shared account，持有 quote balances、binary positions 和 range quantities。[5]
- `OracleSVI` 存储 spot、forward、SVI 参数、状态、timestamp 和 settlement price，mints 需要 live oracle，settlement 后停止价格和 SVI 更新。[6]
- Vault 持有 quote assets，并作为每笔 Predict trade 的对手方，记录 exposure、mark-to-market liability、max payout 和 PLP 流动性状态。[7]
- PTB 可以把多步 Move call、coin 管理和对象操作组合成单笔原子交易，失败则整块无效果。[8]
- Sponsored transactions 可以由 sponsor 付 gas，但 sponsor 需要校验交易并参与签名，不能把它描述成“无条件 gasless”。[9]

## 5. API Sanity Check

本次在 2026-06-11 使用 Bun 直接请求 `https://predict-server.testnet.mystenlabs.com`。结论：API 可用，适合支撑 MVP，但必须写清边界。

| Endpoint | Result | What it proves | Boundary |
| --- | --- | --- | --- |
| `GET /status` | 200 OK, latency 366ms, `status=OK`, max time lag about 1s | 可做 indexer/pipeline health guard | 仍需处理偶发滞后 |
| `GET /predicts/{predict_id}/state` | 200 OK, quote asset 返回 DUSDC | Predict object 和 quote asset 可读 | pricing/risk 字段当前为 null，不能依赖它们直接渲染所有风控 |
| `GET /predicts/{predict_id}/oracles` | 200 OK, 返回 3723 个 oracle，sample 为 BTC active | 可发现 active markets | 需要筛选 expiry、status 和 strike grid |
| `GET /oracles/{oracle_id}/state` | 200 OK, 返回 active oracle、latest_price、latest_svi | 可取 spot/forward/SVI/timestamp | 价格 scale 必须统一处理 |
| `GET /oracles/{oracle_id}/ask-bounds` | 200 OK, body 为 `null` | endpoint 存在 | 不能假设 ask bounds 一定可用 |
| `GET /predicts/{predict_id}/vault/summary` | 200 OK, 返回 `vault_balance`, `vault_value`, `total_mtm`, `total_max_payout`, `available_liquidity`, `available_withdrawal`, `utilization`, `max_payout_utilization` | 可做 vault/LP risk proxy | 不是传统盘口 depth |
| `GET /trades/{oracle_id}` | 200 OK, 当前返回 `[]` | endpoint 可用 | 不能依赖 trade history 做实时流动性判断 |

Selected sample oracle:

- Oracle id: `0x953efffe9caea3e9a2c035c61dad84f053be0ee363f77c6c120b4ba1d54b5dcd`
- Underlying: `BTC`
- Status: `active`
- Latest price fields included `spot`, `forward`, `onchain_timestamp`
- Latest SVI fields included `a`, `b`, `rho` and additional SVI parameters

## 6. Hidden Risks Found

### Critical risks

1. Repository drift from the Predict target.
   - Status after cleanup: the old `src/lib/deepbook.ts` mock path has been replaced by `src/lib/predict.ts`, which reads Predict testnet status, oracle state and vault summary.
   - Remaining risk: real submission still needs exact Predict Move-call arguments, funded DUSDC, and a user `PredictManager`.

2. DeepBook Predict is testnet and provisional.
   - Official docs warn package IDs, object layouts and entry points can change before mainnet.[2][3]
   - Proposal must say “testnet integration target” and keep all IDs configurable.

3. DUSDC is not normal testnet USDC.
   - Predict quote asset is DUSDC. Demo wallets need DUSDC from the official request flow.[2][3]
   - Without DUSDC, real mint/deposit demo can fail even if API reads work.

4. Mid/spread/liquidity are not native orderbook fields in Predict API.
   - Predict uses oracle pricing, SVI, spread/utilization adjustment and vault exposure, not a normal visible CLOB depth model.[4]
   - Final UI should label `spot/forward`, `pricing proxy`, `vault liquidity proxy`, `utilization`, not pretend to show traditional bid/ask depth.

5. `ask-bounds` can be null.
   - API probe returned `null`; guardrail must degrade to oracle/vault checks instead of crashing or falsely blocking.

6. `trades/:oracle_id` can be empty.
   - API probe returned `[]`; Vol-Arb and activity metrics cannot assume trade history coverage.

7. Vault strategy without simulation is disqualifying or weak.
   - If the project claims a vault strategy, it must include proper simulation. Otherwise, keep vault work as risk analytics, not as a managed strategy.

8. Sponsored transaction support is not a one-line feature.
   - Sui sponsored tx requires gas object management, sponsor validation, dual signatures, and object freshness handling.[9]
   - For hackathon, sponsor should be optional demo path, not required for core execution.

### Medium risks

1. Oracle lifecycle complexity:
   - Active, pending settlement, settled states change what mints/redeems are valid.[6]
   - Guardian must block mint when oracle is not live and route settled positions to redeem logic.

2. Position discoverability:
   - Positions/ranges are stored inside PredictManager, not standalone position NFTs.[5]
   - UI must query manager summaries or manager object state.

3. Unit/decimal mistakes:
   - DUSDC has 6 decimals; BTC oracle price/strike fields use large integer scale.
   - Every screen must show normalized values and raw values in debug mode.

4. AI parser risk:
   - LLM must output constrained JSON only.
   - Missing strike, expiry, amount, direction, quote asset, or manager should return `needs_clarification`.

5. Mainnet timing:
   - Official docs say testnet integration target and future mainnet change.[2][3]
   - Demo should be testnet-first but have a config abstraction for mainnet IDs.

6. Competition page inconsistency:
   - Overflow public page says 2026 and May-August, but some timeline text still references 2025.
   - Submission deadline should be confirmed from DeepSurge/participant dashboard before final scheduling.

## 7. Final Product Scope

### Must ship

1. Predict Market Explorer
   - Pull `/status`, `/predicts/:predict_id/oracles`, `/oracles/:oracle_id/state`, `/predicts/:predict_id/vault/summary`.
   - Show active BTC markets, expiry, strike grid, oracle freshness, spot/forward, SVI status, vault utilization.

2. Intent to Predict Plan
   - Supported intents:
     - Buy binary UP/DOWN position.
     - Buy vertical range.
     - Redeem settled binary/range position.
     - Quote-only preview.
   - Quote-only must stop after market and Guardian review; it must not produce a mint PTB or sponsor approval.
   - Parser output must be typed JSON and never generate Move code directly.

3. Guardian Risk Engine
   - Inputs:
     - `/status` pipeline lag.
     - oracle `status`, `expiry`, latest price timestamp.
     - latest spot/forward/SVI.
     - vault `available_liquidity`, `utilization`, `max_payout_utilization`, `available_withdrawal`.
     - optional ask bounds when non-null.
   - Outputs:
     - `ALLOW`: transaction can proceed.
     - `REDUCE`: amount should be reduced or limit widened.
     - `BLOCK`: stale oracle, non-live oracle, missing DUSDC, missing manager, excessive utilization, or invalid strike/expiry.

4. PTB Preview and Execution Path
   - Build PTB with Predict package target and the configured Predict object.
   - Include create/find `PredictManager`, deposit DUSDC, mint/redeem, and receipt refresh path.
   - Show raw `moveCall` target, object IDs, type args, normalized params and digest.
   - If a real testnet mint is blocked by DUSDC availability, demo must still show a signed/buildable PTB path and clearly mark funding requirement.
   - Keep on-chain audit logging disabled by default for gas efficiency; enable `PREDICT_ENABLE_ONCHAIN_LOG=true` only when a demo needs an extra audit event.

5. Settled-Redeem Keeper
   - Poll or subscribe to oracle settlement and manager summaries.
   - Detect `settled && redeemable && not redeemed`.
   - Offer one-click `redeem_permissionless` PTB.
   - Record keeper log: oracle id, manager id, detected time, action, tx digest or failure reason.

6. Audit Trail
   - Store a local execution trace:
     - market snapshot hash
     - server status timestamp
     - oracle id and status
     - guardian decision and reason codes
     - PTB digest
     - tx digest
     - post-tx refreshed manager/vault state

### Strong add-ons

1. PLP Risk Lens
   - Show vault balance, vault value, total MTM, total max payout, utilization, max payout utilization, available withdrawal.
   - Explain whether LP withdrawal is healthy.

2. Vol Deviation Alert
   - Use latest spot/forward/SVI and recent changes to flag abnormal movement.
   - No auto-trading in MVP.
   - Output “watch”, “manual review”, “block trading until refreshed”.

3. Sponsor Guard
   - Sponsor only whitelisted Predict calls.
   - Reject arbitrary package targets.
   - Re-check every PTB command target, transaction kind and gas budget at the sponsor API boundary.
   - Show sponsor gas mode separately from normal wallet mode.

### Explicitly defer

- Full cross-venue Polymarket/Hyperliquid arbitrage execution.
- Automated leverage through DeepBook Margin.
- Vault strategy that takes deposits and issues shares.
- Telegram Mini App as a primary path.
- 3D volatility surface, unless the core execution path is already complete.

## 8. Implementation Plan Against Current Repo

1. Replace mock quote source.
   - Done in code: `src/lib/predict.ts` uses Predict testnet base URL and IDs.
   - Current functions build a typed market snapshot from status, oracle list, oracle state and vault summary.
   - Next implementation step: add exact on-chain Move-call argument construction for submitted mint/redeem transactions.

2. Add Predict-specific types.
   - Done in code: `src/lib/types.ts` now models Predict intents, oracle state, vault summary, risk metrics, Guardian findings and PTB previews.

3. Update intent parsing.
   - Add actions:
     - `predict_binary_mint`
     - `predict_range_mint`
     - `predict_redeem`
     - `predict_quote_only`
   - Require amount, direction/range, expiry/oracle, strike(s), quote asset.

4. Rewrite Guardian rules.
   - Do not use fake orderbook depth.
   - Use freshness/lifecycle/vault utilization/proxy pricing.
   - Add explicit handling for `ask_bounds === null`.

5. Implement API routes.
   - `/api/predict/status`
   - `/api/predict/oracles`
   - `/api/predict/oracle`
   - `/api/predict/vault`
   - `/api/compile` returns Predict PTB preview and risk trace.

6. Update UI.
   - Keep terminal style, but add Predict-specific panels:
     - Active markets
     - Oracle freshness
     - Vault risk
     - Guardian decision
     - PTB trace
     - Keeper queue

7. Add demo script.
   - Fixed oracle id or dynamic “nearest active BTC oracle”.
   - Fixed DUSDC test wallet.
   - One green-path quote.
   - One red-path stale/lifecycle block simulation.
   - One keeper/redeem path demo.

## 9. Demo Narrative

1. Open DeepPilot.
2. System loads Predict status: server OK, checkpoint lag, active BTC oracles.
3. User types: “Buy 10 DUSDC of BTC UP for the next active expiry near 62500, block if oracle is stale.”
4. Parser creates a `predict_binary_mint` intent.
5. Market panel resolves oracle, expiry and strike.
6. Guardian checks:
   - oracle active
   - latest price timestamp fresh
   - DUSDC quote asset supported
   - vault utilization under threshold
   - ask bounds absent, so uses fallback risk policy
7. UI returns `ALLOW` or `REDUCE`.
8. PTB preview shows exact Move target and objects.
9. Wallet signs and submits, or sponsor path validates and co-signs.
10. Receipt panel shows tx digest and refreshed manager/vault state.
11. Keeper panel shows how a settled position becomes redeemable and how `redeem_permissionless` is prepared.

## 10. Scoring Strategy

### What judges should remember

DeepPilot is the missing operating layer for DeepBook Predict:

- It helps users trade.
- It prevents bad trades.
- It records why a trade was allowed.
- It keeps watching until settlement and redemption.

### Differentiators

1. Real Predict integration, not a mock app.
2. Risk engine tied to official oracle/vault/manager semantics.
3. Post-settlement keeper, which many teams may skip.
4. Audit trail that makes every decision reproducible.
5. Clear boundary between AI convenience and deterministic execution safety.

## 11. Hidden Risk Mitigation Matrix

| Risk | Mitigation |
| --- | --- |
| API/indexer lag | `/status` guard, max lag threshold, retry and visible stale state |
| Testnet IDs change | Config file/env vars, show deployment source branch |
| DUSDC unavailable | Pre-funded demo wallet, token request early, quote-only fallback |
| `ask-bounds` null | Fallback to lifecycle + vault utilization + price freshness |
| No trade history | Do not use `trades` as core; treat as optional historical panel |
| Incorrect mid/spread claim | Rename fields to `spot/forward`, `pricing proxy`, `vault liquidity proxy` |
| AI hallucination | Strict schema, zod validation, no code generation |
| Sponsored tx object conflict | Dedicated sponsor gas pool, rebuild on stale object error |
| Sponsor signs arbitrary PTB | Validate PTB kind, gas budget and every Move target against `src/lib/sponsor.ts` allowlist |
| Extra gas from audit logging | Default `PREDICT_ENABLE_ONCHAIN_LOG=false`; add the log Move call only for explicit audit demos |
| Vault strategy simulation missing | Do not claim vault strategy in MVP |
| Mainnet migration | Build with deployment config and final checklist |

## 12. Success Metrics

- API p50 latency under 2s for market and oracle state.
- Guardian decision returned for 100% of intents.
- Oracle stale/lifecycle block covered in deterministic tests.
- Every PTB preview includes package/object/target/params.
- At least one real testnet tx digest or, if DUSDC gating blocks execution, a buildable PTB plus explicit funding blocker.
- Keeper detects at least one settled/redeemable scenario in test or replay mode.
- Demo can be replayed in under 3 minutes.

## 13. Winning Probability Estimate

This is a subjective estimate because Sui Overflow does not publish current DeepBook track team count. The public page confirms a 70,000 USD DeepBook specialized pool, while the broader hackathon has 500,000 USD+ prizes and historically high participation.[1]

Assumptions:

- DeepBook valid submissions: 25 to 50 teams.
- Prize slots: likely 3 to 5 teams based on a 70,000 USD sponsor pool.
- Baseline random odds for any prize: roughly 8% to 16%.
- Quality multiplier for a real Predict testnet app with keeper and risk audit trail: 2.0x to 2.8x.

Estimated probabilities:

- Pre-cleanup repo, with mock data and no real Predict tx: 3% to 6%.
- Proposal-only plus API-backed UI but no real PTB/tx: 8% to 14%.
- Final recommended MVP delivered with real Predict API, Guardian, PTB preview, and keeper demo: 22% to 32% for any DeepBook prize.
- Same MVP plus real testnet mint/redeem tx digest and polished video: 30% to 40% for any DeepBook prize.
- First place probability with polished real tx demo: 7% to 12%.

My final probability call:

> If the team ships the scoped MVP exactly as above, the realistic award probability is about 28%; if it also shows real mint/redeem and keeper tx digests, it can rise to about 35%.

## 14. Final Recommendation

Build DeepPilot RiskOps, not a broad DeepPilot AI terminal.

The most important engineering choice is to turn every market field into a deterministic, documented risk decision. The strongest winning path is:

1. Real Predict API and testnet object integration.
2. Guardian risk policy tied to official oracle/vault semantics.
3. PTB preview and execution receipt.
4. Settled-Redeem Keeper.
5. Audit trail and replayable demo.

Everything else is secondary. A small, real, reproducible Predict cockpit beats a large, speculative AI/vault/arb concept.

## References

[1] Sui Overflow 2026 official page: https://overflow.sui.io/  
[2] DeepBook Predict docs: https://docs.sui.io/onchain-finance/deepbook-predict/  
[3] DeepBook Predict Contract Information: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information  
[4] DeepBook Predict Design: https://docs.sui.io/onchain-finance/deepbook-predict/design  
[5] Predict contract docs: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict  
[6] Oracle contract docs: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle  
[7] Vault contract docs: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault  
[8] Sui Programmable Transaction Blocks: https://docs.sui.io/develop/transactions/ptbs/prog-txn-blocks  
[9] Sui Sponsored Transactions: https://docs.sui.io/develop/transaction-payment/sponsor-txn  
[10] Introducing DeepBook Predict, Sui Blog, 2026-05-05: https://blog.sui.io/introducing-deepbook-predict/  
[11] DeepBookV3 docs: https://docs.sui.io/onchain-finance/deepbookv3/deepbook  
[12] DeepBook Margin docs: https://docs.sui.io/onchain-finance/deepbook-margin

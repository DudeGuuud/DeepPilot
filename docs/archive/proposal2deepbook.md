# DeepPilot · DeepBook Predict 黑客松提案（DeepBook 赛道）

## 1. 项目名称
**DeepPilot - DeepBook Predict 执行与分析助手（MVP）**

## 2. 参赛赛道与报名方向
- 赛道：**DeepBook（DeepBook Predict Problem Statement）**
- 题目匹配：构建面向预测市场的可执行产品/工具，优先做交易、风控、分析与链上动作闭环
- 与题目要求对应关系：
  - 覆盖功能型应用：命令式预测交易入口（市场选择/执行意图提炼/交易参数生成）
  - 覆盖工具型应用：可观测性与执行风控面板（引用深度、波动率、执行后验）
  - 预留链上交互闭环：PTB 构建、签名、提交（含后续部署扩展）

## 3. 现有定位与问题定义
### 现状痛点
1. 深度与事件市场链上构建门槛高：开发者/用户要在 DeepBook Predict、PLP、oracle 与钱包交互间切换，路径复杂。
2. 预测市场交易对新手不友好：缺少“意图到下单”的统一入口，交易参数（标的、方向、strike/到期）难以快速落地。
3. 风险与结算过程透明度不足：
   - 价格/流动性/滑点状态不直观
   - 结算和赎回动作依赖用户自行触发
4. 赛题偏向可组合金融创新，但缺少“低门槛、可复用、可展示”的原型。

### 本项目要解决什么
把复杂的 DeepBook Predict 交易、资金/风控状态、执行动作，压缩为**自然语言驱动的“可预测市场执行工作台 + 自动化执行组件”**：用户输入场景化需求，系统生成可执行策略并形成 PTB，既能跑“基础交易流程”，也能展示 DeFi 可组合价值（与 PLP/清算相关的扩展面）。

## 4. 核心产品形态
### 4.1 用户侧（MVP）
- 一个 DeepPilot Web Terminal（基于现有前端）
  - 输入：市场 / 意图（比如“我想买 BTC 15 分钟看涨的 70k/涨跌二元头寸”）
  - 输出：
    - 预测市场报价（mid、spread、深度）
    - 风险检查（滑点、交易规模、市场陈旧度）
    - PTB 预览与执行参数
    - 交易执行、签名、（在环境允许时）提交与结果反馈

### 4.2 自动化工具侧（可选增强）
- 结算/赎回提醒：检测可赎回事件触发。
- 风险仪表板：基于 market/depth/guardian 结果显示仓位可行性。

### 4.3 我们为什么不是“普通 Agentic Web”
- 普通 Agentic Web 常见的是“自然语言输入 -> UI/链上动作模板”；
- DeepPilot 的目标是“交易决策系统”：
  - 从市场数据 + oracle + 深度中计算交易可执行性；
  - 通过 guardian 形成可解释风控结论；
  - 生成可追踪 PTB，并提供执行结果与结算/赎回生命周期。
- 也就是说，它是 **DeepBook Predict 原生执行基础设施**，不是泛聊天式交易前端。

## 5. 技术方案
### 5.1 架构
- 前端：Next.js + React（已存在代码基础）
- 后端服务：API 路由（compile / sponsor / deepbook quote）
- 链上集成：
  - DeepBook Spot + DeepBook Predict（按题目要求使用 `predict-testnet-4-16` 分支联调）
  - 预测资产：dUSDC（测试网）
- 风控层：Guardian 规则引擎（滑点、深度、过期时效）
- 数据层：可使用 `predict-server.testnet.mystenlabs.com` 或自建 indexer 轻量代理

### 5.2 数据与执行路径
1. 用户提交意图（自然语言或结构化参数）
2. 解析意图为 Predict 交易意图
3. 获取市场与报价（非 mock）：
   - 当前价差/深度
   - 相关时效信息（oracle 更新、expiry）
4. 风控通过后生成 PTB：
   - market/limit/模拟资金转移（用于演示）
5. 返回给用户：
   - 执行计划
   - 风险结论
   - 交易/签名状态

### 5.3 赛道关键加值模块（将“能下单”变成“能生产价值”）
#### A. 市场指标服务（raw data -> 决策信号）
- 我们会从链上/预测索引器提取原始数据并计算统一指标：
  - `mid`：中间价，作为下单基准
  - `spread`：买卖价差（摩擦成本）
  - `liquidity`：前若干档流动性聚合值，判断可承受仓位规模
  - `oracleAge`：预言机更新时间与当前时间差
- 作用不是“展示数字”，而是服务风控：
  - 自动给出可执行/限额/拒绝决策
  - 输出明确失败原因（如 oracle 超过阈值、流动性不足）

#### B. Settled-Redeem Keeper（赛题友好加分项）
- 功能：监听市场结算事件，扫描已到期但未赎回仓位。
- 模式：
  - 提示模式：在 UI/消息内提示“你有可赎回仓位”
  - 代执行模式：在授权前提下调用 `predict::redeem_permissionless` 代领收益并分账
- 价值：
  - 解决闲置资金与“忘记赎回”问题
  - 体现产品生命周期服务能力，不是一次性交易入口

#### C. Predict Surface/风险看板（简化可落地）
- 显示项：
  - market / expiry / strike / mid / spread / liquidity / oracleAge
  - 异常告警（报价异常、oracle 过期、滑点过高）
- 输出：
  - 每笔交易给出可行性等级（绿/黄/红）
  - 给出拦截原因与建议替代操作
- 说明：不做复杂 3D，首版以可读表格+告警条为核心。

#### D. Vol-Arb Bot 最小版（单市场偏离告警）
- 核心逻辑：监听预测市场内一组波动率指标，检测“模型隐含值与实时价格偏离”。
- 达到阈值触发：
  - 界面告警
  - 日志事件 + 可配置冷却时间
- 价值：先把监听、触发、可配置策略链路打通；后续再扩展到自动下单或跨市场套利。

## 6. 与 DeepBook Predict 题目对齐说明
- 题目要求“Build functional applications, services, vaults, bots, or analytics”：
  - 本项目是 **functional app + execution service + analytics-lite 风控面板**。
- 题目最小要求：
  - “Integrate deepbook predict contract on testnet”：计划接入 DeepBook Predict。
  - “Work end to end if building product”：从意图 → 报价 → PTB → 签名/提交（可验证闭环）。
  - “Proper simulation result for vault strategy”：在当前阶段提交“交易策略模拟/风险推演”组件，后续迭代加入 Vault PoC（range/hedge 风格）。

## 7. MVP（本轮最小可交付）
### 范围边界（优先实现）
1. DeepBook Predict 报价真实接入（替换 mock）
2. 意图解析支持 DeepBook Predict 基础动作（market/mint 与基本风控）
3. PTB 生成与执行预览链路完整可视化
4. 事件/市场详情页：到期时间、IV/深度、spread、滑点阈值
5. 交易记录与错误码可追踪输出
6. 指标服务上链前置：`mid / spread / liquidity / oracleAge` 每笔请求返回
7. Settled-Redeem Keeper 最小实现：未赎回提示 + 可选一键代领
8. 风险看板 MVP：异常告警与交易可行性分级
9. Vol-Arb Bot 最小版：单市场偏离告警脚本（不直接开交易）

### 评分加分项
- 可复现：固定测试场景与指令模板
- 可解释：每一步给出风险与边界说明（为何可下单/为何拦截）
- 可继续扩展：为 Vault/Bot/keeper 预留统一接口
- 可量化评估：新增关键指标（见下文）支撑演示输出

## 8. 关键指标（评委可读）
- 报价链路
  - 中位数 quote 延迟：< 2s
  - 失败重试恢复率：> 95%
- 风控与交易质量
  - oracleAge 拦截覆盖率：对过期预言机数据 100% 拦截
  - 过高滑点拦截命中率：对低流动性场景高覆盖（目标 > 80%）
  - 失败原因可读率：100%（每个失败可解释）
- 执行与生命周期服务
  - 从意图提交到 PTB 生成：< 60s
  - keeper 扫描周期：< 30s
  - 未赎回提醒命中率：基于测试仓位核验
- 用户层指标
  - 演示流程可重放率：1 分钟内复现成功
  - “可执行”与“拒绝”决策一致率：与 guardian 规则一致且可复核

## 9. 里程碑（按当前时间切片）
> 参考：当前日期 2026-06-11，截稿日 2026-06-21

### Day 1-2（6/11-6/13）
- 重新梳理 API 与交易意图类型，接入真实 DeepBook Predict 报价源
- 完成市场展示字段对齐（expiry、strike、oracle timestamp）

### Day 3-4（6/14-6/16）
- 完善 PTB compile 产物与 guardian 风控展示
- 加入失败回退/错误码说明
- 接入指标服务与风险看板

### Day 5-6（6/17-6/19）
- 实现 sponsor 提交可选路径（本地演示 + 联测试网）
- 上线 Settled-Redeem Keeper 最小监听 + Vol-Arb 告警脚本
- 提供 demo script：1 个典型预测市场买入/卖出/查询场景

### Day 7（6/20-6/21）
- 演示视频 + 文案 + 讲解页更新
- 最终提交流程走查与日志打磨

## 10. 风险与缓解
- 题目链路变更：坚持锁定 `predict-testnet-4-16` 与题目声明接口，预留兼容层。
- 网络/索引器不稳定：加入重试与回退策略（报价失败时显示重试理由与时间戳）。
- 风控误判：将 guardian 规则参数化，支持提交前可视化边界调整。
- 执行闭环不稳定：核心演示先做“端到端可复现流程演示版”，提交时清晰标注线上/测试环境。

## 11. 预期成果（可直接录入比赛说明）
- 一个可运行的 DeepBook Predict AI 助手 Demo：从自然语言到可执行交易计划
- 可视化风险控制面板与交易决策过程
- 可复现的提交演示视频与脚本（至少一条 BTC/USDC 周期交易路径）
- 兼容 DeepBook生态的扩展设计：后续可扩展为 vault/bot/keeper

## 12. 商业与生态价值
- 降低预测市场交易门槛：用户与开发者都能在统一工作流里完成从发现市场到下单到风险评估。
- 强化可组合性：交易执行与 DeFi 风险控制统一抽象，利于后续接入 margin / vault 生态。
- 为 DeepBook Predict 提供“可解释执行”入口，提升用户和 LP/机构的使用信心。

## 13. 公开展示与演示要点
1. 用一句话说明：我在解决“DeepBook Predict 不好下单/不好理解”的真实问题
2. 演示流程：
   - 选择预测市场
   - 输入交易意图
   - 展示报价+风险
   - 点击执行生成 PTB
   - 显示签名和交易结果
3. 显示附加价值：失败路径说明（quote 过旧、滑点过高）与保护行为
4. 讲清下一步：从工具走向 vault / keeper / analytics。

## 14. 项目当前可改造项（与现有仓库对齐）
- `src/lib/deepbook.ts`：将 mock 报价替换为真实 DeepBook Predict 数据源
- `src/lib/intent.ts`：添加 Predict 专用 action 与参数字段（事件 ID / 到期 / 方向 / strike / 数量）
- `src/lib/ptb.ts` + `app/api/sponsor/route.ts`：补齐更完整执行闭环与状态反馈
- `components/deep-pilot-terminal.tsx`：新增 DeepBook Predict 面板与 execution trace
- `src/lib/guardian.ts`：加入 `oracleAge / liquidity / spread` 风险规则与可解释拒绝原因
- `src/lib/intent.ts`：新增 keeper/redeem/arb 相关意图类型（为服务化入口）
- `components/deep-pilot-terminal.tsx`：增加交易可执行性分级面板和未赎回提醒面板
- `proposal.md`：更新为本提案版本，统一名称与目标口径

## 15. 你刚才问的重点：这三个“buff”分别在做什么
先回答你一个核心误解：我们不是只“调用 DeepBook 预测市场 API 下单”。交易 API 只是动作入口，核心竞争力在于“能否判断当下价格是否值得下单、是否可执行、是否该提醒你下一步动作”。

### 1）Settled-Redeem Keeper 的意义
- 目标：补齐 DeepBook Predict 的生命周期体验，不让仓位闲置“过期不赎回”。
- 做法：
  - 监听 `OracleSettled`、`PositionMinted`、`PositionRedeemed` 等事件
  - 对比 manager 下持仓状态，发现可赎回但未赎回的仓位
  - UI 提醒用户并提供一键代领（`redeem_permissionless`）或确认执行
- 价值：不是新交易能力，而是“交易后动作闭环”，可以明显提升可用性和可信度。

### 2）Predict Surface / 风险看板的价值
- 目标：把“raw market data”变成可执行判断，而不是只展示数字。
- 这个面板至少要覆盖：
  - `mid`（中间价）
  - `spread`（买卖价差）
  - `liquidity`（可承接深度）
  - `oracleAge`（预言机年龄）
- 触发规则与异常提醒：
  - spread 超阈值或流动性过低 → 建议降额/暂停执行
  - oracleAge 过旧 → 拒绝执行并展示原因
  - 关键字段突变 → 警报提示
- 价值：每次交易提交都能给出“为什么能下/为什么不下单”的解释，直接对应 guardian 与 demo 中的风控可视化。

### 3）Vol-Arb Bot（最小版）怎么用
- 目标：先把“监控-信号-告警”链路打通，不必一上来就做跨市场自动交易。
- 最小版本实现：
  - 单市场监听 `OracleSVI` 或相关价格事件
  - 计算简化偏离值（例如实时 mid 与内部风险模型指标偏离）
  - 达阈值只输出告警（列表、日志、可选 webhook）
- 价值：这是可以持续扩展的产品化模块，比赛阶段能体现你们有“分析/交易工具能力”，不局限于前端交互。

### 这几个指标为什么“必须写一个函数”有意义？
- 因为它们是 risk policy 的输入参数，不是为了展示炫技。
- 在本提案里它们承担三件事：
  - 决定是否允许执行（execute / reject）
  - 决定执行量级（slippage 与仓位上限）
  - 决定失败可解释性（给出统一可读拒绝原因）
- 这也是评委最看重的点：你不是“拼 prompt”，而是在做一个有执行语义的交易决策组件。

### 16. 你如果想再往上加一层“buff”，建议优先加这几项
如果担心“看起来像普通 Agentic Web”，建议在 1-2 周内把以下项做成“可演示亮点”，会明显更像工程化竞赛作品：

1. 执行路径可稽核性（最容易加分）
- 每一步输出可核对工件：
  - 市场快照哈希、行情拉取时间、PTB hash、签名摘要、交易 digest/回执码
- 这样可以回答“这次建议为什么做、有没有按规则执行、结果怎么复现”，对评委很关键。
- 评审感知：不是纯 UI 交互，而是有可验证链上行为链。

2. 数据鲜度/延迟告警（你现在做的 oracleAge 可以延展）
- 增加“指数器可视化熔断机制”：如果预测器状态超时、深度长时间无变化、状态滞后，直接给出 warning 或 reject。
- 这个模块能和 keeper 形成呼应：一个是“别交易”，一个是“及时结算提醒”。

3. Keeper 收益闭环（PRIME 价值点）
- 除了提醒 UI，给出“代领后预期收益变化”展示。
- 同时把 `executor`、代领时间、调用参数记录成 Keeper 日志。
- 即便你不自动代领，也能在 demo 里展示一键代领路径和失败回退（没有授权/余额不足/重复赎回）处理。

4. 风险看板可解释策略
- 从“指标值”升级为“动作建议”：
  - Mid/Spread/Liquidity/OracleAge 不只显示，必须返回 `ALLOW / REDUCE / BLOCK`。
- 建议加入 3 级降级：
  - 绿：可执行（附建议仓位）
  - 黄：可执行但降额（附限价/分批建议）
  - 红：禁止（附明确阻断原因）

5. Vol-Arb Bot 的“最小自动化”版本
- 先别上自动下单，先加到可执行提醒层：
  - 告警->确认脚本->一键点击生成示例 PTB（确认后才下单）
- 同时给出“偏离来源解释”：是盘口异常、还是 oracle 偏离、还是近期事件导致。
- 这样能展示分析能力 + 控制风险能力，和你们当前 AI 交易闭环不是重复功能。

6. 一条可复现的演示脚本（很重要）
- 固定市场 + 固定输入文本 + 固定钱包地址：
  - 进入市场
  - 生成报价
  - mid/spread/LIQ/OracleAge 显示
  - 触发黄/红策略
  - 跑一次 keeper 提醒
  -（可选）跑一次 vol-arb 告警
- 竞赛评委通常更偏好“可重复跑、可核对、可解释”的完整链路。

### 16.1 把你这三项放回“不是纯 Agentic Web”这个叙事
- Settled-Redeem Keeper = 生命周期服务能力（交易后自动化）  
- Predict Surface 风险看板 = 决策引擎可解释性（不是只是显示数据）  
- Vol-Arb Bot 最小版 = 分析与监控能力（不是只做交易入口）  
这三项拼起来就是：**入口 + 风控 + 后处理闭环**，比单纯“把深度学习模型接到钱包”更像一个真正可用的交易系统。

## 17. 这三项再加一层“可验证实现性说明”（给评委看的技术依据）
### 17.1 数据源与指标算子的可行性
- `mid` / `spread`：来自 orderbook 的 bid/ask（可用公共指数服务 `/orderbook/:pool_name` 获取 depth）实时计算，不依赖第三方封闭 API。
- `liquidity`：可按深度前 N 档或按金额区间聚合计算，来自同一套 orderbook。
- `oracleAge`：来自 oracle state 的 `onchain_timestamp` / 最新更新时间，与当前时间差值计算，可直接用于 staleness 策略。
- `vault 风险值`：vault summary（如 `total_mtm`、`total_max_payout`、`vault_balance`）都可从 predict-server 相关 endpoint 查询，直接构造 utilization 风险。

### 17.2 Settled-Redeem Keeper 的直接实现链路
- 合约层有明确可调用/监听信号：
  - 结算事件：`OracleSettled`
  - 持仓与赎回事件：`PositionMinted`、`PositionRedeemed`、`RangeRedeemed`
  - 无权限代领入口：`redeem_permissionless`
- 实现步骤可直接落地：
  - 周期性监听事件与 onchain 状态
  - 识别 `expired && not redeemed` 的仓位
  - 通知/按钮化代领（含失败原因）  
- 这条路径正好对齐“PRIME 加分项”的链上生命周期增强价值。

### 17.3 风险看板（Predict Surface）最小版闭环
- 最小目标不是做复杂图表，而是把每笔动作转换成 `ALLOW / REDUCE / BLOCK`。
- 规则输入：  
  - `oracleAge > 阈值`：阻断并给出“预言机过期”原因  
  - `spread > 阈值` 或 `liquidity < 阈值`：触发降额  
  - `status/lag` 异常：提示可疑行情
- 输出最少包含：面板字段、触发规则编号、建议操作（改小金额/改参数/等待）。

### 17.4 Vol-Arb 单市场最小版为何够“有价值”
- 当前阶段不需要全链跨市场做下单，只做：
  - 单市场模型指标与实时报价偏离监控
  - 告警事件与冷却抑制（防抖）
  - 点击可复制的示例 PTB（确认后才执行）  
- 评委看到的是“监控->告警->可控动作”的分析能力闭环，而不是单点交易器。

### 17.5 对 proposal 的建议落点（实操优先级）
1. 先把基础功能链完整：报价源接入 + 风控面板 + PTB + 失败原因可解释
2. 叠加 keeper：未赎回提醒 + 一键代领演示
3. 引入 oracleAge/lag 告警规则到风险面板（这几乎零成本、可显著加分）
4. 再加 vol-arb 告警脚本，作为“分析能力边界”的加值展示

## 18. 你问的关键问题（给评委也给开发团队看的统一说法）
### 18.1 这不是“只调用 API 下单”，而是做“交易决策系统”
核心区别是：`mid / spread / liquidity / oracleAge` 不是展示字段，而是每次 `allow/reject/reduce` 决策必须的输入。  
如果没有这四类函数，系统只能“能下单”，但做不到“知道为什么该下单”和“知道什么时候不能下单”。

你可以这样描述：
- `mid`：决定交易报价基准（是否有明显逆价空间）
- `spread`：决定摩擦成本（是否值得当前方向与仓位）
- `liquidity`：决定能否吃掉目标额度（防止滑点灾难）
- `oracleAge`：决定数据是否过期（防止用陈旧价格做交易）

### 18.2 这三项 buff 的具体作用
- **Settled-Redeem Keeper**
  - 去做什么：监听 `OracleSettled` 后扫描可赎回仓位，提醒用户，支持代领（`redeem_permissionless`）。
  - 直接价值：弥补交易后的“生命周期空白”，体现你的项目不是一次性工具，而是有后续资产处理能力。
  - 技术可行性：事件可观察，合约里存在无权限代领入口，最小版可做“提醒 + 一键触发”。

- **Predict Surface / 风险看板**
  - 去做什么：把市场原始数据转成 `ALLOW / REDUCE / BLOCK` 三档动作建议，而不是纯粹看板。
  - 直接价值：让 demo 能解释“为什么这笔交易成功/失败/降额”，明显比只展示数值更有说服力。
  - 技术可行性：指标与事件都可从官方公开接口与 chain state 获得；部分值（如中间价）来自 orderbook 及可计算定义。

- **Vol-Arb Bot（单市场最小版）**
  - 去做什么：最小化做成“监控 + 偏离检测 + 告警 + 可选手动确认 PTB 演示”。
  - 直接价值：展示 analytics / bot 维度，不与纯交易执行重复，给作品叠加第二条闭环。
  - 技术可行性：先做偏离阈值告警即可，不一定接入自动交易，降低风险和时间压力。

### 18.3 结论：加分路径建议（按实现成本）
1. 零风险加分：oracleAge + lag 告警接入风控面板  
2. 低成本加分：Settled-Redeem Keeper（提醒 + 代领入口）  
3. 中等成本加分：Vol-Arb 单市场告警 + 冷却防抖

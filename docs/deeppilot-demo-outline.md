# DeepPilot Demo Outline

> Audience: Sui Overflow 2026 judges and DeepBook track reviewers  
> Demo positioning: safer natural-language prediction-market trading on DeepBook Predict

## Official Track Alignment

Sui Overflow 2026 positions the hackathon around building real applications on Sui, including AI agents, financial rails, and tools that make developers and users faster. The official DeepBook specialized track asks teams to build trading or liquidity applications powered by DeepBook's on-chain orderbook, and the public prize page lists a dedicated DeepBook prize pool.

DeepPilot is built to fit that direction: it is not a generic chatbot and not an off-chain trading simulator. It is a Sui-native execution cockpit that uses DeepBook Predict, Sui programmable transaction blocks, wallet signing, Profile NFTs, Telegram handoff, and optional Walrus Memory to make prediction-market trading understandable and reviewable for new users.

Useful official references:

- Sui Overflow 2026: https://overflow.sui.io/
- DeepBookV3 overview: https://docs.sui.io/onchain-finance/deepbookv3/deepbook
- DeepBook Predict overview: https://docs.sui.io/onchain-finance/deepbook-predict/
- DeepBook Predict design: https://docs.sui.io/onchain-finance/deepbook-predict/design
- DeepBook Predict contract information: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information
- Walrus Memory: https://walrus.xyz/products/walrus-memory/

## One-Sentence Pitch

DeepPilot turns market questions and plain-language trade intent into a reviewed DeepBook Predict transaction, so users can understand the market, inspect the quote and safety checks, and sign only when they are ready.

## 1. User Pain Point

Prediction markets are powerful, but the on-chain user experience is difficult for normal users:

- Users do not know which market or expiry is active.
- They do not understand oracle lifecycle, quote freshness, manager balances, gas, vault exposure, or settlement.
- News and market context are separated from the trading interface.
- Wallet popups often appear before users understand what they are signing.
- Telegram and mobile users want a simple chat entry point, but transaction signing still needs a safe wallet review.

The result is that a new user must understand too many protocol details before making a small prediction-market trade.

## 2. Why DeepPilot Exists

DeepPilot exists to make prediction-market trading safer and easier without removing user control.

The core idea is:

```text
Ask AI -> Understand market context -> Draft trade -> Review checks -> Sign with wallet -> Track position
```

DeepPilot helps users do three things:

1. Ask questions about BTC markets, news, and protocol risk.
2. Convert a clear natural-language trade or strategy request into a DeepBook Predict review.
3. Sign only after the app has shown the outcome, amount, expiry, quote, Guardian checks, Trading Balance, and transaction preview.

The important boundary is that DeepPilot does not present itself as an automatic trading bot. It creates a reviewed transaction draft; the user makes the final decision and signs with their own wallet.

## 3. What DeepPilot Can Do

### Web Cockpit

- Shows live DeepBook Predict market and oracle context.
- Lets the user ask market questions in natural language.
- Detects whether the user is asking for market context, a single trade, or a multi-leg strategy.
- Generates a Review & Sign modal before wallet signing.
- Keeps the trade flow explicit: no direct jump from chat input to wallet popup.

### Trade Review

- Resolves active DeepBook Predict markets and nearest safe expiry.
- Quotes the expected Predict outcome using live protocol data.
- Shows estimated payment, max payout, and result direction.
- Runs Guardian checks for market state, oracle status, expiry window, vault risk, and funding readiness.
- Builds a Sui PTB review with the target Move calls and objects.
- Requires the user to sign through the wallet.

### Strategy Review

- Turns requests such as "build a 1 DUSDC hedge strategy mostly BTC UP" into a candidate multi-leg plan.
- Compiles each leg independently.
- Shows estimated payment, max payout, Guardian status, and aggregate Trading Balance check.
- Supports batch review for selected ready legs.

### Profile And Portfolio

- Helps users create and connect a PredictManager.
- Lets users deposit and withdraw DUSDC Trading Balance.
- Shows positions in a prediction-market style: outcome, stake, current value or payout, P/L, and result.
- Supports settlement into Trading Balance when positions become ready.

### Telegram Entry

- Users can start from Telegram with commands or natural language.
- The bot can show markets, summarize BTC news, generate trade review links, and generate strategy review links.
- Signing still happens on Web through the wallet, keeping custody and signing under the user's control.

### Plan And Quota Model

- DeepPilot includes a Profile NFT and plan model.
- Standard, Pro, and Max plans define usage tiers.
- The demo uses a simple daily quota path and shows how paid plans can become the revenue model.
- Pro and Max can be presented as subscription tiers for higher daily AI/strategy usage and advanced review workflows.

## 4. Sui Blockchain Integration

DeepPilot is deeply connected to Sui rather than only using Sui as a login layer.

### DeepBook Predict

DeepPilot reads DeepBook Predict market, oracle, vault, manager, and portfolio data. It follows the official integration model: use indexed Predict server data for rendering, then use direct on-chain confirmation before wallet-sensitive flows.

Core protocol objects used in the demo:

- `Predict`: shared protocol object for minting, settlement, vault, and manager operations.
- `PredictManager`: user-specific manager for quote balances and positions.
- `OracleSVI`: oracle lifecycle, spot, forward, strike, expiry, and settlement state.
- `Vault`: shared liquidity and risk surface.
- DUSDC: quote asset used for Predict trades.

### Sui PTB

DeepPilot builds Sui programmable transaction blocks for:

- Creating a PredictManager.
- Funding Trading Balance.
- Minting binary Predict positions.
- Batch minting selected strategy legs.
- Settling eligible positions into Trading Balance.
- Updating the Profile NFT memory pointer.

The review screen shows the transaction before the wallet prompt, so the user can inspect what will be signed.

### Move Profile NFT

DeepPilot includes a Move profile module that stores:

- User plan.
- Profile ownership.
- Telegram binding hash.
- Quota policy fields.
- Walrus Memory pointer fields.

This gives the project a Sui-native identity and subscription surface while keeping transaction signing user-controlled.

### Telegram Handoff

Telegram creates a signed review seed. The Web app opens the review link, decodes the seed, and recompiles current market data before signing. This avoids signing stale Telegram data.

### Walrus Memory

DeepPilot uses Walrus Memory as an optional long-term context layer:

- Profile NFT stores the memory pointer and namespace.
- The app writes only compressed memory summaries, such as last market thesis or last trade shape.
- Telegram can use that context to understand follow-up prompts like "same as last time".
- Trading permission is never delegated to memory. Wallet signing remains required.

## 5. Demo Narrative

### Scene 1: Start With A New User Problem

Open the landing page or `/trade`.

Say:

> Prediction markets are still too protocol-heavy for new users. DeepPilot lets a user ask questions first, then turns clear intent into a transaction review instead of jumping straight to a wallet popup.

### Scene 2: Ask Market Context

Prompt:

```text
What is moving BTC today?
```

Show:

- AI answer with market/news context.
- Sources or compact references.
- No wallet button, because this is information mode.

Message:

> DeepPilot separates market explanation from trading execution. Asking a question does not create a transaction.

### Scene 3: Generate A Single Trade Review

Prompt:

```text
Bet 1 DUSDC on BTC DOWN nearest settlement
```

Show:

- Intent parsing.
- Active market resolution.
- Quote preview.
- Guardian checks.
- Review & Sign modal.

Message:

> The user sees the outcome, amount, expiry, quote, funding readiness, and transaction preview before the wallet opens.

### Scene 4: Sign A Real Sui Transaction

Click Review & Sign.

Show:

- Wallet signing.
- Transaction digest.
- Receipt.
- Position appears in Profile.

Message:

> This is a real Sui wallet flow using DeepBook Predict objects and PTB execution.

### Scene 5: Strategy Candidate

Prompt:

```text
Build a 1 DUSDC hedge strategy mostly BTC UP near settlement
```

Show:

- Strategy review.
- Multiple selected legs.
- Aggregate payment and Trading Balance check.
- Batch review path.

Message:

> For more advanced users, DeepPilot can generate a candidate strategy, but every leg still goes through quote, Guardian, funding, and wallet review.

### Scene 6: Telegram Flow

Open Telegram bot.

Show:

- `/start` onboarding.
- `/markets`
- `/news BTC`
- `/trade Bet 1 DUSDC on BTC DOWN nearest settlement`
- Web Review link.

Message:

> Telegram is the discovery and intent layer. Web wallet review remains the signing layer.

### Scene 7: Profile And Business Model

Open `/profile`.

Show:

- Trading Balance.
- Positions and P/L.
- Profile NFT status.
- Plan cards: Standard, Pro, Max.

Message:

> DeepPilot can monetize through subscription plans. Pro and Max unlock higher usage limits and advanced AI review workflows, while trading custody remains with the user.

## 6. Technical Architecture

```text
Web / Telegram
    |
    v
Pilot Router
    |-- chat mode -> RAG/news/Predict context
    |-- trade mode -> typed Predict intent
    |-- strategy mode -> multi-leg plan
    |
    v
DeepBook Predict data
    |-- public Predict server for render-ready state
    |-- direct on-chain reads for signing-sensitive checks
    |
    v
Guardian + Quote + Funding Readiness
    |
    v
PTB Review
    |
    v
User wallet signature
    |
    v
Profile / receipt / portfolio update
```

Key implementation points:

- LLM output is treated as untrusted input and converted into typed intent.
- DeepBook Predict market state is refreshed before signing.
- Funding checks ensure the PredictManager Trading Balance can cover the trade.
- Wallet signing is always explicit.
- Telegram review links are signed seeds, not pre-signed transactions.
- Walrus Memory stores context, not trading authority.

## 7. Business Model

DeepPilot can monetize as a SaaS-style agent layer for on-chain prediction markets.

Plans:

- Standard: default free plan for casual users.
- Pro: higher daily AI and strategy quota.
- Max: highest quota and advanced strategy workflows.

Revenue path:

- Monthly plan subscription paid in SUI.
- Higher quota for market questions, news summaries, trade reviews, and strategy generation.
- Future premium features can include advanced strategy templates, portfolio analytics, keeper automation, and team dashboards.

The important commercial point is that DeepPilot sells the review and intelligence layer, not custody. Users keep wallet control, assets stay in Sui objects, and DeepPilot earns through plan access.

## 8. Technical Roadmap

Near-term:

- Expand active market coverage beyond BTC.
- Improve strategy templates and user-editable legs.
- Add more portfolio analytics and settlement guidance.
- Strengthen Walrus Memory opt-in and revoke UX.

Mid-term:

- Add richer risk scoring for vault utilization and settlement windows.
- Support more DeepBook Predict position types when quote semantics are stable.
- Add team/admin views for plan and quota management.
- Add production-grade observability for Telegram and review flows.

Long-term:

- Turn DeepPilot into a general Sui-native transaction review layer for prediction markets and other financial protocols.
- Build a portable, user-controlled memory and risk profile across Web, Telegram, and future Sui apps.
- Integrate more Sui-native primitives while keeping the same core safety rule: review before signing.

## 9. Demo Guardrails

Use this wording:

- "AI-assisted review"
- "candidate strategy"
- "user-controlled signing"
- "DeepBook Predict integration"
- "fresh review before wallet signing"
- "Profile NFT and Walrus Memory pointer"

Avoid this wording:

- "AI trades automatically"
- "guaranteed profit"
- "risk-free"
- "fully autonomous execution"
- "server signs for the user"
- "Walrus Memory gives trading permission"

If asked about limitations, answer at a product-roadmap level:

> The demo focuses on the safest high-value path: BTC Predict market review, wallet-signed execution, Telegram handoff, Profile portfolio, and optional memory. The architecture is designed to expand to more assets, richer strategies, and deeper automation while preserving review-before-signing.


# DeepPilot

[中文说明](./README.zh-CN.md)

DeepPilot is an AI-assisted review layer for safer natural-language prediction-market trading on DeepBook Predict. A user can ask about BTC markets and news, turn a plain-language sentence such as "Bet 1 DUSDC that BTC will be down at the nearest settlement" into a trade draft, review the quote and safety checks, and only then decide whether to sign with a wallet.

It is built first for people who are new to prediction markets and on-chain wallets. DeepPilot does not ask users to understand Predict objects, oracle windows, quote freshness, Trading Balance, market keys, or gas rules upfront. It translates those protocol details into a readable review before any wallet prompt appears.

## Why DeepPilot Exists

Prediction markets are powerful, but the first trade is hard. A new user usually wants to ask simple questions first:

- What is moving BTC today?
- What news or market risks should I understand?
- What would a BTC UP or BTC DOWN position actually mean?

Before signing, the same user also has to answer protocol-specific questions:

- Which BTC prediction market is active now?
- Which expiry should I use?
- Is the oracle fresh, or is the market already stale?
- How much DUSDC will the position cost?
- Is there enough Trading Balance in the PredictManager?
- Will the wallet be on the right Sui network with enough gas?
- Is this a single trade, a redeem action, or a multi-leg strategy?

DeepPilot was created to remove that operational burden without removing user control. The user can start with natural language in Web or Telegram. DeepPilot answers market questions, summarizes context, converts clear trade intent into a constrained Predict review, refreshes live market data, runs deterministic safety checks, and only then opens a wallet signing path.

## What It Solves

DeepPilot solves three practical problems:

- Onboarding friction: users can ask AI about BTC markets and draft trades in natural language instead of manually assembling oracle ids, expiries, market keys, and transaction details.
- Pre-sign clarity: every trade or strategy is presented as a review with outcome, amount, expiry, quote estimate, Guardian decision, Trading Balance, wallet network, and gas readiness.
- Cross-channel handoff: a user can begin in Telegram, receive a Web Review link, and continue in the Web app where quote and safety checks are refreshed before wallet confirmation.

## What Users Can Do

- Ask market questions in `/trade`; DeepPilot can answer with retrieved Predict, news, and project context instead of forcing every message into a transaction.
- Discover live BTC Predict markets in `/markets`, with expiry filters, quick risk labels, vault context, and chart history.
- Place single-trade intents in plain language, for example: `Bet 1 DUSDC on BTC DOWN at the nearest settlement`.
- Draft multi-leg strategies in plain language, for example: `Build a 1 DUSDC hedge strategy mostly BTC UP at the nearest settlement`.
- Review Guardian results before signing: `allow`, `reduce`, or `block`, with the reason shown in plain language.
- Create or link a PredictManager, check Trading Balance, and sign wallet transactions for supported execution flows.
- Use Telegram commands such as `/login`, `/markets`, `/news BTC`, `/trade ...`, and `/strategy ...` to start from chat and finish in Web review.
- Track local receipts, manager state, Trading Balance, positions, PnL, settlement status, and redeem/funding actions in `/profile`.

## User Benefit

For a first-time prediction-market user, DeepPilot changes the experience from "learn the protocol first" to "ask a question, understand the context, then review the generated trade draft." The user still makes the trading decision and still controls the wallet signature, but the confusing parts of the protocol are surfaced as readable checks.

For a more experienced user, DeepPilot reduces repeated operational work: market discovery, quote refresh, strategy leg construction, wallet preflight, and receipt tracking are all placed in one workflow.

## Current Product Scope

| Area | Implemented | Boundary |
| --- | --- | --- |
| Market discovery | Live BTC DeepBook Predict markets, expiry filters, chart/history, page-scoped risk labels | It does not expose a traditional CLOB order book. |
| Natural-language trade | Web and Telegram input routed into `chat`, `trade`, or `strategy` modes | AI output is validated and may fall back to deterministic parsing. It is never treated as direct execution. |
| Trade review | Live Predict snapshot, Guardian result, quote preview, PTB preview, funding checks | Quote-only intents do not build a transaction. Quote views are estimates, not guaranteed profit. |
| Strategy review | Deterministic multi-leg strategy plan, per-leg compile, aggregate funding check, batch transaction preview | Strategy output is a candidate plan, not investment advice. |
| Wallet execution | Create PredictManager, single binary mint, and selected strategy batch mint through the user's wallet | Wallet signing is user-controlled. |
| Sponsor endpoint | Challenge + wallet authorization + server-side recompile + policy preview receipt | `/api/sponsor` is preview-only. It returns `submitted: false` and does not do dual-sign sponsor submission. |
| Telegram handoff | Login/link flow, quota checks, market/news/trade/strategy commands, signed Web Review links | Execution still happens in Web with wallet confirmation. |
| Profile | Manager linkage, Trading Balance, positions, PnL, settlement/redeem/funding UI, local receipts | Missing manager data stays empty instead of inventing positions or PnL. |

## Technical Flow

```mermaid
flowchart TD
  User["User\nquestion, prompt, or command"] --> Entry{"Entry point"}
  Entry --> Web["Web app\n/markets /trade /profile"]
  Entry --> Tg["Telegram bot\n/login /markets /trade /strategy"]

  Web --> Pilot["Pilot router\nchat / trade / strategy"]
  Tg --> ReviewLink["Signed Web Review link"]
  ReviewLink --> Pilot

  Pilot --> Chat["Market answer\nPredict + news + project context"]
  Pilot --> Trade["Trade draft\nsingle Predict intent"]
  Pilot --> Strategy["Strategy draft\nmulti-leg candidate"]

  Trade --> Intent["Intent parser\nDeepSeek JSON mode + deterministic fallback"]
  Strategy --> Legs["Strategy legs\nexpiry matching + budget allocation"]
  Legs --> Trade

  Intent --> Market["DeepBook Predict reads\nstatus + oracle + SVI + vault"]
  Market --> Guardian["Guardian RiskOps\nfreshness + lag + vault + sizing"]
  Guardian --> Quote["Quote preview\ncost + payout + expiry"]
  Quote --> PTB["PTB preview\nMove targets + inputs + digest"]
  PTB --> Review["User review\nquote, risk, funding, network, gas"]

  Review --> WalletGate{"Can sign now?"}
  WalletGate -->|"no"| Blocked["Explain missing field,\nstale quote, funding, or risk block"]
  WalletGate -->|"yes"| Wallet["Sui wallet\nuser chooses whether to sign"]
  Wallet --> Sui["Sui testnet\nmanager / mint / batch mint"]
  Sui --> Profile["Profile + receipts\npositions, PnL, settlement"]

  PTB --> Sponsor["Sponsor preview endpoint\nserver recompile + policy checks"]
  Sponsor --> PreviewReceipt["preview_authorized\nsubmitted=false"]
```

### Flow in Plain English

1. The user starts in Web or Telegram with a market question, trade request, or strategy request.
2. The pilot router classifies the input as chat, trade, or strategy.
3. Chat requests return Predict/news context. Trade and strategy requests are converted into constrained Predict reviews. LLM output is treated as untrusted and validated; deterministic fallback keeps the demo usable without an LLM key.
4. DeepPilot reads live DeepBook Predict status, active BTC oracles, oracle state, SVI data, and vault summary.
5. Guardian checks whether the review is safe enough to continue, should be reduced, or must be blocked.
6. If the action needs a position, DeepPilot requests a quote and builds a PTB preview with exact Move targets and inputs.
7. Before signing, the Web app refreshes quote-sensitive details from the typed intent or strategy plan, checks wallet network, SUI gas, PredictManager, and Trading Balance, and avoids re-running AI parsing.
8. Supported actions can be signed by the user's wallet. The user can reject the wallet prompt. Sponsor authorization remains a preview path only.
9. `/profile` keeps manager state, receipts, positions, PnL, funding, withdrawal, redeem, and settlement context visible after review.

## Main Routes

- `/landing` - public product page for judges and users.
- `/markets` - live BTC Predict market discovery and chart inspection.
- `/trade` - natural-language chat, trade review, strategy review, and wallet signing workspace.
- `/profile` - wallet profile, PredictManager state, Trading Balance, positions, receipts, and settlement actions.
- `/telegram/login` - wallet-link and Profile NFT onboarding for Telegram users.

## API Surface

- `POST /api/pilot/stream` - unified streaming endpoint for chat, trade, and strategy input.
- `POST /api/compile` - compiles a single Predict intent into market, Guardian, quote, gas, and PTB review; refreshed reviews may reuse typed intent to avoid re-running AI parsing.
- `POST /api/compile/stream` - streaming version of the single-trade compile flow.
- `POST /api/strategy/compile` - compiles a multi-leg strategy review.
- `POST /api/strategy/stream` - streaming version of the strategy review flow.
- `GET /api/markets` - paginated market discovery.
- `GET /api/oracles/:id/history` - bounded chart/history data for a selected oracle.
- `GET /api/profile` - wallet and PredictManager summary.
- `GET /api/review-seed` - decodes Telegram/Web Review replay tokens.
- `GET /api/sponsor` and `POST /api/sponsor` - sponsor challenge and preview authorization.
- `GET /api/health` - runtime health check.

## Implementation Notes

- `src/lib/pilot.ts` classifies user input into `chat`, `trade`, or `strategy`.
- `src/lib/intent.ts` parses single-trade Predict intent with DeepSeek JSON mode and deterministic fallback.
- `src/lib/strategy.ts` builds strategy legs, compiles each leg, and prepares batch execution readiness.
- `src/lib/predict.ts` is the only DeepBook Predict public API reader; responses are schema-validated and timeout-bound.
- `src/lib/guardian.ts` turns live market state into an `allow`, `reduce`, or `block` decision.
- `src/lib/compile.ts` orchestrates intent parsing, Predict reads, Guardian, quote, PTB, and gas checks. Refreshed reviews can reuse typed intent so signing is not blocked by a second AI parse.
- `src/lib/ptb.ts` builds auditable PTB previews with exact Move targets, object ids, and command inputs.
- `src/lib/predict-execution.ts` builds wallet-signable Sui transactions for supported manager, mint, batch mint, funding, withdrawal, and redeem actions.
- `src/lib/sponsor.ts` validates gas policy, package allowlists, Move call allowlists, and trade-size caps.
- `src/lib/telegram-bot.ts` handles Telegram commands, quota, memory context, review links, trade review, and strategy review.
- `components/deep-pilot-terminal.tsx` owns the main review and signing workspace.
- `components/markets-page.tsx` and `components/market-data-provider.tsx` own market discovery and short-lived client caching.
- `components/profile-page.tsx` owns manager, Trading Balance, positions, receipts, and settlement UX.

## Commands

```bash
bun install
bun run dev
bun run typecheck
bun run lint
bun run build
bun run pilot:smoke
bun run predict:smoke
bun run telegram:smoke
bun run move:build
bun run telegram:set-webhook
bun run sui:testnet-key
```

Use `bun run telegram:set-webhook` only after `APP_BASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET` are set.

## Environment

Copy `.env.example` to `.env.local` for local development. In Vercel, add the same keys in Project Settings -> Environment Variables.

Browser-safe wallet/RPC config uses `NEXT_PUBLIC_*`:

- `NEXT_PUBLIC_SUI_NETWORK`
- `NEXT_PUBLIC_SUI_TESTNET_GRPC_URL`
- `NEXT_PUBLIC_SUI_DEVNET_GRPC_URL`

Server-side Predict, execution, sponsor, Telegram, quota, profile, and optional memory settings use normal env names:

- `PREDICT_SERVER_URL`
- `PREDICT_NETWORK`
- `PREDICT_PACKAGE_ID`
- `PREDICT_OBJECT_ID`
- `PREDICT_DUSDC_TYPE`
- `PREDICT_PLP_COIN_TYPE`
- `PREDICT_SOURCE_BRANCH`
- `PREDICT_ENABLE_ONCHAIN_LOG`
- `PREDICT_PREVIEW_SENDER`
- `PREDICT_PREVIEW_SPONSOR`
- `PREDICT_PREVIEW_MANAGER`
- `DEEP_PILOT_LOG_PACKAGE_ID`
- `REVIEW_SEED_SECRET`
- `SPONSOR_MAX_GAS_BUDGET`
- `SPONSOR_MAX_TRADE_SIZE_DUSDC`
- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`
- `APP_BASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_LINK_SECRET`
- `TELEGRAM_LINK_SALT`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `DEEP_PILOT_PROFILE_PACKAGE_ID`
- `DEEP_PILOT_PROFILE_REGISTRY_ID`
- `DEEP_PILOT_PROFILE_TREASURY_ID`
- `PLAN_PRICE_MIST`
- `PLAN_DURATION_DAYS`
- `QUOTA_V1_DAILY_LIMIT`
- `MEMWAL_ACCOUNT_ID`
- `MEMWAL_DELEGATE_KEY`
- `MEMWAL_SERVER_URL`

There is no `NEXT_PRIVATE_*` convention in Next.js. Anything without `NEXT_PUBLIC_` stays server-side unless the app explicitly sends it to the browser.

## Demo Intents

```text
What is moving BTC today?
Bet 1 DUSDC on BTC DOWN at the nearest settlement
Build a 1 DUSDC hedge strategy, mostly BTC UP, nearest settlement
Split 1 DUSDC BTC UP across nearest, 1h, and 2h expiries
Redeem my settled BTC DOWN position
```

## Important Boundary

DeepPilot helps users understand, review, and sign DeepBook Predict actions. It is not investment advice, it does not guarantee profit, and it does not make trading decisions or sign transactions for the user.

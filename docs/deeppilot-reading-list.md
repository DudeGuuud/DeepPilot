# DeepPilot Reading List

> Last checked: 2026-06-11  
> Purpose: Read these materials before deciding implementation scope or submission wording.

## 0. Local Project Docs

Start here because these files explain the current product direction and the repo-specific boundary.

- [`final_proposal.md`](../final_proposal.md)
  - Read sections 1, 4, 7, 8, 14 first.
  - Key point: DeepPilot should be a DeepBook Predict RiskOps cockpit, not a generic AI trading terminal.
  - Watch wording: do not imply real sponsored execution or real mint/redeem unless the code actually submits transactions.

- [`patch.md`](../patch.md)
  - Treat this as implementation notes and backlog.
  - Useful sections: Agentic Trading Model, Bounded-Risk Rules, Sponsor Boundary, RAG Plan, LP Pilot MVP.
  - Do not treat DeepSeek, RAG, Telegram, Seal, Walrus, and LP Pilot as all required for the first demo.

- [`README.md`](../README.md)
  - Use it to understand what the project currently claims publicly.
  - Keep README claims aligned with the actual implementation state.

## 1. Competition And Track Fit

- Sui Overflow 2026
  - https://overflow.sui.io/
  - Read: Tracks, Prizes, Specialized Track Pools.
  - Key point: DeepBook specialized track is about trading or liquidity applications powered by DeepBook. DeepBook pool is listed as 70,000 USD.
  - Caution: the public page contains some old timeline text from 2025, so final submission dates should be confirmed in the participant dashboard.

## 2. DeepBook Predict Core

Read these before touching product scope or risk logic.

- DeepBook Predict overview
  - https://docs.sui.io/onchain-finance/deepbook-predict/
  - Read: Key features, Integration model, User flow, Liquidity provider flow, Testnet status.
  - Key point: Predict is currently a Sui Testnet integration surface. Package IDs, object layouts, and entry points are provisional before mainnet.

- DeepBook Predict design
  - https://docs.sui.io/onchain-finance/deepbook-predict/design
  - Read: Predict shared object, PredictManager, Positions and ranges, Oracle lifecycle, Vault.
  - Key point: the important data model is Predict + PredictManager + OracleSVI + Vault. Many bugs will come from confusing these objects.

- DeepBook Predict contract information
  - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information
  - Read: Current deployment, Supported quote assets, Public server endpoints, Live Sui events, Source pointers.
  - Key point: this is the authoritative place for current testnet IDs, DUSDC type, PLP type, public server, and endpoint list.

## 3. Predict Onchain Objects

Read these when implementing real transaction building or manager-aware UI.

- Predict
  - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict
  - Focus: `create_manager`, `mint`, `mint_range`, `redeem`, `redeem_permissionless`, `supply`, `withdraw`.
  - Key point: `Predict` is the main shared protocol entry point and coordinates manager balances, oracle state, pricing config, risk config, and vault accounting.

- Predict Manager
  - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/predict-manager
  - Focus: owner, balances, deposited quote assets, position quantities, range quantities.
  - Key point: positions and ranges are stored inside the manager. They are not separate position NFTs.

- Oracle
  - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/oracle
  - Focus: lifecycle and timestamps.
  - Key point: mint requires a live oracle. Redeem can use live or settled oracle state. After settlement, price and SVI updates stop.

- Vault
  - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault
  - Focus: vault value, exposure, max payout, PLP supply and withdrawal.
  - Key point: Predict vault liquidity is not a classic visible orderbook depth model.

## 4. Sui Transaction Mechanics

Read these before replacing PTB preview with real wallet transactions.

- Programmable Transaction Blocks
  - https://docs.sui.io/develop/transactions/ptbs/prog-txn-blocks
  - Focus: inputs, commands, `moveCall`, object usage, atomic execution.
  - Key point: a PTB can call multiple Move functions in one transaction, and if one command fails, the whole block fails with no effects.

- Sponsored Transactions
  - https://docs.sui.io/develop/transaction-payment/sponsor-txn
  - Focus: gas owner, sender signature, sponsor signature, transaction validation.
  - Key point: sponsored execution is not just a boolean flag. The sponsor must validate the transaction and co-sign it.

## 5. Current Repo Implementation Pointers

These files map the proposal to the current code.

- [`src/lib/predict.ts`](../src/lib/predict.ts)
  - Predict public server client, schema validation, market snapshot, oracle history, normalization.

- [`src/lib/guardian.ts`](../src/lib/guardian.ts)
  - Deterministic risk checks: oracle state, expiry, freshness, pipeline lag, vault utilization, liquidity, ask-bounds fallback.

- [`src/lib/intent.ts`](../src/lib/intent.ts)
  - Rule-based intent parser. This is not an LLM parser yet.

- [`src/lib/ptb.ts`](../src/lib/ptb.ts)
  - PTB preview builder. It is not a submitted transaction builder yet.

- [`src/lib/sponsor.ts`](../src/lib/sponsor.ts)
  - Sponsor policy preview and allowlist checks.

- [`app/api/sponsor/route.ts`](../app/api/sponsor/route.ts)
  - Sponsor challenge and preview authorization route. It does not produce a sponsor signature and does not submit a transaction.

- [`scripts/verify-predict.ts`](../scripts/verify-predict.ts)
  - Current smoke test for Predict API, Guardian, PTB preview, sponsor preview, markets, history, profile fallback, and JSON parsing.

## 6. Optional Add-ons

These are useful, but they should not block the first Predict execution demo.

- DeepSeek API quick start
  - https://api-docs.deepseek.com/
  - Focus: OpenAI-compatible base URL, `DEEPSEEK_API_KEY`, model names.
  - Key point: keep model calls server-side and validate model output as untrusted JSON.

- DeepSeek models and pricing
  - https://api-docs.deepseek.com/quick_start/pricing
  - Focus: model names, JSON output support, context length, pricing, deprecation notes.
  - Key point: pricing and models can change, so do not hard-code cost assumptions in proposal copy.

- Seal
  - https://docs.sui.io/sui-stack/seal/sui-stack-seal
  - Use for encrypted audit receipts only after the core Predict path works.

- Walrus
  - https://docs.sui.io/sui-stack/walrus
  - Use for off-chain receipt blobs only after the core Predict path works.

- DeepBookV3 Orders SDK
  - https://docs.sui.io/onchain-finance/deepbookv3-sdk/orders
  - Useful for understanding normal DeepBook orderbook bots.
  - Caution: DeepBook Predict PLP is not the same thing as a DeepBookV3 spot maker bot.

## 7. Recommended Reading Order

1. `final_proposal.md`
2. DeepBook Predict overview
3. DeepBook Predict contract information
4. DeepBook Predict design
5. Predict, Predict Manager, Oracle, Vault pages
6. PTB docs
7. Sponsored transaction docs
8. Current repo files in section 5
9. `patch.md`
10. Optional add-ons in section 6

## 8. Questions To Answer After Reading

- Are we submitting as a real Predict execution app, or as API-backed preview plus risk cockpit?
- Will we implement real `PredictManager` creation/deposit/mint/redeem before the demo?
- Is sponsor support required for the demo, or is sponsor-policy preview enough?
- Do we want AI in the first submission, or should AI stay as a small intent parser / explanation layer?
- Is Seal/Walrus part of the demo, or only a stretch audit story?


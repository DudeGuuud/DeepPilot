# DeepPilot Agentic Trading / LP Pilot Patch Notes

## Core Judgment

DeepPilot should not be marketed as an AI bot that "prevents losses". That is false and dangerous. The correct product claim is:

> DeepPilot provides bounded-risk delegated execution for DeepBook Predict: AI drafts and explains actions, while deterministic policy, Guardian checks, wallet confirmation, and sponsor validation decide what can actually execute.

The LLM is a copilot, not the execution authority.

## Agentic Trading Model

Modern agentic trading systems usually separate responsibilities into layers:

1. Advisor
   - Reads markets, portfolio state, protocol docs, and risk state.
   - Produces explanations and recommendations.
   - Does not execute.

2. Intent compiler
   - Converts user text into a constrained structured intent.
   - Example: "Supply 100 DUSDC to PLP if utilization is under 20%".
   - Output must pass schema validation before it reaches trading code.

3. Policy engine
   - Applies hard rules: size caps, daily caps, allowed markets, oracle freshness, slippage, liquidity, vault utilization, and kill switches.
   - This layer must be deterministic code, not LLM judgment.

4. Execution planner
   - Builds PTB previews only after policy allows the intent.
   - Uses allowlisted Move calls and server-side recomputation.

5. User confirmation / signer
   - Wallet or Telegram Mini App confirms the final transaction.
   - The agent must not own the user's wallet key.

6. Keeper
   - Handles mechanical lifecycle work: redeem, withdraw, cancel stale orders, refresh receipt state, monitor settlement, and retry safe operations.

7. Audit layer
   - Records intent hash, market snapshot hash, Guardian result, PTB digest, sponsor checks, model version, and final tx digest.

This is the right architecture because it keeps AI in the fuzzy interpretation layer and keeps money movement inside verifiable code.

## Bounded-Risk Rules

Rules should be described as preventing unauthorized or irrational execution, not as guaranteeing profit.

Minimum rule set:

- Max single trade size.
- Max daily spend and transaction count.
- Max open exposure per wallet and per market.
- Max slippage or spread.
- Max oracle age and max Predict pipeline lag.
- Min available liquidity.
- Max vault utilization and max payout utilization.
- No new position if expiry is too close.
- No action when Guardian returns `block`.
- Human confirmation required above threshold.
- Kill switch after repeated failures, stale data, or abnormal price movement.
- Move target allowlist.
- Server-side PTB recomputation before sponsor approval.
- AI output can only create a draft; it cannot approve or sign.

This is the rule layer we can present as the agent safety boundary.

## DeepSeek Integration

Use DeepSeek `deepseek-v4-flash` through a server-only route:

```text
browser
  -> POST /api/pilot
      -> retrieve docs, market DTOs, vault summary, profile state
      -> call DeepSeek with DEEPSEEK_API_KEY
      -> validate strict JSON with zod
      -> optionally pass draft intent into the existing compiler
```

Implementation rules:

- Store the key as `DEEPSEEK_API_KEY`.
- Never use `NEXT_PUBLIC_` for model keys.
- Never return provider raw prompts, hidden policy text, or API keys to the browser.
- The browser receives only sanitized DTOs and model output.
- LLM output must include citations or data references when it explains protocol behavior.
- LLM output must be treated as untrusted input.

## UI Placement

DeepPilot should feel like a pilot, not a chatbot bolted onto a terminal.

Recommended UI:

- `/markets`
  - Add `Pilot Brief`.
  - Rank the four visible markets.
  - Explain expiry, freshness, vault utilization, selected strike, and risk badges.

- `/trade`
  - Add `Intent Copilot`.
  - Let AI generate a draft intent from natural language.
  - User clicks `Apply`, then the deterministic compiler runs.
  - Guardian remains the final pre-signing risk voice.

- `/profile`
  - Add `Post-trade Debrief`.
  - Summarize local receipts, manager state, settlement work, redeemable actions, and missing setup.

- LP surface
  - Add `LP Pilot`.
  - Show vault balance, PLP share price, utilization, max payout utilization, and available withdrawal.
  - Provide guarded supply / withdraw previews.

## Sponsor Boundary

Current code does not expose a sponsor private key to the frontend. It also does not perform a real sponsor signature yet; it produces a sponsor-policy preview receipt.

Real sponsored execution needs:

- Sponsor gas coin pool.
- Full `TransactionData`.
- User signature.
- Sponsor signature.
- Dual-signed transaction submission.
- Rebuild on stale gas object or stale owned object errors.

Sponsor service rules:

- Do not trust PTBs sent from the browser.
- Recompile from intent on the server.
- Check PTB digest matches the user-authorized challenge.
- Validate Guardian state.
- Validate gas budget.
- Validate amount caps.
- Validate every Move target against allowlist.

## Seal + Walrus Audit

The useful audit product is not "store everything on-chain". That is wasteful. The useful product is:

1. Build canonical JSON receipt.
2. Hash plaintext receipt.
3. Seal-encrypt the receipt.
4. Upload encrypted blob to Walrus.
5. Emit or store on-chain pointer: `blobId + plaintextHash + policyId`.
6. Show `Audit sealed on Walrus` in UI.

Canonical receipt fields:

- intent hash
- user wallet
- market / oracle id
- vault snapshot hash
- Guardian result
- sponsor checks
- PTB digest
- model name and model output hash
- final tx digest, when submitted

Do not store wallet keys, seed phrases, sponsor keys, or DeepSeek API keys in Seal or Walrus.

## RAG Plan

MVP RAG should be small and auditable.

Sources:

- Sui sponsored transaction docs.
- Seal and Walrus docs.
- DeepBook Predict docs.
- DeepBookV3 order docs.
- README.
- Move sources.
- final proposal.

Chunk metadata:

- `sourceUrl`
- `sourcePath`
- `sha256`
- `updatedAt`
- `sectionTitle`

Output schema:

```ts
type PilotAnswer = {
  answer: string;
  citations: Array<{ label: string; url?: string; path?: string }>;
  draftIntent?: string;
  riskFlags: string[];
  requiresHumanConfirmation: boolean;
};
```

Do not start with a heavy vector database unless retrieval quality becomes a real problem. Keyword or BM25 retrieval is enough for the first demo.

## Telegram Bot Direction

Use Telegram as an entry point, not as a signer.

Correct flow:

1. Telegram bot sends alert, quote, or opportunity summary.
2. User taps a deep link into Telegram Mini App / web app.
3. Wallet signs inside the mobile wallet flow.
4. Sponsor server recompiles and validates.
5. Receipt is stored and later sealed.

Telegram user identity must be bound to wallet identity through a signed wallet message.

## DeepBook LP / Bot Reality Check

There are two different LP concepts:

1. DeepBookV3 spot maker bot
   - Uses the order book.
   - Places and cancels limit orders.
   - Can earn maker rebates when staking and volume conditions are met.
   - Official SDK exposes order functions like `placeLimitOrder`, `placeMarketOrder`, `cancelOrder`, and `withdrawSettledAmounts`.

2. DeepBook Predict PLP liquidity
   - LPs call `predict::supply` with accepted quote assets.
   - Protocol mints `PLP` shares.
   - Withdraw burns `PLP` and returns quote asset when withdrawal is available after max payout coverage.
   - This is a shared prediction-market vault, not a classic AMM pool.

Live check:

- Predict testnet `/status` responds.
- Pipeline includes `supplied`.
- `/vault/summary` returns `plp_total_supply`, `available_liquidity`, `available_withdrawal`, `utilization`, and `max_payout_utilization`.

Conclusion: Predict PLP is real enough for a testnet integration. There is no official finished "LP bot product" to embed, but DeepPilot can build a guarded LP assistant on top of the protocol.

## LP Pilot MVP

Add a first-class LP flow only after basic trade execution is real.

MVP actions:

- Read vault summary.
- Explain PLP share price, utilization, max payout utilization, and withdrawal capacity.
- Preview `predict::supply`.
- Preview `predict::withdraw`.
- Apply hard risk rules before the user signs.

Example intents:

- "Supply 100 DUSDC to PLP if utilization is under 20%."
- "Withdraw 50 PLP if available withdrawal covers it."
- "Show PLP risk and suggest whether to wait."

Risk rules:

- Block supply when max payout utilization is too high.
- Block withdraw when available withdrawal is insufficient.
- Require confirmation when PLP share price moved beyond threshold.
- Require confirmation when vault net deposits or total max payout changes sharply.
- Never auto-loop supply/withdraw without explicit delegated limits.

Stretch goal:

- PLP + hedge assistant: supply to PLP, then buy small OTM Predict protection based on vault exposure and user risk budget.

## Winning Priority

The shortest path to a stronger hackathon submission:

1. Real testnet mint / redeem transaction digest.
2. Real sponsored transaction dual-sign submission.
3. AI Pilot with market ranking, intent repair, risk explanation, and citations.
4. LP Pilot with guarded `predict::supply` / `predict::withdraw` preview.
5. Seal + Walrus sealed audit receipt.
6. Profile index beyond localStorage.
7. Telegram Mini App mobile demo.

Do these in this order. Do not build an autonomous money manager before the deterministic execution path is boring and correct.

## Reference Links

- DeepSeek model pricing: https://api-docs.deepseek.com/quick_start/pricing
- Sui sponsored transactions: https://docs.sui.io/develop/transaction-payment/sponsor-txn
- DeepBook Predict: https://docs.sui.io/onchain-finance/deepbook-predict/
- DeepBook Predict vault: https://docs.sui.io/onchain-finance/deepbook-predict/contract-information/vault
- DeepBookV3 orders SDK: https://docs.sui.io/onchain-finance/deepbookv3-sdk/orders
- Seal encryption: https://docs.sui.io/sui-stack/seal/sui-stack-seal

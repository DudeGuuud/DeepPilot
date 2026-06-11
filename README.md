# DeepPilot RiskOps

DeepPilot is a DeepBook Predict execution and risk cockpit for Sui Overflow 2026.

The app turns a constrained trading intent into:

- a live DeepBook Predict market snapshot from `predict-server.testnet.mystenlabs.com`
- a deterministic Guardian decision (`allow`, `reduce`, or `block`)
- an auditable Predict PTB preview
- a sponsor-policy preview for testnet demo flows

## Current Scope

This repository targets DeepBook Predict testnet. It does not pretend to expose a traditional CLOB order book. The risk model uses official Predict primitives:

- Predict server health and pipeline lag
- active BTC oracle state
- latest spot, forward, and SVI data
- oracle freshness and expiry
- vault liquidity, utilization, and max-payout utilization
- ask-bounds when available, with an explicit fallback when the endpoint returns `null`

## Commands

```bash
bun install
bun run typecheck
bun run lint
bun run build
bun run predict:smoke
bun run dev
bun run sui:testnet-key
bun run sui:mock-sign
```

## Environment

Copy `.env.example` to `.env.local` for local development. In Vercel, add the same keys in Project Settings -> Environment Variables.

Use `NEXT_PUBLIC_` only for browser-side wallet/RPC config:

- `NEXT_PUBLIC_SUI_NETWORK`
- `NEXT_PUBLIC_SUI_TESTNET_GRPC_URL`
- `NEXT_PUBLIC_SUI_DEVNET_GRPC_URL`

Use normal server-side env names for DeepBook Predict deployment IDs and package IDs:

- `PREDICT_SERVER_URL`
- `PREDICT_NETWORK`
- `PREDICT_PACKAGE_ID`
- `PREDICT_OBJECT_ID`
- `PREDICT_DUSDC_TYPE`
- `PREDICT_PLP_COIN_TYPE`
- `PREDICT_SOURCE_BRANCH`

Next.js does not need a `NEXT_PRIVATE_` prefix. Anything without `NEXT_PUBLIC_` stays server-side unless you manually send it to the client.

## Important Files

- `.env.example` - Vercel/local deployment configuration template
- `src/lib/predict.ts` - DeepBook Predict public API client and snapshot builder
- `src/lib/predict-config.ts` - server-side Predict deployment config
- `src/lib/client-config.ts` - browser-safe wallet/RPC config
- `src/lib/intent.ts` - deterministic Predict intent parser
- `src/lib/guardian.ts` - pre-sign risk policy
- `src/lib/ptb.ts` - auditable Predict PTB preview
- `components/deep-pilot-terminal.tsx` - client UI
- `final_proposal.md` - final track proposal and risk review
- `docs/archive/` - original research drafts kept for traceability

## Demo Intent

```text
Buy 10 DUSDC BTC UP near 62500 on the next active DeepBook Predict oracle
```

Real submission still requires a funded testnet Predict manager and DUSDC. The app currently produces a live-data PTB preview and sponsor-policy receipt, not a submitted transaction.

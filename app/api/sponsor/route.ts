import { NextResponse } from "next/server";
import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { checkRateLimit, parseJsonBody, rateLimitHeaders } from "@/src/lib/http";
import { issueSponsorChallenge, verifySponsorAuthorization, hashIntent } from "@/src/lib/sponsor-auth";
import { validateSponsorPlan } from "@/src/lib/sponsor";

const suiAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const ptbDigestSchema = z.string().regex(/^0x[a-fA-F0-9]{16,128}$/);

const challengeSchema = z.object({
  walletAddress: suiAddressSchema,
  network: z.enum(["devnet", "testnet"]),
  ptbDigest: ptbDigestSchema
});

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500),
  walletAddress: suiAddressSchema,
  network: z.enum(["devnet", "testnet"]),
  ptbDigest: ptbDigestSchema,
  nonce: z.string().uuid(),
  expiresAt: z.string().datetime(),
  signature: z.string().min(32).max(1_024)
});

export async function GET(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "sponsor-challenge",
    maxRequests: 20,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sponsor challenge requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const query = new URL(request.url).searchParams;
  const parsed = challengeSchema.safeParse({
    walletAddress: query.get("walletAddress"),
    network: query.get("network"),
    ptbDigest: query.get("ptbDigest")
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid sponsor challenge request" }, { status: 400 });
  }

  return NextResponse.json(issueSponsorChallenge(parsed.data));
}

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(request, {
    scope: "sponsor-submit",
    maxRequests: 20,
    windowMs: 60_000
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many sponsor requests" },
      { status: 429, headers: rateLimitHeaders(rateLimit.retryAfterSeconds) }
    );
  }

  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return NextResponse.json({ error: "Invalid sponsor payload" }, { status: 400 });
  }

  const authorized = await verifySponsorAuthorization({
    walletAddress: body.data.walletAddress,
    network: body.data.network,
    ptbDigest: body.data.ptbDigest,
    nonce: body.data.nonce,
    expiresAt: body.data.expiresAt,
    signature: body.data.signature
  });

  if (!authorized) {
    return NextResponse.json({ approved: false, reason: "Wallet sponsor authorization failed." }, { status: 401 });
  }

  let compiled: Awaited<ReturnType<typeof compileIntent>>;

  try {
    compiled = await compileIntent(body.data.intent);
  } catch {
    return NextResponse.json({ approved: false, reason: "Sponsor compile failed." }, { status: 502 });
  }
  const gas = validateSponsorPlan(compiled.gas, compiled.ptb);

  if (compiled.ptb?.digestPreview !== body.data.ptbDigest) {
    return NextResponse.json(
      {
        approved: false,
        gas,
        reason: "Sponsor authorization does not match the compiled PTB."
      },
      { status: 409 }
    );
  }

  if (!compiled.ptb || compiled.guardian.blocked || !gas.approved) {
    return NextResponse.json(
      {
        approved: false,
        guardian: compiled.guardian,
        gas,
        reason: "Sponsor policy rejected this PTB preview."
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    approved: true,
    receipt: {
      digest: compiled.ptb.digestPreview,
      status: "preview_authorized",
      walletAddress: body.data.walletAddress,
      network: body.data.network,
      nonce: body.data.nonce,
      expiresAt: body.data.expiresAt,
      intentHash: hashIntent(body.data.intent),
      sender: compiled.ptb.sender,
      sponsor: compiled.ptb.sponsor,
      gasMode: gas.mode,
      checks: gas.checks,
      submitted: false,
      note: "Wallet authorized this preview. No sponsor signature was produced and no transaction was submitted."
    }
  });
}

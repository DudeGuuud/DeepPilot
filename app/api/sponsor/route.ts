import { NextResponse } from "next/server";
import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500)
});

export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json({ error: "Invalid sponsor payload" }, { status: 400 });
  }

  const compiled = compileIntent(body.data.intent);

  if (!compiled.ptb || compiled.guardian.blocked || !compiled.gas.approved) {
    return NextResponse.json(
      {
        approved: false,
        guardian: compiled.guardian,
        gas: compiled.gas,
        reason: "Sponsor policy rejected this PTB preview."
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    approved: true,
    receipt: {
      digest: compiled.ptb.digestPreview,
      status: "signed_preview",
      sender: compiled.ptb.sender,
      sponsor: compiled.ptb.sponsor,
      gasMode: compiled.gas.mode,
      submitted: false,
      note: "Dual-signature flow simulated locally. No transaction was submitted."
    }
  });
}


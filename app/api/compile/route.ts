import { NextResponse } from "next/server";
import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { createDeepBookClientPreview } from "@/src/lib/deepbook";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500)
});

export async function POST(request: Request) {
  const body = bodySchema.safeParse(await request.json());

  if (!body.success) {
    return NextResponse.json(
      {
        error: "Invalid intent payload"
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ...compileIntent(body.data.intent),
    sui: createDeepBookClientPreview()
  });
}


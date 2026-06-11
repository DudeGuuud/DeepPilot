import { NextResponse } from "next/server";
import { z } from "zod";

import { compileIntent } from "@/src/lib/compile";
import { parseJsonBody } from "@/src/lib/http";
import { createPredictClientPreview } from "@/src/lib/predict";

const bodySchema = z.object({
  intent: z.string().trim().min(1).max(500)
});

export async function POST(request: Request) {
  const body = await parseJsonBody(request, bodySchema);

  if (!body.success) {
    return NextResponse.json(
      {
        error: "Invalid intent payload"
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ...(await compileIntent(body.data.intent)),
    predict: createPredictClientPreview()
  });
}

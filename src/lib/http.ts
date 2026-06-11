import { z } from "zod";

export async function parseJsonBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema
): Promise<{ success: true; data: z.infer<TSchema> } | { success: false }> {
  try {
    const parsed = schema.safeParse(await request.json());

    return parsed.success ? { success: true, data: parsed.data } : { success: false };
  } catch {
    return { success: false };
  }
}

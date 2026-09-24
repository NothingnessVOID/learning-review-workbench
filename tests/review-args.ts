import assert from "node:assert/strict";
import type { Service, Actor } from "../src/domain/service.js";

/** Tests use the same complete-comparison round trip as the local review page. */
export async function comparedReviewArgs(
  service: Service,
  tool: string,
  input: unknown,
  actor: Actor,
) {
  const args = input as any;
  if (
    actor !== "local_user" ||
    tool !== "review_draft" ||
    args?.action !== "accept"
  )
    return input;
  const state = await service.invoke(
    "get_draft_status",
    { draft_id: args.draft_id },
    actor,
  );
  assert.equal(state.ok, true, JSON.stringify(state.error));
  if ((state.data as any)?.entity_type !== "course") return input;
  const comparison = await service.invoke(
    "get_draft_comparison",
    { draft_id: args.draft_id },
    actor,
  );
  assert.equal(comparison.ok, true, JSON.stringify(comparison.error));
  assert.equal((comparison.data as any)?.ready, true);
  return {
    ...args,
    comparison_token: (comparison.data as any).comparison_token,
  };
}

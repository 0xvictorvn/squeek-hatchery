import assert from "node:assert/strict";
import test from "node:test";

test("invalid or interrupted JSON cannot become a successful empty API result", async () => {
  const { readApiJson } = await import("../src/api-response.ts").catch(() => assert.fail("Strict API response reader is missing."));
  await assert.rejects(() => readApiJson(new Response("<html>fallback</html>")));
  const interrupted = new ReadableStream({ start(controller) { controller.error(new DOMException("Aborted", "AbortError")); } });
  await assert.rejects(() => readApiJson(new Response(interrupted)), /Aborted/);
  const detail = { snapshot: { familyName: "Prism" }, player: { effectiveName: "QA" } };
  assert.deepEqual(await readApiJson(Response.json(detail)), detail);
});

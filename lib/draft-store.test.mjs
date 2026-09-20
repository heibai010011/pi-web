import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, rekeyDraft, restoreDraftSubmission, registerDraftRestoration, setDraft } = await jiti.import("./draft-store.ts");
const image = (n) => ({ data: Buffer.from(`image-${n}`).toString("base64"), mimeType: "image/png" });

test("restore-only owner routing neither broadcasts writes nor revives stale owners", () => {
  const key = "owner-store";
  let calls = 0;
  const stale = registerDraftRestoration(key, () => assert.fail("stale owner"));
  const cleanup = registerDraftRestoration(key, (text, images) => {
    calls++;
    const restored = { value: text, images: images ?? [] };
    setDraft(key, restored);
    return restored;
  });
  try {
    stale();
    setDraft(key, { value: "ordinary", images: [] });
    assert.equal(calls, 0);
    const restored = restoreDraftSubmission(key, "recovered", [image(1)]);
    assert.equal(calls, 1);
    restored.images[0].data = "mutated";
    assert.equal(getDraft(key).images[0].data, image(1).data);
    cleanup();
    restoreDraftSubmission(key, "offscreen");
    assert.equal(calls, 1);
    assert.equal(getDraft(key).value, "offscreen\n\nrecovered");
  } finally { stale(); cleanup(); clearDraft(key); }
});

test("recovery preserves all valid images beyond upload capacity, including duplicates", () => {
  const submitted = Array.from({ length: 10 }, (_, n) => image(n));
  const current = [image(10), submitted[0]];
  const invalid = [{ data: "%%%", mimeType: "image/png" }, { data: "AQID", mimeType: "text/plain" }];
  const restored = mergeRestoredSubmissionDraft("old", [...submitted, ...invalid], "new", current);
  assert.deepEqual(restored, { value: "old\n\nnew", images: [...submitted, ...current] });
});

test("offscreen restoration and rekey retain every recoverable image with clone isolation", () => {
  const a = "over-cap-a", b = "over-cap-b";
  const submitted = Array.from({ length: 10 }, (_, n) => image(n));
  try {
    setDraft(a, { value: "new", images: [image(10)] });
    const restored = restoreDraftSubmission(a, "old", submitted);
    assert.equal(restored.images.length, 11);
    restored.images[0].data = "mutated";
    assert.deepEqual(getDraft(a).images, [...submitted, image(10)]);
    setDraft(b, { value: "destination", images: [image(11)] });
    assert.deepEqual(rekeyDraft(a, b, { value: "", images: [] }), {
      value: "destination\n\nold\n\nnew", images: [image(11), ...submitted, image(10)],
    });
    assert.equal(getDraft(a), null);
    assert.equal(getDraft(b).images.length, 12);
  } finally { clearDraft(a); clearDraft(b); }
});

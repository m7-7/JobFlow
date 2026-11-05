// Review and delete panel decisions, and the one request each confirmation
// sends, against a stubbed fetch (no server, no React, no dependencies).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { toEvidenceDraft, type Evidence } from "./evidence.ts";
import {
  REVIEW_SCOPE_TEXT,
  confirmDelete,
  confirmReview,
  deleteAfterConfirm,
  neighborAfterRemoval,
  openDelete,
  openReview,
  panelAfterRead,
  panelNeedsRead,
  panelOrphaned,
  retryPanelRead,
  reviewAfterConfirm,
  reviewInspected,
  type DeletePanel,
  type ReviewPanel,
} from "./evidenceActions.ts";

// The list's copy of the source, possibly outdated.
const listed: Evidence = {
  id: 4,
  type: "personal_project",
  title: "Payments service",
  description: "Old description.",
  url: null,
  origin: "manual",
  reviewedAt: null,
  skillIds: [1, 3],
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};
// What the server holds when the panel reads it.
const persisted: Evidence = {
  ...listed,
  description: "Current description.",
  updatedAt: "2026-10-22T08:30:15.123Z",
};
// A later edit made elsewhere.
const newer: Evidence = { ...persisted, title: "Payments service v2", updatedAt: "2026-10-23T11:00:00.456Z" };
// The server's answer to a recorded review: same version, review set.
const reviewed: Evidence = { ...persisted, reviewedAt: "2026-10-24T10:00:00.000Z" };

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (
  kind: "network" | "server" | "unavailable" | "invalid_response" | "not_found" | "stale" | "bad_request"
) => ({ ok: false as const, failure: { kind } }) as const;

// ── Stubbed fetch ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

function stubFetch(...responders: (() => Response | Promise<Response>)[]) {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const respond = responders[calls.length - 1];
    if (!respond) throw new Error(`unexpected request ${init.method} ${url}`);
    return respond();
  }) as typeof fetch;
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

afterEach(() => {
  globalThis.fetch = realFetch;
});

// A review panel that has read the persisted source.
const readyReview = (): ReviewPanel => panelAfterRead(openReview(listed), ok(persisted)) as ReviewPanel;

// ── Review ──────────────────────────────────────────────────────────────────

describe("review panel: what is inspected", () => {
  it("reads the persisted source first and cannot confirm before it is shown", () => {
    const panel = openReview(listed);
    assert.equal(panelNeedsRead(panel), true);
    assert.equal(reviewInspected(panel), null);
  });

  it("inspects the server's version, not the list's or a draft", () => {
    const panel = readyReview();
    assert.deepEqual(reviewInspected(panel), persisted);
    assert.equal(panel.notice, null);
  });

  it("cannot confirm when the read fails, and only an explicit retry reads again", () => {
    const failed = panelAfterRead(openReview(listed), fail("network")) as ReviewPanel;
    assert.equal(failed.phase.kind, "load_failed");
    assert.equal(reviewInspected(failed), null);
    assert.equal(panelNeedsRead(failed), false);
    const retried = retryPanelRead(failed);
    assert.equal(retried.phase.kind, "loading");
    assert.equal(panelNeedsRead(retried), true);
  });

  it("reports a missing source on a 404 read", () => {
    assert.equal(panelAfterRead(openReview(listed), fail("not_found")).phase.kind, "missing");
  });

  it("ignores a read the panel no longer waits for", () => {
    const panel = readyReview();
    assert.equal(panelAfterRead(panel, ok(newer)), panel);
  });

  it("states that the review is not independent verification", () => {
    assert.equal(
      REVIEW_SCOPE_TEXT,
      "Candidate review confirms that you have inspected this source's details. It does not independently verify the evidence or its linked skills."
    );
  });
});

describe("review confirmation request", () => {
  it("sends one POST with the exact updatedAt of the inspected version", async () => {
    stubFetch(json(200, reviewed));
    const result = await confirmReview(reviewInspected(readyReview())!);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      { method: "POST", url: "/api/evidence/4/review", body: { expectedUpdatedAt: "2026-10-22T08:30:15.123Z" } },
    ]);
  });

  it("sends nothing else after a network failure", async () => {
    stubFetch(offline);
    const result = await confirmReview(persisted);
    assert.deepEqual(result, fail("network"));
    assert.equal(calls.length, 1);
  });
});

describe("review outcomes", () => {
  it("is reviewed from the confirmed server response", () => {
    const next = reviewAfterConfirm(readyReview(), persisted, ok(reviewed));
    assert.deepEqual(next.phase, { kind: "reviewed", evidence: reviewed, via: "confirmed" });
  });

  it("on 409 drops the inspected content and requires a new read and a new confirmation", () => {
    const stale = reviewAfterConfirm(readyReview(), persisted, fail("stale"));
    assert.equal(stale.notice, "stale");
    assert.equal(stale.phase.kind, "loading");
    assert.equal(reviewInspected(stale), null); // cannot confirm the old version
    assert.equal(panelNeedsRead(stale), true); // a read, never a repeated POST
    const reread = panelAfterRead(stale, ok(newer)) as ReviewPanel;
    assert.deepEqual(reviewInspected(reread), newer);
    assert.equal(reread.notice, "stale");
    assert.equal(reread.title, newer.title);
  });

  it("after a 409 whose reread fails, still cannot confirm", () => {
    const stale = reviewAfterConfirm(readyReview(), persisted, fail("stale"));
    const failed = panelAfterRead(stale, fail("server")) as ReviewPanel;
    assert.equal(failed.phase.kind, "load_failed");
    assert.equal(reviewInspected(failed), null);
  });

  it("keeps the inspected version and allows another explicit try after a definite rejection", () => {
    const next = reviewAfterConfirm(readyReview(), persisted, fail("bad_request"));
    assert.deepEqual(next.phase, { kind: "ready", inspected: persisted, error: { kind: "bad_request" } });
  });

  it("reports a missing source on a 404", () => {
    assert.equal(reviewAfterConfirm(readyReview(), persisted, fail("not_found")).phase.kind, "missing");
  });

  for (const kind of ["network", "server", "unavailable", "invalid_response"] as const) {
    it(`treats ${kind} as uncertain: no confirmation, a read instead`, () => {
      const next = reviewAfterConfirm(readyReview(), persisted, fail(kind));
      assert.equal(next.phase.kind, "uncertain");
      assert.equal(reviewInspected(next), null);
      assert.equal(panelNeedsRead(next), true);
    });
  }
});

describe("reconciling an uncertain review", () => {
  const uncertain = () => reviewAfterConfirm(readyReview(), persisted, fail("network"));

  it("is reviewed when the inspected version holds a review", () => {
    const next = panelAfterRead(uncertain(), ok(reviewed));
    assert.deepEqual(next.phase, { kind: "reviewed", evidence: reviewed, via: "reconciled" });
  });

  it("asks for a new explicit confirmation when the version holds no review", () => {
    const next = panelAfterRead(uncertain(), ok(persisted)) as ReviewPanel;
    assert.equal(next.notice, "not_recorded");
    assert.deepEqual(reviewInspected(next), persisted);
  });

  it("asks to inspect again when the content changed, whatever the timestamps", () => {
    // reviewedAt later than the new updatedAt must not count as a review of it.
    const changed = { ...newer, reviewedAt: "2026-12-01T00:00:00.000Z" };
    const next = panelAfterRead(uncertain(), ok(changed)) as ReviewPanel;
    assert.equal(next.notice, "changed");
    assert.deepEqual(reviewInspected(next), changed);
  });

  it("keeps the uncertainty when the check fails, and checks again only on request", () => {
    const failed = panelAfterRead(uncertain(), fail("network"));
    assert.deepEqual(failed.phase, {
      kind: "uncertain",
      inspected: persisted,
      failure: { kind: "network" },
      check: "failed",
    });
    assert.equal(panelNeedsRead(failed), false);
    assert.equal(reviewInspected(failed), null);
    assert.equal(panelNeedsRead(retryPanelRead(failed)), true);
  });

  it("reports a missing source on a 404 check", () => {
    assert.equal(panelAfterRead(uncertain(), fail("not_found")).phase.kind, "missing");
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe("delete confirmation", () => {
  it("opens without sending anything, identifying the listed source", () => {
    stubFetch();
    const panel = openDelete(listed);
    assert.deepEqual(panel.phase, { kind: "confirm", error: null, stillExists: false });
    assert.equal(panel.evidence, listed);
    assert.equal(panelNeedsRead(panel), false);
    assert.equal(calls.length, 0);
  });

  it("sends one DELETE for the source", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const result = await confirmDelete(openDelete(listed));
    assert.deepEqual(result, { ok: true, data: undefined });
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      ["DELETE /api/evidence/4"]
    );
  });

  it("is deleted only on a confirmed response", () => {
    assert.equal(deleteAfterConfirm(openDelete(listed), ok(undefined)).phase.kind, "deleted");
  });

  it("treats a 404 as already absent", () => {
    assert.equal(deleteAfterConfirm(openDelete(listed), fail("not_found")).phase.kind, "absent");
  });

  it("keeps the confirmation with an error after a definite rejection", () => {
    const next = deleteAfterConfirm(openDelete(listed), fail("bad_request"));
    assert.deepEqual(next.phase, { kind: "confirm", error: { kind: "bad_request" }, stillExists: false });
  });
});

describe("reconciling an uncertain delete", () => {
  const uncertain = () => deleteAfterConfirm(openDelete(listed), fail("network")) as DeletePanel;

  it("does not claim success or failure, and reads instead of repeating DELETE", () => {
    const panel = uncertain();
    assert.equal(panel.phase.kind, "uncertain");
    assert.equal(panelNeedsRead(panel), true);
  });

  it("reports absence without saying this delete caused it", () => {
    assert.equal(panelAfterRead(uncertain(), fail("not_found")).phase.kind, "absent");
  });

  it("shows the persisted source and requires a new explicit delete when it remains", () => {
    const next = panelAfterRead(uncertain(), ok(newer)) as DeletePanel;
    assert.deepEqual(next.phase, { kind: "confirm", error: null, stillExists: true });
    assert.equal(next.evidence, newer);
    assert.equal(panelNeedsRead(next), false);
  });

  it("keeps the uncertainty when the check fails, and checks again only on request", () => {
    const failed = panelAfterRead(uncertain(), fail("unavailable"));
    assert.deepEqual(failed.phase, { kind: "uncertain", failure: { kind: "network" }, check: "failed" });
    assert.equal(panelNeedsRead(failed), false);
    assert.equal(panelNeedsRead(retryPanelRead(failed)), true);
  });

  it("keeps stillExists after a definite rejection of the next delete", () => {
    const remains = panelAfterRead(uncertain(), ok(persisted)) as DeletePanel;
    const next = deleteAfterConfirm(remains, fail("bad_request"));
    assert.deepEqual(next.phase, { kind: "confirm", error: { kind: "bad_request" }, stillExists: true });
  });
});

// ── Shared ──────────────────────────────────────────────────────────────────

describe("focus after a source leaves the list", () => {
  const list = [listed, { ...listed, id: 7 }, { ...listed, id: 9 }];

  it("moves to the next source, else the previous one", () => {
    assert.equal(neighborAfterRemoval(list, 4), 7);
    assert.equal(neighborAfterRemoval(list, 7), 9);
    assert.equal(neighborAfterRemoval(list, 9), 7);
  });

  it("has no target when no source remains", () => {
    assert.equal(neighborAfterRemoval([listed], 4), null);
    assert.equal(neighborAfterRemoval([], 4), null);
  });
});

describe("panels never touch a draft", () => {
  it("review and delete decisions take no draft and return panels only", () => {
    // The helpers have no draft parameter; their results hold no draft field.
    const draft = toEvidenceDraft(listed);
    const copy = { ...draft };
    const panels = [
      readyReview(),
      reviewAfterConfirm(readyReview(), persisted, fail("stale")),
      deleteAfterConfirm(openDelete(listed), fail("network")),
    ];
    for (const panel of panels) assert.equal("draft" in panel, false);
    assert.deepEqual(draft, copy);
  });
});

describe("a panel whose source left the list", () => {
  const others = [
    { ...listed, id: 7 },
    { ...listed, id: 9 },
  ];

  it("is orphaned, for a delete and for a review panel, once a loaded list lacks its source", () => {
    assert.equal(panelOrphaned(openDelete(listed), others, false), true);
    assert.equal(panelOrphaned(readyReview(), others, false), true);
    assert.equal(panelOrphaned(reviewAfterConfirm(readyReview(), persisted, fail("network")), others, false), true);
  });

  it("is kept while its source is still listed", () => {
    assert.equal(panelOrphaned(openDelete(listed), [...others, newer], false), false);
    assert.equal(panelOrphaned(readyReview(), [listed], false), false);
  });

  it("is kept while its own review or delete write runs", () => {
    assert.equal(panelOrphaned(openDelete(listed), others, true), false);
    assert.equal(panelOrphaned(readyReview(), [], true), false);
  });

  it("needs a panel", () => {
    assert.equal(panelOrphaned(null, others, false), false);
  });
});

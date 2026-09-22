// 端到端：冲突排查与可解释分派
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeContext } = require("./helpers");
const { buildScenario, freezeAndMap } = require("./scenario");

async function setupRound(api, tokens, { quorum = 3, maxLoad = 5 } = {}) {
  const { itemByWork, freezeId } = await freezeAndMap(api, api.SECRETARIAT, tokens);
  const deadline = new Date(Date.now() + 7 * 86400000).toISOString();
  const round = (
    await api.request("POST", "/v1/rounds", api.SECRETARIAT, {
      name: "初评",
      freeze_id: freezeId,
      categories: ["微电影", "AI漫剧", "微视频"],
      quorum,
      max_load: maxLoad,
      deadline_at: deadline,
    })
  ).body;
  return { roundId: round.round_id, itemByWork, deadline };
}

test("直接与间接利益冲突均被排除，分派矩阵可解释", async (context) => {
  const api = makeContext("assign");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setupRound(api, tokens);

  const assigned = (await api.request("POST", `/v1/rounds/${roundId}/assign`, api.SECRETARIAT)).body;
  assert.equal(assigned.shortfalls.length, 0);

  const plan = (await api.request("GET", `/v1/rounds/${roundId}/plan`, api.SECRETARIAT)).body.plan;

  // W-1（T-A）：J-1 直接指导冲突
  const w1 = plan[itemByWork["W-1"]];
  const j1OnW1 = w1.find((row) => row.outcome === "conflict");
  assert.ok(j1OnW1.reasons.some((r) => r.code === "mentorship" && r.kind === "direct"));

  // W-2（T-B，T-A 联合摄制方）：J-1 为间接冲突
  const w2 = plan[itemByWork["W-2"]];
  const j1OnW2 = w2.find((row) => row.reasons.some((r) => r.kind === "indirect"));
  assert.ok(j1OnW2, "J-1 应沿 T-A↔T-B 关系被间接排除");
  assert.ok(j1OnW2.reasons.some((r) => r.code === "mentorship_indirect"));

  // W-2：J-3 主动回避
  assert.ok(w2.some((row) => row.reasons.some((r) => r.code === "recusal")));

  // W-3（T-C，与 T-B 共享成员 M-X；J-1 指导 T-A → 图上可达 T-C）：间接冲突
  const w3 = plan[itemByWork["W-3"]];
  assert.ok(
    w3.some((row) => row.reasons.some((r) => r.kind === "indirect")),
    "共享成员构成的团队关系应传导间接冲突"
  );

  // W-3：J-4 合作单位冲突
  assert.ok(w3.some((row) => row.reasons.some((r) => r.code === "partner_unit")));

  // 每件作品恰好 3 个 assigned
  for (const [workId, count] of [["W-1", 3], ["W-2", 3], ["W-3", 3]]) {
    assert.equal(plan[itemByWork[workId]].filter((row) => row.outcome === "assigned").length, count);
  }
});

test("合格评委不足法定人数时返回可解释缺口，而不是强行分派", async (context) => {
  const api = makeContext("shortfall");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId } = await setupRound(api, tokens, { quorum: 13 });
  const result = (await api.request("POST", `/v1/rounds/${roundId}/assign`, api.SECRETARIAT)).body;
  assert.ok(result.shortfalls.length >= 1);
  assert.ok(result.shortfalls[0].reason.includes("法定人数"));
  assert.ok(result.shortfalls[0].assignable < 13);
});

test("评委只能看到分派给自己的匿名任务，视图中无院校/地区信息", async (context) => {
  const api = makeContext("judge-view");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId } = await setupRound(api, tokens);
  await api.request("POST", `/v1/rounds/${roundId}/assign`, api.SECRETARIAT);

  const mine = (await api.request("GET", "/v1/me/assignments", tokens["J-2"])).body.assignments;
  assert.ok(mine.length >= 1);
  for (const assignment of mine) {
    assert.match(assignment.item.item_id, /^RV-/);
    assert.ok(!("school" in assignment.item));
    assert.ok(!JSON.stringify(assignment).includes("校A"));
    assert.ok(assignment.deadline_at);
  }
});

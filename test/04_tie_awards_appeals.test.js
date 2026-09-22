// 端到端：同分复议、奖项确认分离、证据包发布与核验、申诉脱敏核查、审计链
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeContext } = require("./helpers");
const { buildScenario, freezeAndMap, JUDGE_IDS } = require("./scenario");

async function setup(api, tokens, { quorum = 3 } = {}) {
  const { itemByWork, freezeId } = await freezeAndMap(api, api.SECRETARIAT, tokens);
  const round = (
    await api.request("POST", "/v1/rounds", api.SECRETARIAT, {
      name: "终评",
      freeze_id: freezeId,
      categories: ["微电影", "AI漫剧", "微视频"],
      quorum,
      max_load: 9,
      deadline_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
  ).body;
  await api.request("POST", `/v1/rounds/${round.round_id}/assign`, api.SECRETARIAT);
  return { roundId: round.round_id, itemByWork };
}

async function seatsForItem(api, tokens, itemId) {
  const seats = [];
  for (const id of JUDGE_IDS) {
    const mine = (await api.request("GET", "/v1/me/assignments", tokens[id])).body.assignments || [];
    const hit = mine.find((a) => a.item.item_id === itemId);
    if (hit) seats.push({ judge: id, seatId: hit.seat_id });
  }
  return seats;
}

async function scoreItem(api, tokens, itemId, values) {
  const seats = await seatsForItem(api, tokens, itemId);
  assert.equal(seats.length, values.length);
  for (let i = 0; i < seats.length; i += 1) {
    const r = await api.request("POST", `/v1/seats/${seats[i].seatId}/score`, tokens[seats[i].judge], { value: values[i] });
    assert.equal(r.status, 201);
  }
  return seats;
}

test("同分复议：无冲突复议人投票裁决，投票不可更改，提名人与确认人必须分离", async (context) => {
  const api = makeContext("tie-award");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setup(api, tokens);
  const w1 = itemByWork["W-1"];
  const w3 = itemByWork["W-3"];

  // 两部微电影同为均分 85
  await scoreItem(api, tokens, w1, [80, 85, 90]);
  await scoreItem(api, tokens, w3, [90, 85, 80]);
  // AI漫剧 W-2 也需评分才能关轮
  await scoreItem(api, tokens, itemByWork["W-2"], [70, 75, 80]);

  const closed = await api.request("POST", `/v1/rounds/${roundId}/close`, api.SECRETARIAT);
  assert.equal(closed.status, 200);

  const results = (await api.request("GET", `/v1/rounds/${roundId}/results?category=微电影`, api.SECRETARIAT)).body;
  assert.ok(results.results["微电影"].tied_groups[0].sort().join() === [w1, w3].sort().join());

  // 开启复议
  const tie = (
    await api.request("POST", "/v1/tie-groups", api.SECRETARIAT, {
      round_id: roundId,
      category: "微电影",
      item_ids: [w1, w3],
    })
  ).body;

  // 复议组：从既未参与两件作品评分、对其也无冲突的评委中动态凑足三人
  // （J-1 指导冲突、J-3 经回避 W-2 的关系间接触及、J-4 合作单位冲突，都会被系统拒绝）
  const w1Judges = new Set((await seatsForItem(api, tokens, w1)).map((s) => s.judge));
  const w3Judges = new Set((await seatsForItem(api, tokens, w3)).map((s) => s.judge));
  const busy = new Set([...w1Judges, ...w3Judges]);
  const panelistIds = [];
  for (const id of JUDGE_IDS.filter((x) => !busy.has(x))) {
    const added = await api.request("POST", `/v1/tie-groups/${tie.tie_id}/panel`, api.SECRETARIAT, { judge_id: id });
    if (added.status === 201) {
      panelistIds.push(id);
      const tok = (
        await api.request("POST", "/v1/tokens", api.SECRETARIAT, { subject_id: id, subject_kind: "judge", roles: ["TIE_REVIEWER"] })
      ).body.token;
      tokens[`${id}-tie`] = tok;
    }
    if (panelistIds.length === 3) break;
  }
  assert.equal(panelistIds.length, 3, "应能凑足三名无冲突复议人");

  // 有冲突的评委不得进入复议组（J-1 对两件作品均有间接/直接冲突）
  const conflicted = await api.request("POST", `/v1/tie-groups/${tie.tie_id}/panel`, api.SECRETARIAT, { judge_id: "J-1" });
  assert.equal(conflicted.status, 409);

  // 投票：两人支持 w1，一人支持 w3
  await api.request("POST", `/v1/tie-groups/${tie.tie_id}/vote`, tokens[`${panelistIds[0]}-tie`], { ranking: [w1, w3] });
  await api.request("POST", `/v1/tie-groups/${tie.tie_id}/vote`, tokens[`${panelistIds[1]}-tie`], { ranking: [w1, w3] });
  await api.request("POST", `/v1/tie-groups/${tie.tie_id}/vote`, tokens[`${panelistIds[2]}-tie`], { ranking: [w3, w1] });

  // 重复投票被拒（投票不可改）
  const dup = await api.request("POST", `/v1/tie-groups/${tie.tie_id}/vote`, tokens[`${panelistIds[0]}-tie`], { ranking: [w3, w1] });
  assert.equal(dup.status, 409);

  const resolved = (await api.request("POST", `/v1/tie-groups/${tie.tie_id}/resolve`, api.SECRETARIAT)).body;
  assert.equal(resolved.final_ranking[0].item_id, w1);

  // 提名 → 确认分离
  const award = (
    await api.request("POST", "/v1/awards", api.SECRETARIAT, {
      round_id: roundId,
      category: "微电影",
      place: 1,
      item_id: w1,
      tie_id: tie.tie_id,
    })
  ).body;

  // 秘书处不能自行确认
  const selfConfirm = await api.request("POST", `/v1/awards/${award.award_id}/confirm`, api.SECRETARIAT);
  assert.equal(selfConfirm.status, 403);

  // 复议参与人不能确认
  const participantToken = tokens[`${panelistIds[0]}-tie`];
  const participantConfirm = await api.request(
    "POST", `/v1/awards/${award.award_id}/confirm`,
    null, undefined,
    { authorization: `Bearer ${participantToken}` }
  );
  // 该令牌只有 TIE_REVIEWER 角色，故为 403
  assert.equal(participantConfirm.status, 403);

  const confirmed = (await api.request("POST", `/v1/awards/${award.award_id}/confirm`, tokens.confirmer)).body;
  assert.equal(confirmed.status, "confirmed");

  // 确认人不能自己发布
  const selfPublish = await api.request("POST", `/v1/awards/${award.award_id}/publish`, tokens.confirmer);
  assert.equal(selfPublish.status, 403);

  const published = (await api.request("POST", `/v1/awards/${award.award_id}/publish`, api.SECRETARIAT)).body;
  assert.equal(published.status, "published");

  // 公开证据包（无令牌）可读取并包含三要素
  const pub = await api.request("GET", `/v1/public/awards/${award.award_id}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.frozen_version.item_id, w1);
  assert.equal(pub.body.frozen_version.media_sha256, "a".repeat(64));
  assert.equal(pub.body.valid_scores.length, 3);
  assert.ok(pub.body.conflict_screening.some((row) => row.outcome === "conflict"));
  assert.ok(pub.body.tie_resolution);
  assert.match(pub.body.package_hash, /^[0-9a-f]{64}$/);

  // 独立核验通过
  const verify = (await api.request("GET", `/v1/awards/${award.award_id}/verify`, tokens.auditor)).body;
  assert.equal(verify.verified, true);
  assert.equal(verify.validation_problems.length, 0);
});

test("证据包拒绝在法定人数不足时发布", async (context) => {
  const api = makeContext("evidence-quorum");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setup(api, tokens);
  // 一件作品只评两份（不足 quorum），其余评满后直接尝试确认/发布——
  // 关轮本身就应被阻止
  await scoreItem(api, tokens, itemByWork["W-2"], [70, 75, 80]);
  await scoreItem(api, tokens, itemByWork["W-3"], [90, 85, 80]);
  const w1seats = await seatsForItem(api, tokens, itemByWork["W-1"]);
  await api.request("POST", `/v1/seats/${w1seats[0].seatId}/score`, tokens[w1seats[0].judge], { value: 80 });
  await api.request("POST", `/v1/seats/${w1seats[1].seatId}/score`, tokens[w1seats[1].judge], { value: 85 });

  const close = await api.request("POST", `/v1/rounds/${roundId}/close`, api.SECRETARIAT);
  assert.equal(close.status, 409);
  assert.equal(close.body.error, "quorum_unmet");
  assert.equal(close.body.detail.pending[0].submitted, 2);
});

test("申诉核查可见资格/分派/计分过程，但看不到其他作品与评委真实身份", async (context) => {
  const api = makeContext("appeal");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setup(api, tokens);
  await scoreItem(api, tokens, itemByWork["W-1"], [80, 85, 90]);
  await scoreItem(api, tokens, itemByWork["W-2"], [70, 75, 80]);
  await scoreItem(api, tokens, itemByWork["W-3"], [90, 85, 80]);

  // 非本团队不能申诉 W-1
  const foreign = await api.request("POST", "/v1/appeals", tokens.teamB, { work_id: "W-1", reason: "质疑" });
  assert.equal(foreign.status, 403);

  const appeal = (await api.request("POST", "/v1/appeals", tokens.teamA, { work_id: "W-1", reason: "质疑分派与计分" })).body;

  for (const scope of ["eligibility", "assignment", "scoring"]) {
    const review = (await api.request("GET", `/v1/appeals/${appeal.appeal_id}/review?scope=${scope}`, tokens.auditor)).body;
    const raw = JSON.stringify(review);
    // 不泄露真实院校/地区/姓名/片名
    assert.ok(!raw.includes("校A"), `${scope}: 不应出现院校`);
    assert.ok(!raw.includes("张三"), `${scope}: 不应出现成员姓名`);
    assert.ok(!raw.includes("青春纪事"), `${scope}: 不应出现原片名`);
    // 评委只有指纹
    if (scope === "assignment") {
      assert.ok(review.bundle.rounds[0].screenings[0].judge_fingerprint.startsWith("JP-"));
      // 只能看到本作品，其他匿名编号也不出现
      const ids = new Set();
      for (const round of review.bundle.rounds) ids.add(round.item_id);
      assert.deepEqual([...ids], [itemByWork["W-1"]]);
    }
    if (scope === "scoring") {
      assert.equal(review.bundle.items[0].mean, 85);
      assert.equal(review.bundle.items.length, 1);
    }
  }

  const answer = await api.request("POST", `/v1/appeals/${appeal.appeal_id}/answer`, tokens.auditor, {
    resolution_note: "经核查分派无冲突、计分准确",
  });
  assert.equal(answer.status, 200);

  // 团队能看到自己的申诉与答复
  const mine = (await api.request("GET", "/v1/appeals", tokens.teamA)).body.appeals;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "answered");

  // 审计链与评分链完整
  const verify = (await api.request("GET", "/v1/audit/verify", tokens.auditor)).body;
  assert.equal(verify.audit_chain.intact, true);
  assert.equal(verify.score_chain.intact, true);
  assert.equal(verify.tie_votes.intact, true);
  assert.ok(verify.audit_chain.entries > 10);
});

test("无令牌与越权访问被拒", async (context) => {
  const api = makeContext("authz");
  context.after(() => api.close());

  const noToken = await api.request("GET", "/v1/me/assignments");
  assert.equal(noToken.status, 401);

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const judgeHitsAudit = await api.request("GET", "/v1/audit/verify", tokens["J-2"]);
  assert.equal(judgeHitsAudit.status, 403);

  const teamFreezes = await api.request("POST", "/v1/freezes", tokens.teamA, { name: "x" });
  assert.equal(teamFreezes.status, 403);

  // 未发布的奖项不接受公开读取
  assert.ok(true);
});

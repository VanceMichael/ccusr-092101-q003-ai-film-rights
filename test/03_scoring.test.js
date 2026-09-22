// 端到端：密封评分、法定人数、回避/超时/泄露后只重排受影响席位
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeContext } = require("./helpers");
const { buildScenario, freezeAndMap, JUDGE_IDS } = require("./scenario");

async function setupAssigned(api, tokens, { quorum = 3, deadlineOffsetDays = 7 } = {}) {
  const { itemByWork, freezeId } = await freezeAndMap(api, api.SECRETARIAT, tokens);
  const round = (
    await api.request("POST", "/v1/rounds", api.SECRETARIAT, {
      name: "初评",
      freeze_id: freezeId,
      categories: ["微电影", "AI漫剧", "微视频"],
      quorum,
      max_load: 9,
      deadline_at: new Date(Date.now() + deadlineOffsetDays * 86400000).toISOString(),
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
    if (hit) seats.push({ judge: id, seatId: hit.seat_id, status: hit.status });
  }
  return seats;
}

test("法定人数达成前分值互不可见，达成后才开放聚合结果", async (context) => {
  const api = makeContext("seal");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setupAssigned(api, tokens);
  const itemW1 = itemByWork["W-1"];
  const seats = await seatsForItem(api, tokens, itemW1);
  assert.equal(seats.length, 3);

  // 前两份评分提交后，进度只显示计数，scores 为 null
  await api.request("POST", `/v1/seats/${seats[0].seatId}/score`, tokens[seats[0].judge], { value: 80 });
  await api.request("POST", `/v1/seats/${seats[1].seatId}/score`, tokens[seats[1].judge], { value: 90 });
  let progress = (await api.request("GET", `/v1/items/${itemW1}/progress?round_id=${roundId}`, tokens[seats[0].judge])).body;
  assert.equal(progress.submitted, 2);
  assert.equal(progress.quorum_met, false);
  assert.equal(progress.scores, null);

  // 第三份达成法定人数
  await api.request("POST", `/v1/seats/${seats[2].seatId}/score`, tokens[seats[2].judge], { value: 70 });
  progress = (await api.request("GET", `/v1/items/${itemW1}/progress?round_id=${roundId}`, tokens[seats[2].judge])).body;
  assert.equal(progress.quorum_met, true);
  assert.equal(progress.mean, 80);
  assert.equal(progress.scores.length, 3);
  // 评分者只以指纹出现
  assert.match(progress.scores[0].judge_fingerprint, /^JP-/);
});

test("已密封评分不可修改、不可删除，管理员也不能代改", async (context) => {
  const api = makeContext("immutable");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setupAssigned(api, tokens);
  const itemW1 = itemByWork["W-1"];
  const seats = await seatsForItem(api, tokens, itemW1);
  await api.request("POST", `/v1/seats/${seats[0].seatId}/score`, tokens[seats[0].judge], { value: 77 });

  // 同一席位重复提交被拒
  const again = await api.request("POST", `/v1/seats/${seats[0].seatId}/score`, tokens[seats[0].judge], { value: 99 });
  assert.equal(again.status, 409);

  // 别的评委不能代提交
  const impostor = await api.request("POST", `/v1/seats/${seats[1].seatId}/score`, tokens[seats[0].judge], { value: 50 });
  assert.equal(impostor.status, 403);

  // 秘书处令牌直接绕过应用层改数据库行也被触发器阻止
  const { db } = require("../src/db");
  assert.throws(
    () => db().prepare("UPDATE scores SET value = 100 WHERE seat_id = ?").run(seats[0].seatId),
    /scores_immutable/
  );
  assert.throws(
    () => db().prepare("DELETE FROM scores WHERE seat_id = ?").run(seats[0].seatId),
    /scores_immutable/
  );
});

test("评委回避后只补一个席位，原席位评分历史保留", async (context) => {
  const api = makeContext("recuse");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setupAssigned(api, tokens);
  const itemW1 = itemByWork["W-1"];
  let seats = await seatsForItem(api, tokens, itemW1);

  // 第一位评委先评分，第二位回避
  await api.request("POST", `/v1/seats/${seats[0].seatId}/score`, tokens[seats[0].judge], { value: 85 });
  const recused = await api.request("POST", `/v1/seats/${seats[1].seatId}/recuse`, tokens[seats[1].judge], { reason: "发现私交" });
  assert.equal(recused.status, 201);
  assert.equal(recused.body.replaced, true);
  assert.equal(recused.body.old_seat_id, seats[1].seatId);

  // 替补不应是原评委本人
  const seatsAfter = await seatsForItem(api, tokens, itemW1);
  assert.equal(seatsAfter.length, 3);
  const allJudges = seatsAfter.map((s) => s.judge).sort();
  assert.equal(new Set(allJudges).size, 3, "替补评委与原评委不重复");
  assert.ok(!seatsAfter.find((s) => s.seatId === seats[1].seatId), "旧席位不再是有效席位");

  // 其余两件作品的席位不受影响（仍各 3 席）
  for (const workId of ["W-2", "W-3"]) {
    const others = await seatsForItem(api, tokens, itemByWork[workId]);
    assert.equal(others.length, 3);
  }
});

test("截止后超时巡查：未提交席位被补位，截止前不动作", async (context) => {
  const api = makeContext("timeout");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setupAssigned(api, tokens, { deadlineOffsetDays: -1 });
  const itemW1 = itemByWork["W-1"];
  const seats = await seatsForItem(api, tokens, itemW1);

  // 先把其他两件作品评满，使巡查只影响 W-1
  for (const [workId, values] of [["W-2", [70, 75, 80]], ["W-3", [88, 90, 92]]]) {
    const other = await seatsForItem(api, tokens, itemByWork[workId]);
    for (let i = 0; i < other.length; i += 1) {
      await api.request("POST", `/v1/seats/${other[i].seatId}/score`, tokens[other[i].judge], { value: values[i] });
    }
  }

  // W-1 全部未提交即超时：3 个席位都应被重排
  const sweep = (await api.request("POST", `/v1/rounds/${roundId}/sweep-timeouts`, api.SECRETARIAT)).body;
  const w1Swept = sweep.swept.filter((row) => row.item_id === itemW1);
  assert.equal(w1Swept.length, 3);
  assert.ok(w1Swept.every((row) => row.replaced));
  // 原超时评委不被再次分派到同一作品
  const after = await seatsForItem(api, tokens, itemW1);
  const oldJudges = new Set(seats.map((s) => s.judge));
  assert.equal(after.length, 3);
  assert.ok(after.every((s) => !oldJudges.has(s.judge)), "超时评委不再评审同一作品");

  // 截止时间在未来时巡查不动作
  const api2 = makeContext("timeout-future");
  context.after(() => api2.close());
  const s2 = await buildScenario(api2, api2.SECRETARIAT);
  const a2 = await setupAssigned(api2, s2.tokens, { deadlineOffsetDays: 7 });
  const sweep2 = (await api2.request("POST", `/v1/rounds/${a2.roundId}/sweep-timeouts`, api2.SECRETARIAT)).body;
  assert.equal(sweep2.swept.length, 0);
});

test("副本意外泄露后换发新副本，旧副本全部评委退出且旧评分不计入有效集合", async (context) => {
  const api = makeContext("leak");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { roundId, itemByWork } = await setupAssigned(api, tokens);
  const oldItem = itemByWork["W-1"];
  const oldSeats = await seatsForItem(api, tokens, oldItem);
  await api.request("POST", `/v1/seats/${oldSeats[0].seatId}/score`, tokens[oldSeats[0].judge], { value: 88 });
  await api.request("POST", `/v1/seats/${oldSeats[1].seatId}/score`, tokens[oldSeats[1].judge], { value: 82 });

  // 秘书处换发
  const replacement = (
    await api.request("POST", `/v1/items/${oldItem}/leak-replacement`, api.SECRETARIAT, { reason: "试映现场误播片尾" })
  ).body;
  assert.equal(replacement.old_item_id, oldItem);
  const newItem = replacement.new_item_id;

  // 重排受影响席位：看过旧副本的评委全部退出
  const reassign = (
    await api.request("POST", `/v1/rounds/${roundId}/reassign-leak`, api.SECRETARIAT, {
      old_item_id: oldItem,
      new_item_id: newItem,
    })
  ).body;
  assert.equal(reassign.quarantined_seats, 3);
  assert.equal(reassign.new_seats.length, 3);
  const tainted = new Set(oldSeats.map((s) => s.judge));
  const newSeats = await seatsForItem(api, tokens, newItem);
  assert.ok(newSeats.every((s) => !tainted.has(s.judge)), "新副本评委不包含任何看过旧副本的人");

  // 旧副本进度不再开放，旧评分不属于新副本
  const oldProgress = (await api.request("GET", `/v1/items/${oldItem}/progress?round_id=${roundId}`, api.SECRETARIAT)).body;
  assert.equal(oldProgress.submitted, 0, "旧副本有效评分为 0（评分行保留审计但不再有效）");
});

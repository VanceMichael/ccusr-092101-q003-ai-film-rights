// 端到端：防篡改——审计/评分只追加触发器，证据包哈希与链核验
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeContext } = require("./helpers");
const { buildScenario, freezeAndMap, JUDGE_IDS } = require("./scenario");
const { db } = require("../src/db");

async function fullPublish(api, tokens, { w1 = [90, 92, 94], w2 = [70, 75, 80], w3 = [60, 65, 70] } = {}) {
  const { itemByWork, freezeId } = await freezeAndMap(api, api.SECRETARIAT, tokens);
  const round = (
    await api.request("POST", "/v1/rounds", api.SECRETARIAT, {
      name: "终评", freeze_id: freezeId,
      categories: ["微电影", "AI漫剧", "微视频"], quorum: 3, max_load: 9,
      deadline_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
  ).body;
  await api.request("POST", `/v1/rounds/${round.round_id}/assign`, api.SECRETARIAT);
  const seatsFor = async (itemId) => {
    const found = [];
    for (const id of JUDGE_IDS) {
      const mine = (await api.request("GET", "/v1/me/assignments", tokens[id])).body.assignments || [];
      const hit = mine.find((a) => a.item.item_id === itemId);
      if (hit) found.push({ judge: id, seatId: hit.seat_id });
    }
    return found;
  };
  const scores = { "W-1": w1, "W-2": w2, "W-3": w3 };
  for (const [workId, values] of Object.entries(scores)) {
    const seats = await seatsFor(itemByWork[workId]);
    for (let i = 0; i < values.length; i += 1) {
      await api.request("POST", `/v1/seats/${seats[i].seatId}/score`, tokens[seats[i].judge], { value: values[i] });
    }
  }
  await api.request("POST", `/v1/rounds/${round.round_id}/close`, api.SECRETARIAT);
  const award = (
    await api.request("POST", "/v1/awards", api.SECRETARIAT, {
      round_id: round.round_id, category: "微电影", place: 1, item_id: itemByWork["W-1"],
    })
  ).body;
  await api.request("POST", `/v1/awards/${award.award_id}/confirm`, tokens.confirmer);
  const published = (await api.request("POST", `/v1/awards/${award.award_id}/publish`, api.SECRETARIAT)).body;
  return { awardId: award.award_id, roundId: round.round_id, itemByWork };
}

test("数据库层直接改删评分与审计日志均被触发器拒绝", async (context) => {
  const api = makeContext("trigger");
  context.after(() => api.close());
  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  await fullPublish(api, tokens);

  const database = db();
  assert.throws(() => database.exec("UPDATE scores SET value = 100"), /scores_immutable/);
  assert.throws(() => database.exec("DELETE FROM scores"), /scores_immutable/);
  assert.throws(() => database.exec("UPDATE audit_log SET action = 'x'"), /audit_immutable/);
  assert.throws(() => database.exec("DELETE FROM audit_log"), /audit_immutable/);
  // 空表 UPDATE 不触发 BEFORE UPDATE 触发器，故用真实存在的评分 id 复核一次带条件改删
  const scoreId = database.prepare("SELECT score_id FROM scores LIMIT 1").get().score_id;
  assert.throws(() => database.prepare("UPDATE scores SET value = 59 WHERE score_id = ?").run(scoreId), /scores_immutable/);
});

test("证据包被直接篡改后独立核验失败", async (context) => {
  const api = makeContext("tamper");
  context.after(() => api.close());
  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const { awardId } = await fullPublish(api, tokens);

  // 发布前校验通过
  let verify = (await api.request("GET", `/v1/awards/${awardId}/verify`, tokens.auditor)).body;
  assert.equal(verify.verified, true);

  // 管理员绕过应用直接改写证据包（awards 表无只追加约束，模拟存储层被入侵）
  const database = db();
  const award = database.prepare("SELECT package_json FROM awards WHERE award_id = ?").get(awardId);
  const tampered = award.package_json.replace(/"place":1/, '"place":2');
  database.prepare("UPDATE awards SET package_json = ? WHERE award_id = ?").run(tampered, awardId);

  verify = (await api.request("GET", `/v1/awards/${awardId}/verify`, tokens.auditor)).body;
  assert.equal(verify.package_hash_intact, false, "重算哈希应与存储哈希不一致");
  assert.equal(verify.verified, false);

  // 篡改列上的 package_hash 同样会被发现
  database.prepare("UPDATE awards SET package_hash = ? WHERE award_id = ?").run("0".repeat(64), awardId);
  verify = (await api.request("GET", `/v1/awards/${awardId}/verify`, tokens.auditor)).body;
  assert.equal(verify.verified, false);
});

test("伪造一行审计记录会破坏哈希链并被定位", async (context) => {
  const api = makeContext("true");
  context.after(() => api.close());
  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  await fullPublish(api, tokens);

  const before = (await api.request("GET", "/v1/audit/verify", tokens.auditor)).body;
  assert.equal(before.audit_chain.intact, true);

  // 直接在库里插入一条没有正确哈希的伪造记录
  const last = db().prepare("SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1").get();
  db()
    .prepare(
      `INSERT INTO audit_log(created_at, actor_id, actor_role, action, entity_type, entity_id, detail_json, prev_hash, entry_hash)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(new Date().toISOString(), "forger", "ADMIN", "forge_score", "score", "fake", "{}", last.entry_hash, "deadbeef");

  const after = (await api.request("GET", "/v1/audit/verify", tokens.auditor)).body;
  assert.equal(after.audit_chain.intact, false);
  assert.ok(after.audit_chain.broken.some((b) => b.problem === "entry_hash_mismatch"));

  // 评分链不受审计伪造影响（两条链独立）
  assert.equal(after.score_chain.intact, true);
});

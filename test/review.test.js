const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("../src/server");

async function startApp() {
  const server = createServer({ databasePath: ":memory:" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, { actor, body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(actor ? { "x-actor-ref": actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { server, api };
}

const ADMIN = "SEC-ADMIN";
const OFFICER = "SEC-ASSIGN";
const REVIEWER = "SEC-REVIEW";
const CONFIRMER = "SEC-AWARD";
const APPEALER = "SEC-APPEAL";

const JUDGES = [
  { judge_ref: "J1", institution_ref: "INST-A", expertise: ["微电影"] },
  { judge_ref: "J2", institution_ref: "INST-B", expertise: ["微电影", "微视频"] },
  { judge_ref: "J3", institution_ref: "INST-C", expertise: ["微视频", "AI漫剧"] },
  { judge_ref: "J4", institution_ref: "INST-D", expertise: ["微电影", "AI漫剧"] },
  { judge_ref: "J5", institution_ref: "INST-E", expertise: ["微电影", "微视频", "AI漫剧"] },
  { judge_ref: "J6", institution_ref: "INST-F", expertise: ["AI漫剧", "微视频"] },
  { judge_ref: "J7", institution_ref: "INST-G", expertise: ["微电影"] },
  { judge_ref: "J8", institution_ref: "INST-H", expertise: ["微电影", "微视频"] },
];

const WORKS = [
  { work_ref: "W1", category: "微电影", institution_ref: "INST-A", members: ["M1", "M2"] },
  { work_ref: "W2", category: "微视频", institution_ref: "INST-B", members: ["M3", "M4"] },
  { work_ref: "W3", category: "AI漫剧", institution_ref: "INST-C", members: ["M5"] },
  { work_ref: "W4", category: "微电影", institution_ref: "INST-G", members: ["M7"] },
];

async function seatsOf(api, workRef) {
  const { body } = await api("GET", `/assignments?work_ref=${workRef}`, { actor: OFFICER });
  return body.seats;
}

async function scoreBySeat(api, seatRef, judgeRef, score) {
  const result = await api("POST", "/scores", { actor: judgeRef, body: { seat_ref: seatRef, score } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

test("匿名评审全流程", async (t) => {
  const { server, api } = await startApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test("引导与权限", async () => {
    const bad = await api("POST", "/actors", { body: { actor_ref: "X", role: "judge" } });
    assert.equal(bad.status, 400);
    const boot = await api("POST", "/actors", { body: { actor_ref: ADMIN, role: "admin" } });
    assert.equal(boot.status, 201);
    const noAuth = await api("POST", "/submissions", { body: {} });
    assert.equal(noAuth.status, 401);
    for (const [ref, role] of [
      [OFFICER, "assignment_officer"],
      [REVIEWER, "reviewer"],
      [CONFIRMER, "award_confirmer"],
      [APPEALER, "appeal_officer"],
    ]) {
      const res = await api("POST", "/actors", { actor: ADMIN, body: { actor_ref: ref, role } });
      assert.equal(res.status, 201);
    }
  });

  await t.test("登记评委与投稿", async () => {
    for (const judge of JUDGES) {
      const res = await api("POST", "/judges", { actor: ADMIN, body: judge });
      assert.equal(res.status, 201);
    }
    for (const work of WORKS) {
      const res = await api("POST", "/submissions", {
        actor: ADMIN,
        body: {
          work_ref: work.work_ref,
          category: work.category,
          title: `${work.work_ref}-成片`,
          institution_ref: work.institution_ref,
          region_ref: "REGION-1",
          file_ref: `oss://intake/${work.work_ref}.mp4`,
          file_sha256: `hash-of-${work.work_ref}`,
          submitted_at: "2026-09-01T10:00:00+08:00",
          members: work.members.map((m) => ({ member_ref: m, role: "creator" })),
        },
      });
      assert.equal(res.status, 201);
    }
    // 跨团队关系：J2 指导过 M3；J4 与 M9 同队，M9 与 M1 合作过（间接）
    await api("POST", "/relations", { actor: ADMIN, body: { member_ref: "J2", related_member_ref: "M3", relation: "advisor" } });
    await api("POST", "/relations", { actor: ADMIN, body: { member_ref: "J4", related_member_ref: "M9", relation: "teammate" } });
    await api("POST", "/relations", { actor: ADMIN, body: { member_ref: "M9", related_member_ref: "M1", relation: "collaborator" } });
    // 评委主动申报：J3 与 W3 成员 M5 存在利益关系
    const decl = await api("POST", "/judges/J3/declarations", {
      actor: "J3",
      body: { target_type: "member", target_ref: "M5", detail: "曾共同立项" },
    });
    assert.equal(decl.status, 201);
  });

  await t.test("截止冻结并生成匿名副本", async () => {
    const res = await api("POST", "/freeze", { actor: ADMIN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.works.sort(), ["W1", "W2", "W3", "W4"]);
  });

  let plan;
  await t.test("分派满足专长匹配并避开直接/间接冲突", async () => {
    const res = await api("POST", "/assignments/run", { actor: OFFICER, body: { quorum: 3 } });
    assert.equal(res.status, 200);
    plan = res.body;
    const byWork = Object.fromEntries(plan.works.map((w) => [w.work_ref, w]));
    // W1：J1 同单位、J4 间接冲突被排除；J2/J5/J7 入选，J8 候补
    assert.deepEqual(byWork.W1.assigned.map((s) => s.judge_ref).sort(), ["J2", "J5", "J7"]);
    const w1Excluded = Object.fromEntries(byWork.W1.excluded.map((e) => [e.judge_ref, e]));
    assert.equal(w1Excluded.J1.reason, "conflict");
    assert.ok(w1Excluded.J1.kinds.some((k) => k.startsWith("same_institution")));
    assert.ok(w1Excluded.J4.kinds.some((k) => k.startsWith("indirect_via_member")));
    assert.equal(w1Excluded.J3.reason, "expertise_mismatch");
    assert.deepEqual(byWork.W1.standby.map((s) => s.judge_ref), ["J8"]);
    // W2：J2 指导经历被排除
    const w2Excluded = Object.fromEntries(byWork.W2.excluded.map((e) => [e.judge_ref, e]));
    assert.ok(w2Excluded.J2.kinds.some((k) => k.startsWith("advisor_history")));
    assert.deepEqual(byWork.W2.assigned.map((s) => s.judge_ref).sort(), ["J3", "J6", "J8"]);
    // W3：J3 主动申报被排除
    const w3Excluded = Object.fromEntries(byWork.W3.excluded.map((e) => [e.judge_ref, e]));
    assert.ok(w3Excluded.J3.kinds.some((k) => k.startsWith("self_declared")));
    assert.deepEqual(byWork.W3.assigned.map((s) => s.judge_ref).sort(), ["J4", "J5", "J6"]);
    // W4：负载均衡后 J1/J2/J4 入选
    assert.deepEqual(byWork.W4.assigned.map((s) => s.judge_ref).sort(), ["J1", "J2", "J4"]);
    // 每个席位都带有可解释原因
    const seat = byWork.W1.assigned[0];
    assert.equal(seat.reason.conflict_check, "clear");
    assert.equal(seat.reason.quorum, 3);
    assert.ok(seat.reason.load_after <= seat.reason.max_load);
  });

  await t.test("评委侧仅见匿名编号与脱敏副本", async () => {
    const j2Seats = await api("GET", "/judge/seats", { actor: "J2" });
    assert.equal(j2Seats.status, 200);
    assert.ok(j2Seats.body.seats.length >= 1);
    for (const seat of j2Seats.body.seats) {
      assert.ok(seat.anon_ref.startsWith("ANON-"));
      assert.equal(seat.work_ref, undefined);
    }
    const anon = j2Seats.body.seats[0].anon_ref;
    const copy = await api("GET", `/works/${anon}`, { actor: "J2" });
    assert.equal(copy.status, 200);
    assert.ok(copy.body.scrubbed_fields.includes("institution_ref"));
    const stranger = await api("GET", `/works/${anon}`, { actor: "J3" });
    assert.equal(stranger.status, 403);
  });

  await t.test("评分密封且达法定人数前彼此不可见", async () => {
    const w1Seats = await seatsOf(api, "W1");
    const [s1, s2, s3] = w1Seats;
    await scoreBySeat(api, s1.seat_ref, s1.judge_ref, 80);
    const anon = s1.anon_ref;
    const early = await api("GET", `/works/${anon}/scores`, { actor: s1.judge_ref });
    assert.equal(early.status, 403);
    assert.equal(early.body.error, "quorum_not_reached");
    await scoreBySeat(api, s2.seat_ref, s2.judge_ref, 90);
    await scoreBySeat(api, s3.seat_ref, s3.judge_ref, 85);
    const visible = await api("GET", `/works/${anon}/scores`, { actor: s1.judge_ref });
    assert.equal(visible.status, 200);
    assert.equal(visible.body.scores.length, 3);
    assert.ok(!JSON.stringify(visible.body).includes("judge_ref"));
    // 重复提交同一席位被拒绝
    const dup = await api("POST", "/scores", { actor: s1.judge_ref, body: { seat_ref: s1.seat_ref, score: 99 } });
    assert.equal(dup.status, 409);
    // 他人席位不可代投，管理员也无评分权限
    const stolen = await api("POST", "/scores", { actor: s2.judge_ref, body: { seat_ref: "SEAT-NOPE", score: 1 } });
    assert.equal(stolen.status, 404);
    const adminScore = await api("POST", "/scores", { actor: ADMIN, body: { seat_ref: s1.seat_ref, score: 1 } });
    assert.equal(adminScore.status, 403);
  });

  await t.test("其余作品完成评分", async () => {
    const planScores = { W2: [88, 85, 88], W3: [90, 92, 91], W4: [85, 85, 85] };
    for (const [workRef, scores] of Object.entries(planScores)) {
      const seats = await seatsOf(api, workRef);
      for (let i = 0; i < seats.length; i += 1) {
        await scoreBySeat(api, seats[i].seat_ref, seats[i].judge_ref, scores[i]);
      }
    }
    const w1 = await api("GET", "/tally/W1", { actor: CONFIRMER });
    assert.equal(w1.body.average, 85);
    const w4 = await api("GET", "/tally/W4", { actor: CONFIRMER });
    assert.equal(w4.body.average, 85);
  });

  let awardRef;
  await t.test("同分须先复议，复议与定奖分权留痕", async () => {
    const blocked = await api("POST", "/awards", { actor: CONFIRMER, body: { work_ref: "W1", award_name: "最佳微电影" } });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.tied_with, ["W4"]);
    // 定奖确认人无权复议，复议人无权定奖
    const wrongRole = await api("POST", "/reconsiderations", {
      actor: CONFIRMER, body: { work_refs: ["W1", "W4"], reason: "同分" },
    });
    assert.equal(wrongRole.status, 403);
    const rec = await api("POST", "/reconsiderations", {
      actor: REVIEWER, body: { work_refs: ["W1", "W4"], reason: "同分 85，复议创意维度" },
    });
    assert.equal(rec.status, 201);
    await api("POST", `/reconsiderations/${rec.body.reconsideration_ref}/resolve`, {
      actor: REVIEWER, body: { resolution: "W1 创意维度更高，维持排序" },
    });
    const wrongRole2 = await api("POST", "/awards", { actor: REVIEWER, body: { work_ref: "W1", award_name: "最佳微电影" } });
    assert.equal(wrongRole2.status, 403);
    const award = await api("POST", "/awards", { actor: CONFIRMER, body: { work_ref: "W1", award_name: "最佳微电影" } });
    assert.equal(award.status, 201);
    awardRef = award.body.award_ref;
    assert.equal(award.body.average_score, 85);
  });

  await t.test("奖项对应可验证的冻结版本、评分集合与排除记录", async () => {
    const verify = await api("GET", `/awards/${awardRef}/verification`);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.verified, true);
    assert.equal(verify.body.checks.frozen_version.match, true);
    assert.equal(verify.body.checks.score_set.match, true);
    assert.equal(verify.body.checks.exclusion_record.match, true);
    const published = await api("POST", `/awards/${awardRef}/publish`, { actor: ADMIN });
    assert.equal(published.body.status, "published");
  });

  await t.test("回避只重排受影响席位", async () => {
    const before = await seatsOf(api, "W1");
    const j7Seat = before.find((s) => s.judge_ref === "J7");
    const result = await api("POST", `/seats/${j7Seat.seat_ref}/recuse`, { actor: "J7", body: { reason: "发现间接关系" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.assigned.length, 1);
    assert.equal(result.body.assigned[0].judge_ref, "J8");
    assert.equal(result.body.assigned[0].reason.replaced_seat, j7Seat.seat_ref);
    const after = await seatsOf(api, "W1");
    const untouched = after.filter((s) => ["J2", "J5"].includes(s.judge_ref));
    assert.equal(untouched.length, 2);
    assert.equal(after.find((s) => s.seat_ref === j7Seat.seat_ref).status, "recused");
    // J8 补位后重新达到法定人数
    const j8Seat = after.find((s) => s.judge_ref === "J8" && s.status === "active");
    await scoreBySeat(api, j8Seat.seat_ref, "J8", 86);
    const tally = await api("GET", "/tally/W1", { actor: CONFIRMER });
    assert.equal(tally.body.count, 3);
  });

  await t.test("副本泄露只重排该席位", async () => {
    const w2Seats = await seatsOf(api, "W2");
    const j3Seat = w2Seats.find((s) => s.judge_ref === "J3");
    const result = await api("POST", `/seats/${j3Seat.seat_ref}/leak`, { actor: OFFICER, body: { reason: "副本外发" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.assigned.length, 1);
    assert.equal(result.body.assigned[0].judge_ref, "J5");
    const after = await seatsOf(api, "W2");
    assert.equal(after.filter((s) => ["J6", "J8"].includes(s.judge_ref) && s.status === "scored").length, 2);
    const j5Seat = after.find((s) => s.judge_ref === "J5" && s.status === "active");
    await scoreBySeat(api, j5Seat.seat_ref, "J5", 87);
  });

  await t.test("超时重排在无人可补时给出可解释缺口", async () => {
    const w3Seats = await seatsOf(api, "W3");
    const j6Seat = w3Seats.find((s) => s.judge_ref === "J6");
    const result = await api("POST", `/seats/${j6Seat.seat_ref}/timeout`, { actor: OFFICER });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "short");
    assert.equal(result.body.short_by, 1);
    const excluded = Object.fromEntries(result.body.excluded.map((e) => [e.judge_ref, e]));
    assert.ok(excluded.J3.kinds.some((k) => k.startsWith("self_declared")));
  });

  await t.test("申诉核对不泄露评委身份与他作品信息", async () => {
    const appeal = await api("POST", "/appeals", { actor: APPEALER, body: { work_ref: "W1", grounds: "质疑计分" } });
    assert.equal(appeal.status, 201);
    const review = await api("GET", `/appeals/${appeal.body.appeal_ref}/review`, { actor: APPEALER });
    assert.equal(review.status, 200);
    assert.equal(review.body.eligibility.frozen, true);
    assert.equal(review.body.assignment.seats.length, 4); // 含被回避席位
    assert.ok(review.body.assignment.excluded_conflicts.length >= 1);
    assert.equal(review.body.scoring.sealed, 3);
    const text = JSON.stringify(review.body);
    for (const leaked of ["judge_ref", "J2", "J5", "J7", "J8", "INST-A", "M1", "W2", "W3", "W4"]) {
      assert.ok(!text.includes(leaked), `申诉视图泄露了 ${leaked}`);
    }
    const resolved = await api("POST", `/appeals/${appeal.body.appeal_ref}/resolve`, {
      actor: APPEALER, body: { resolution: "计分过程核验无误" },
    });
    assert.equal(resolved.body.status, "resolved");
  });

  await t.test("审计哈希链完整", async () => {
    const verify = await api("GET", "/audit/verify", { actor: ADMIN });
    assert.equal(verify.body.ok, true);
    assert.ok(verify.body.entries > 20);
  });
});

test("密封评分与审计日志在数据库层不可改删", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openDatabase } = require("../src/db");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "review-")), "app.sqlite3");
  const db = openDatabase(file);
  db.prepare("INSERT INTO scores (seat_ref, work_ref, judge_ref, score, sealed_at, score_hash) VALUES ('S1','W1','J1',80,'2026-09-20T00:00:00Z','h1')").run();
  assert.throws(() => db.prepare("UPDATE scores SET score = 100 WHERE seat_ref = 'S1'").run(), /scores_immutable/);
  assert.throws(() => db.prepare("DELETE FROM scores WHERE seat_ref = 'S1'").run(), /scores_immutable/);
  db.prepare("INSERT INTO audit_log (action, prev_hash, entry_hash, created_at) VALUES ('x','GENESIS','h','2026-09-20T00:00:00Z')").run();
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'y'").run(), /audit_immutable/);
  assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /audit_immutable/);
  db.close();
});

// 申诉与脱敏核查。
//
// 边界：
//   - 团队只能对本团队作品提出申诉；核查人（AUDITOR）就三件事取证：
//     eligibility 资格（冻结时版本与排除记录）、assignment 分派（排查与席位历史）、
//     scoring 计分（有效评分集合与统计）。
//   - 核查视图中评委只以 public_fingerprint 出现，其他作品编号被遮蔽，
//     院校/地区/成员字段一律不返回；每次查看写 appeal_views 与审计日志。
const util = require("./util");
const { HttpError } = require("./auth");
const { validScores, submittedCount } = require("./scoring");

// 剥离席位理由中的内部评委编号数组（与证据包投影保持一致）
function publicRationale(rationale) {
  if (!rationale || typeof rationale !== "object") return rationale;
  const safe = { ...rationale };
  for (const key of ["excluded_judges", "tainted_judges"]) {
    if (Array.isArray(safe[key])) safe[`${key}_count`] = safe[key].length;
    delete safe[key];
  }
  return safe;
}

function fileAppeal(database, { workId, teamId, reason, actor }) {
  const work = database.prepare("SELECT * FROM works WHERE work_id = ?").get(workId);
  if (!work) throw new HttpError(404, "work_not_found", "作品不存在");
  if (work.team_id !== teamId) throw new HttpError(403, "not_your_work", "只能就本团队作品申诉");
  const open = database
    .prepare("SELECT 1 FROM appeals WHERE work_id = ? AND status = 'open'")
    .get(workId);
  if (open) throw new HttpError(409, "appeal_open", "该作品已有进行中的申诉");

  const appealId = util.newId("appeal");
  const createdAt = util.now();
  database
    .prepare(
      `INSERT INTO appeals(appeal_id, work_id, team_id, reason, status, created_at)
       VALUES (?,?,?,?, 'open', ?)`
    )
    .run(appealId, workId, work.team_id, reason, createdAt);
  return { appeal_id: appealId, work_id: workId, status: "open", created_at: createdAt };
}

// 找到申诉作品当前/历史的匿名副本（不回显原始片名与团队信息）
function itemsForAppeal(database, appeal) {
  return database
    .prepare("SELECT * FROM frozen_items WHERE work_id = ? ORDER BY created_at")
    .all(appeal.work_id)
    .map((item) => ({
      item_id: item.item_id,
      category: item.category,
      active: !!item.active,
      replaces: item.replaces_item_id || null,
      superseded_by: item.superseded_by_item_id || null,
      version_id: item.version_id,
      media_sha256: item.media_sha256,
      copy_ref: item.copy_ref,
      copy_sha256: item.copy_sha256,
      scrub_report: util.parseJsonObject(item.scrub_report_json),
    }));
}

function logView(database, appealId, actor, scope) {
  database
    .prepare("INSERT INTO appeal_views(appeal_id, actor_id, scope, created_at) VALUES (?,?,?,?)")
    .run(appealId, actor.id, scope, util.now());
}

// 资格核对：冻结版本是否存在、是否被排除、版本摘要链
function eligibilityBundle(database, appeal, items) {
  const work = database.prepare("SELECT category, status FROM works WHERE work_id = ?").get(appeal.work_id);
  const versions = database
    .prepare("SELECT version_id, seq, media_sha256, created_at FROM work_versions WHERE work_id = ? ORDER BY seq")
    .all(appeal.work_id);
  const freezeRows = database
    .prepare(
      `SELECT f.freeze_id, f.created_at, e.reason
         FROM freeze_exclusions e
         JOIN freeze_events f ON f.freeze_id = e.freeze_id
        WHERE e.work_id = ?`
    )
    .all(appeal.work_id);
  return {
    scope: "eligibility",
    work_status: work.status,
    category: work.category,
    submitted_versions: versions.map((v) => ({ seq: v.seq, media_sha256: v.media_sha256, at: v.created_at })),
    frozen_copies: items,
    exclusions: freezeRows.map((row) => ({ freeze_id: row.freeze_id, frozen_at: row.created_at, reason: row.reason })),
  };
}

// 分派核对：每个副本上评委的排查结论与席位历史（评委仅显示指纹）
function assignmentBundle(database, appeal, items) {
  const rounds = database.prepare("SELECT * FROM rounds ORDER BY created_at").all();
  const out = [];
  for (const item of items) {
    for (const round of rounds) {
      const screenings = database
        .prepare("SELECT judge_id, outcome, reasons_json FROM conflict_exclusions WHERE round_id = ? AND item_id = ?")
        .all(round.round_id, item.item_id);
      if (screenings.length === 0) continue;
      const seats = database
        .prepare(
          `SELECT s.status, s.replace_kind, s.parent_seat_id, s.rationale_json, s.created_at, s.submitted_at,
                  j.public_fingerprint AS fingerprint
             FROM seats s JOIN judges j ON j.judge_id = s.judge_id
            WHERE s.round_id = ? AND s.item_id = ? ORDER BY s.created_at`
        )
        .all(round.round_id, item.item_id);
      out.push({
        round_id: round.round_id,
        item_id: item.item_id,
        deadline_at: round.deadline_at,
        screenings: screenings.map((row) => ({
          judge_fingerprint: database
            .prepare("SELECT public_fingerprint FROM judges WHERE judge_id = ?")
            .get(row.judge_id).public_fingerprint,
          outcome: row.outcome,
          reasons: util.parseJsonArray(row.reasons_json),
        })),
        seat_history: seats.map((seat) => ({
          judge_fingerprint: seat.fingerprint,
          status: seat.status,
          replace_kind: seat.replace_kind,
          rationale: publicRationale(util.parseJsonObject(seat.rationale_json)),
          at: seat.created_at,
          submitted_at: seat.submitted_at,
        })),
      });
    }
  }
  return { scope: "assignment", rounds: out };
}

// 计分核对：有效评分集合、均值与法定人数；其他作品仅以匿名编号出现且不返回其分值细节
function scoringBundle(database, appeal, items) {
  const result = [];
  for (const item of items) {
    const seat = database.prepare("SELECT round_id FROM seats WHERE item_id = ? LIMIT 1").get(item.item_id);
    if (!seat) continue;
    const round = database.prepare("SELECT * FROM rounds WHERE round_id = ?").get(seat.round_id);
    const scores = validScores(database, round.round_id, item.item_id);
    result.push({
      item_id: item.item_id,
      round_id: round.round_id,
      quorum: round.quorum,
      submitted: submittedCount(database, round.round_id, item.item_id),
      quorum_met: scores.length >= round.quorum,
      mean: scores.length ? Number((scores.reduce((sum, row) => sum + row.value, 0) / scores.length).toFixed(4)) : null,
      valid_scores: scores.map((row) => ({
        score_id: row.score_id,
        judge_fingerprint: row.fingerprint,
        value: row.value,
        sealed_at: row.created_at,
      })),
    });
  }
  return { scope: "scoring", items: result };
}

function reviewAppeal(database, { appealId, scope, actor }) {
  const appeal = database.prepare("SELECT * FROM appeals WHERE appeal_id = ?").get(appealId);
  if (!appeal) throw new HttpError(404, "appeal_not_found", "申诉不存在");
  const allowed = ["eligibility", "assignment", "scoring"];
  if (!allowed.includes(scope)) throw new HttpError(400, "bad_scope", "核查范围必须是 eligibility/assignment/scoring");

  const items = itemsForAppeal(database, appeal);
  let bundle;
  if (scope === "eligibility") bundle = eligibilityBundle(database, appeal, items);
  if (scope === "assignment") bundle = assignmentBundle(database, appeal, items);
  if (scope === "scoring") bundle = scoringBundle(database, appeal, items);

  logView(database, appealId, actor, scope);
  return {
    appeal_id: appealId,
    status: appeal.status,
    reason_filed: appeal.reason,
    bundle,
    notice: "本视图已脱敏：评委以指纹表示，不含院校、地区、成员信息及其他作品数据",
  };
}

function answerAppeal(database, { appealId, resolutionNote, actor }) {
  const appeal = database.prepare("SELECT * FROM appeals WHERE appeal_id = ?").get(appealId);
  if (!appeal) throw new HttpError(404, "appeal_not_found", "申诉不存在");
  if (appeal.status !== "open") throw new HttpError(409, "appeal_not_open", "申诉不在处理中");
  const at = util.now();
  database
    .prepare("UPDATE appeals SET status = 'answered', answered_by = ?, answered_at = ?, resolution_note = ? WHERE appeal_id = ?")
    .run(actor.id, at, resolutionNote, appealId);
  // 回复给团队的内容同样不含评委身份
  return {
    appeal_id: appealId,
    status: "answered",
    answered_at: at,
    resolution_note: resolutionNote,
  };
}

module.exports = { fileAppeal, reviewAppeal, answerAppeal };

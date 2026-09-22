// 审计链与评分链的独立核验。
//
// audit_log：每行 entry_hash = sha256(prev_hash || canonical(detail))，逐行重算。
// scores：评分行独立成链（防删/防改同时由触发器与链共同保证）。
// tie_votes：每行自带内容哈希（投票之间无序，仅保证单票不可改）。
const util = require("./util");

function verifyAuditChain(database) {
  const rows = database
    .prepare("SELECT seq, created_at, actor_id, actor_role, action, entity_type, entity_id, detail_json, prev_hash, entry_hash FROM audit_log ORDER BY seq")
    .all();
  let prev = "GENESIS";
  const broken = [];
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      broken.push({ seq: row.seq, problem: "prev_hash_mismatch" });
    }
    const body = {
      a: row.actor_id,
      r: row.actor_role,
      act: row.action,
      et: row.entity_type,
      eid: row.entity_id,
      d: util.parseJsonObject(row.detail_json),
      t: row.created_at,
    };
    const expected = util.sha256(prev + util.stableStringify(body));
    if (expected !== row.entry_hash) {
      broken.push({ seq: row.seq, problem: "entry_hash_mismatch" });
    }
    prev = row.entry_hash;
  }
  return {
    entries: rows.length,
    head_hash: rows.length ? rows[rows.length - 1].entry_hash : "GENESIS",
    intact: broken.length === 0,
    broken,
  };
}

function verifyScoreChain(database) {
  const rows = database
    .prepare("SELECT score_id, round_id, seat_id, item_id, judge_id, value, comment_text, created_at, prev_hash, entry_hash FROM scores ORDER BY rowid")
    .all();
  let prev = "GENESIS";
  const broken = [];
  for (const row of rows) {
    if (row.prev_hash !== prev) broken.push({ score_id: row.score_id, problem: "prev_hash_mismatch" });
    const payload = {
      score_id: row.score_id,
      seat_id: row.seat_id,
      item_id: row.item_id,
      round_id: row.round_id,
      judge_id: row.judge_id,
      value: row.value,
      comment: row.comment_text,
      created_at: row.created_at,
    };
    const expected = util.sha256(prev + util.stableStringify(payload));
    if (expected !== row.entry_hash) broken.push({ score_id: row.score_id, problem: "entry_hash_mismatch" });
    prev = row.entry_hash;
  }
  return { entries: rows.length, intact: broken.length === 0, broken };
}

function verifyTieVotes(database) {
  const rows = database.prepare("SELECT vote_id, tie_id, judge_id, ranking_json, comment_text, created_at, entry_hash FROM tie_votes").all();
  const broken = [];
  for (const row of rows) {
    const expected = util.sha256(
      util.stableStringify({
        tie_id: row.tie_id,
        vote_id: row.vote_id,
        judge_id: row.judge_id,
        ranking: util.parseJsonArray(row.ranking_json),
        at: row.created_at,
      })
    );
    if (expected !== row.entry_hash) broken.push({ vote_id: row.vote_id, problem: "entry_hash_mismatch" });
  }
  return { entries: rows.length, intact: broken.length === 0, broken };
}

module.exports = { verifyAuditChain, verifyScoreChain, verifyTieVotes };

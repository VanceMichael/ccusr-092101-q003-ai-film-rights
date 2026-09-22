// 密封评分、法定人数、同分复议、奖项确认与可验证证据包。
//
// 独立性规则：
//   - 每件作品的有效评分（在有效席位上、状态 submitted）数量达到 quorum 之前，
//     任何人（含秘书处与管理员）都只能看到进度计数，看不到具体分值；达到后开放聚合结果。
//   - scores 行由数据库触发器保证不可改删；管理员没有"代评委改分"的路径，
//     提交只认评委本人令牌与本人席位。
//   - 泄露重排后，旧副本上的评分行原样保留以供审计，但不属于新副本的有效评分集合。
const util = require("./util");
const { HttpError } = require("./auth");

function appendScoreHash(database, payload) {
  const last = database.prepare("SELECT entry_hash FROM scores ORDER BY rowid DESC LIMIT 1").get();
  const prevHash = last ? last.entry_hash : "GENESIS";
  return { prevHash, entryHash: util.sha256(prevHash + util.stableStringify(payload)) };
}

function getOwnedSeat(database, seatId, judgeId) {
  const seat = database.prepare("SELECT * FROM seats WHERE seat_id = ?").get(seatId);
  if (!seat) throw new HttpError(404, "seat_not_found", "席位不存在");
  if (seat.judge_id !== judgeId) {
    throw new HttpError(403, "not_your_seat", "只能就本人席位提交评分");
  }
  return seat;
}

function submitScore(database, { seatId, actor, value, comment }) {
  const seat = getOwnedSeat(database, seatId, actor.id);
  if (seat.status !== "assigned") {
    throw new HttpError(409, "seat_not_open", `席位当前状态为 ${seat.status}，不能提交`);
  }
  const round = database.prepare("SELECT * FROM rounds WHERE round_id = ?").get(seat.round_id);
  if (round.status !== "open") throw new HttpError(409, "round_closed", "本轮评分已关闭");
  if (typeof value !== "number" || value < 0 || value > 100) {
    throw new HttpError(400, "bad_score", "分值必须是 0 到 100 之间的数字");
  }
  const item = database.prepare("SELECT * FROM frozen_items WHERE item_id = ?").get(seat.item_id);
  if (!item || !item.active) throw new HttpError(409, "item_inactive", "评审副本已失效");

  const createdAt = util.now();
  const scoreId = util.newId("score");
  const payload = {
    score_id: scoreId,
    seat_id: seat.seat_id,
    item_id: seat.item_id,
    round_id: seat.round_id,
    judge_id: seat.judge_id, // 身份侧编号不进对外视图，仅用于链内完整性
    value,
    comment: comment || "",
    created_at: createdAt,
  };
  const { prevHash, entryHash } = appendScoreHash(database, payload);

  database
    .prepare(
      `INSERT INTO scores(score_id, seat_id, item_id, round_id, judge_id, value, comment_text,
                          prev_hash, entry_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      scoreId, seat.seat_id, seat.item_id, seat.round_id, seat.judge_id, value,
      comment || "", prevHash, entryHash, createdAt
    );
  database.prepare("UPDATE seats SET status = 'submitted', submitted_at = ? WHERE seat_id = ?").run(
    createdAt,
    seat.seat_id
  );
  database
    .prepare("INSERT INTO seat_events(seat_id, event, actor_id, detail_json, created_at) VALUES (?,?,?,?,?)")
    .run(seat.seat_id, "submitted", actor.id, util.stableStringify({ score_id: scoreId }), createdAt);

  return { score_id: scoreId, seat_id: seat.seat_id, item_id: seat.item_id, submitted_at: createdAt };
}

// 一件作品的有效评分集合（仅含当前有效副本、有效席位上的评分）
function validScores(database, roundId, itemId) {
  return database
    .prepare(
      `SELECT s.*, j.public_fingerprint AS fingerprint
         FROM scores s
         JOIN seats st ON st.seat_id = s.seat_id AND st.status = 'submitted'
         JOIN frozen_items i ON i.item_id = s.item_id AND i.active = 1
         JOIN judges j ON j.judge_id = s.judge_id
        WHERE s.round_id = ? AND s.item_id = ?
        ORDER BY s.created_at, s.score_id`
    )
    .all(roundId, itemId);
}

function submittedCount(database, roundId, itemId) {
  return database
    .prepare(
      `SELECT COUNT(*) AS n FROM seats
        WHERE round_id = ? AND item_id = ? AND status = 'submitted'`
    )
    .get(roundId, itemId).n;
}

// 单件作品的评分视图：quorum 未达时只给进度，分值对所有人不可见。
function itemProgress(database, round, itemId) {
  const count = submittedCount(database, round.round_id, itemId);
  const base = {
    item_id: itemId,
    quorum: round.quorum,
    submitted: count,
    quorum_met: count >= round.quorum,
  };
  if (count < round.quorum) return { ...base, scores: null, mean: null, note: "法定人数未达成，评分暂不可见" };

  const scores = validScores(database, round.round_id, itemId);
  const mean = scores.reduce((sum, row) => sum + row.value, 0) / scores.length;
  return {
    ...base,
    mean: Number(mean.toFixed(4)),
    scores: scores.map((row) => ({
      score_id: row.score_id,
      judge_fingerprint: row.fingerprint,
      value: row.value,
      sealed_at: row.created_at,
    })),
  };
}

// 关闭评分轮次（秘书处）：所有在评作品必须达到法定人数，否则返回未达标清单。
function closeScoring(database, round) {
  const items = database
    .prepare(
      `SELECT item_id FROM frozen_items
        WHERE freeze_id = ? AND active = 1
          AND category IN (SELECT category FROM round_categories WHERE round_id = ?)`
    )
    .all(round.freeze_id, round.round_id);
  const pending = [];
  for (const item of items) {
    const count = submittedCount(database, round.round_id, item.item_id);
    if (count < round.quorum) pending.push({ item_id: item.item_id, submitted: count, quorum: round.quorum });
  }
  if (pending.length > 0) {
    const error = new Error("quorum_unmet");
    error.pending = pending;
    throw error;
  }
  database.prepare("UPDATE rounds SET status = 'scoring_closed' WHERE round_id = ?").run(round.round_id);
  return { round_id: round.round_id, status: "scoring_closed", items: items.length };
}

// 类别内按均分排名，标出同名次组。
function categoryResults(database, roundId, category) {
  const rows = database
    .prepare(
      `SELECT s.item_id, AVG(s.value) AS mean, COUNT(*) AS n
         FROM scores s
         JOIN seats st ON st.seat_id = s.seat_id AND st.status = 'submitted'
         JOIN frozen_items i ON i.item_id = s.item_id AND i.active = 1
        WHERE s.round_id = ? AND i.category = ?
        GROUP BY s.item_id`
    )
    .all(roundId, category);
  const ranked = rows
    .map((row) => ({ item_id: row.item_id, mean: Number(row.mean.toFixed(4)), count: row.n }))
    .sort((a, b) => b.mean - a.mean || (a.item_id < b.item_id ? -1 : 1));
  // 检测均分相同（容差 1e-4）
  const ties = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const group = [ranked[i]];
    while (i + 1 < ranked.length && Math.abs(ranked[i + 1].mean - ranked[i].mean) < 1e-4) {
      i += 1;
      group.push(ranked[i]);
    }
    if (group.length > 1) ties.push(group.map((g) => g.item_id));
  }
  return { category, ranking: ranked, tied_groups: ties };
}

// ---------------------------------------------------------------------------
// 同分复议
// ---------------------------------------------------------------------------

function openTie(database, { round, category, itemIds, openedBy }) {
  // 校验确实同分
  const results = categoryResults(database, round.round_id, category);
  const group = results.ranking.filter((row) => itemIds.includes(row.item_id));
  if (group.length !== itemIds.length) throw new HttpError(400, "items_not_in_category", "部分作品不在该类别结果中");
  const means = new Set(group.map((row) => row.mean));
  if (means.size !== 1) throw new HttpError(409, "not_tied", "这些作品均分不同，不构成同分");

  const tieId = util.newId("tie");
  const createdAt = util.now();
  database
    .prepare(
      `INSERT INTO tie_groups(tie_id, round_id, category, item_ids_json, tied_score, status, opened_by, opened_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      tieId, round.round_id, category, util.stableStringify([...itemIds].sort()),
      group[0].mean, "open", openedBy, createdAt
    );
  return { tie_id: tieId, category, item_ids: [...itemIds].sort(), tied_score: group[0].mean };
}

// 从无冲突的 TIE_REVIEWER 评委中组建复议组
function addTiePanelist(database, { tieId, judgeId }) {
  const tie = database.prepare("SELECT * FROM tie_groups WHERE tie_id = ?").get(tieId);
  if (!tie) throw new HttpError(404, "tie_not_found", "复议不存在");
  if (tie.status !== "open") throw new HttpError(409, "tie_closed", "复议已结束");
  const items = util.parseJsonArray(tie.item_ids_json);
  // 复议人对组内任一作品有冲突即不得进入
  const { conflictsForWork, buildTeamGraph } = require("./conflicts");
  const adjacency = buildTeamGraph(database);
  for (const itemId of items) {
    const item = database
      .prepare(
        `SELECT i.*, w.team_id FROM frozen_items i JOIN works w ON w.work_id = i.work_id WHERE i.item_id = ?`
      )
      .get(itemId);
    const reasons = conflictsForWork(database, adjacency, judgeId, item);
    if (reasons.length > 0) throw new HttpError(409, "panelist_conflict", "复议人与组内作品存在利益冲突", { reasons });
  }
  database
    .prepare("INSERT OR IGNORE INTO tie_panel(tie_id, judge_id, added_at) VALUES (?,?,?)")
    .run(tieId, judgeId, util.now());
  return { tie_id: tieId, judge_id: judgeId };
}

function castTieVote(database, { tieId, actor, ranking, comment }) {
  const tie = database.prepare("SELECT * FROM tie_groups WHERE tie_id = ?").get(tieId);
  if (!tie) throw new HttpError(404, "tie_not_found", "复议不存在");
  if (tie.status !== "open") throw new HttpError(409, "tie_closed", "复议已结束");
  const seated = database.prepare("SELECT 1 FROM tie_panel WHERE tie_id = ? AND judge_id = ?").get(tieId, actor.id);
  if (!seated) throw new HttpError(403, "not_on_panel", "你不在该复议组中");
  const items = util.parseJsonArray(tie.item_ids_json);
  if (!Array.isArray(ranking) || [...ranking].sort().join() !== [...items].sort().join()) {
    throw new HttpError(400, "bad_ranking", "排序必须恰好包含复议组内全部作品编号");
  }
  const exists = database.prepare("SELECT 1 FROM tie_votes WHERE tie_id = ? AND judge_id = ?").get(tieId, actor.id);
  if (exists) throw new HttpError(409, "vote_exists", "复议投票已密封，不得更改");

  const createdAt = util.now();
  const voteId = util.newId("tvote");
  const entryHash = util.sha256(
    util.stableStringify({ tie_id: tieId, vote_id: voteId, judge_id: actor.id, ranking, at: createdAt })
  );
  database
    .prepare(
      `INSERT INTO tie_votes(vote_id, tie_id, judge_id, ranking_json, comment_text, entry_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(voteId, tieId, actor.id, util.stableStringify(ranking), comment || "", entryHash, createdAt);
  return { vote_id: voteId, tie_id: tieId };
}

// 收票：以 Borda 计分（第一名 k-1 分，依次递减）汇总，全票到齐后方可裁决。
function resolveTie(database, { tieId, actor }) {
  const tie = database.prepare("SELECT * FROM tie_groups WHERE tie_id = ?").get(tieId);
  if (!tie) throw new HttpError(404, "tie_not_found", "复议不存在");
  if (tie.status !== "open") throw new HttpError(409, "tie_closed", "复议已结束");
  const items = util.parseJsonArray(tie.item_ids_json);
  const panel = database.prepare("SELECT judge_id FROM tie_panel WHERE tie_id = ?").all(tieId).map((r) => r.judge_id);
  const votes = database.prepare("SELECT * FROM tie_votes WHERE tie_id = ?").all(tieId);
  if (panel.length === 0) throw new HttpError(409, "empty_panel", "复议组为空");
  if (votes.length < panel.length) {
    throw new HttpError(409, "votes_incomplete", "复议票未到齐", { panel: panel.length, votes: votes.length });
  }
  const points = new Map(items.map((id) => [id, 0]));
  const k = items.length;
  for (const vote of votes) {
    const ranking = util.parseJsonArray(vote.ranking_json);
    ranking.forEach((itemId, index) => points.set(itemId, points.get(itemId) + (k - 1 - index)));
  }
  const finalRanking = [...points.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([itemId, borda]) => ({ item_id: itemId, borda }));

  const stillTied = finalRanking.length >= 2 && finalRanking[0].borda === finalRanking[1].borda;
  if (stillTied) throw new HttpError(409, "borda_still_tied", "Borda 计票仍然并列，须扩充复议组");

  const resolution = {
    method: "borda",
    final_ranking: finalRanking,
    votes: votes.map((vote) => ({
      vote_id: vote.vote_id,
      judge_fingerprint: database
        .prepare("SELECT public_fingerprint FROM judges WHERE judge_id = ?")
        .get(vote.judge_id).public_fingerprint,
      ranking: util.parseJsonArray(vote.ranking_json),
    })),
    resolved_by: actor.id,
    resolved_at: util.now(),
  };
  database
    .prepare("UPDATE tie_groups SET status = 'resolved', resolved_at = ?, resolution_json = ? WHERE tie_id = ?")
    .run(resolution.resolved_at, util.stableStringify(resolution), tieId);
  return { tie_id: tieId, ...resolution };
}

// ---------------------------------------------------------------------------
// 奖项与证据包
// ---------------------------------------------------------------------------

function proposeAward(database, { round, category, place, itemId, tieId = null, actor }) {
  if (round.status !== "scoring_closed") throw new HttpError(409, "round_not_closed", "评分尚未关闭");
  const item = database.prepare("SELECT * FROM frozen_items WHERE item_id = ? AND active = 1").get(itemId);
  if (!item || item.category !== category) throw new HttpError(400, "bad_item", "作品不存在或类别不符");
  if (tieId) {
    const tie = database.prepare("SELECT * FROM tie_groups WHERE tie_id = ?").get(tieId);
    if (!tie || tie.status !== "resolved") throw new HttpError(400, "bad_tie", "复议未裁决");
  }
  const exists = database
    .prepare("SELECT 1 FROM awards WHERE round_id = ? AND category = ? AND place = ? AND status != 'proposed'")
    .get(round.round_id, category, place);
  if (exists) throw new HttpError(409, "award_place_taken", "该名次已有奖项");

  const awardId = util.newId("award");
  const createdAt = util.now();
  database
    .prepare(
      `INSERT INTO awards(award_id, round_id, category, place, item_id, tie_id, status, proposed_by, proposed_at)
       VALUES (?,?,?,?,?,?, 'proposed', ?, ?)`
    )
    .run(awardId, round.round_id, category, place, itemId, tieId, actor.id, createdAt);
  return { award_id: awardId, status: "proposed", proposed_by: actor.id, proposed_at: createdAt };
}

// 奖项确认人必须与提名人不是同一人，也不得是该作品的复议参与人。
function confirmAward(database, { awardId, actor }) {
  const award = database.prepare("SELECT * FROM awards WHERE award_id = ?").get(awardId);
  if (!award) throw new HttpError(404, "award_not_found", "奖项不存在");
  if (award.status !== "proposed") throw new HttpError(409, "award_not_proposed", "奖项当前状态不可确认");
  if (award.proposed_by === actor.id) {
    throw new HttpError(403, "separation_of_duty", "确认人不得与提名人相同");
  }
  if (award.tie_id) {
    const voter = database
      .prepare("SELECT 1 FROM tie_votes WHERE tie_id = ? AND judge_id = ?")
      .get(award.tie_id, actor.id);
    const panelist = database
      .prepare("SELECT 1 FROM tie_panel WHERE tie_id = ? AND judge_id = ?")
      .get(award.tie_id, actor.id);
    if (voter || panelist) throw new HttpError(403, "separation_of_duty", "确认人不得参与过该作品的同分复议");
  }
  const confirmedAt = util.now();
  database
    .prepare("UPDATE awards SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE award_id = ?")
    .run(actor.id, confirmedAt, awardId);
  return { award_id: awardId, status: "confirmed", confirmed_by: actor.id, confirmed_at: confirmedAt };
}

// 对外投影席位理由时剥离内部评委编号数组，仅保留计数
function publicRationale(rationale) {
  if (!rationale || typeof rationale !== "object") return rationale;
  const safe = { ...rationale };
  for (const key of ["excluded_judges", "tainted_judges"]) {
    if (Array.isArray(safe[key])) safe[`${key}_count`] = safe[key].length;
    delete safe[key];
  }
  return safe;
}

// 构建奖项证据包：冻结版本 + 有效评分集合 + 冲突排除记录 + 复议裁决 + 时间线。
function buildPackage(database, award) {
  const item = database.prepare("SELECT * FROM frozen_items WHERE item_id = ?").get(award.item_id);
  const round = database.prepare("SELECT * FROM rounds WHERE round_id = ?").get(award.round_id);
  const scores = validScores(database, award.round_id, award.item_id);
  const exclusions = database
    .prepare("SELECT * FROM conflict_exclusions WHERE round_id = ? AND item_id = ? ORDER BY id")
    .all(award.round_id, award.item_id)
    .map((row) => ({
      judge_fingerprint: database
        .prepare("SELECT public_fingerprint FROM judges WHERE judge_id = ?")
        .get(row.judge_id).public_fingerprint,
      outcome: row.outcome,
      reasons: util.parseJsonArray(row.reasons_json),
    }));

  const seats = database
    .prepare("SELECT seat_id, judge_id, status, replace_kind, parent_seat_id, rationale_json FROM seats WHERE round_id = ? AND item_id = ? ORDER BY created_at")
    .all(award.round_id, award.item_id)
    .map((seat) => ({
      status: seat.status,
      replace_kind: seat.replace_kind,
      parent_seat_id: seat.parent_seat_id,
      rationale: publicRationale(util.parseJsonObject(seat.rationale_json)),
    }));

  const pkg = {
    award_id: award.award_id,
    round_id: award.round_id,
    category: award.category,
    place: award.place,
    frozen_version: {
      item_id: item.item_id,
      freeze_id: item.freeze_id,
      version_id: item.version_id,
      media_sha256: item.media_sha256,
      copy_ref: item.copy_ref,
      copy_sha256: item.copy_sha256,
      active: !!item.active,
      superseded_by: item.superseded_by_item_id,
    },
    quorum_required: round.quorum,
    valid_scores: scores.map((row) => ({
      score_id: row.score_id,
      judge_fingerprint: row.fingerprint,
      value: row.value,
      sealed_at: row.created_at,
    })),
    conflict_screening: exclusions,
    seat_history: seats,
    tie_resolution: null,
    timeline: {
      proposed_by: award.proposed_by,
      proposed_at: award.proposed_at,
      confirmed_by: award.confirmed_by,
      confirmed_at: award.confirmed_at,
      published_by: award.published_by || null,
      published_at: award.published_at || null,
    },
  };
  if (award.tie_id) {
    const tie = database.prepare("SELECT * FROM tie_groups WHERE tie_id = ?").get(award.tie_id);
    pkg.tie_resolution = {
      tie_id: tie.tie_id,
      tied_score: tie.tied_score,
      resolution: util.parseJsonObject(tie.resolution_json),
    };
  }
  pkg.package_hash = util.sha256Json({ ...pkg, package_hash: undefined });
  return pkg;
}

// 发布前完整性检查：冻结版本仍有效、有效评分达到法定人数、每个 assigned 评委都无冲突记录。
function validatePackage(database, pkg) {
  const problems = [];
  const item = database.prepare("SELECT * FROM frozen_items WHERE item_id = ?").get(pkg.frozen_version.item_id);
  if (!item) problems.push("frozen_item_missing");
  else {
    if (item.media_sha256 !== pkg.frozen_version.media_sha256) problems.push("media_digest_mismatch");
    if (item.copy_sha256 !== pkg.frozen_version.copy_sha256) problems.push("copy_digest_mismatch");
  }
  const liveScores = validScores(database, pkg.round_id, pkg.frozen_version.item_id);
  const liveIds = liveScores.map((s) => s.score_id).sort();
  const pkgIds = pkg.valid_scores.map((s) => s.score_id).sort();
  if (liveIds.join() !== pkgIds.join()) problems.push("valid_score_set_mismatch");
  if (liveScores.length < pkg.quorum_required) problems.push("quorum_unmet");

  // 规则一：有效评分集合中的评委不得带有 conflict 排查记录；
  // 替补评委若无初始排查行，则席位历史中必须存在带 replace_kind 的替补来源。
  const byFingerprint = new Map(pkg.conflict_screening.map((row) => [row.judge_fingerprint, row]));
  const hasReplacementHistory = pkg.seat_history.some((seat) => seat.replace_kind);
  for (const score of pkg.valid_scores) {
    const row = byFingerprint.get(score.judge_fingerprint);
    if (!row) {
      if (!hasReplacementHistory) problems.push(`scorer_without_screening:${score.judge_fingerprint}`);
    } else if (row.outcome === "conflict") {
      problems.push(`conflicted_judge_scored:${score.judge_fingerprint}`);
    }
  }
  // 规则二：排查为 conflict 的评委绝不能出现在有效评分集合
  for (const row of pkg.conflict_screening) {
    if (
      row.outcome === "conflict" &&
      pkg.valid_scores.some((score) => score.judge_fingerprint === row.judge_fingerprint)
    ) {
      problems.push(`conflicted_judge_assigned:${row.judge_fingerprint}`);
    }
  }
  return problems;
}

function publishAward(database, { awardId, actor }) {
  const award = database.prepare("SELECT * FROM awards WHERE award_id = ?").get(awardId);
  if (!award) throw new HttpError(404, "award_not_found", "奖项不存在");
  if (award.status !== "confirmed") throw new HttpError(409, "award_not_confirmed", "奖项尚未由确认人确认");
  if (award.confirmed_by === actor.id) {
    throw new HttpError(403, "separation_of_duty", "发布人与确认人不得相同");
  }
  const pkg = buildPackage(database, award);
  const problems = validatePackage(database, pkg);
  if (problems.length > 0) throw new HttpError(422, "evidence_package_invalid", "证据包校验失败", { problems });

  const publishedAt = util.now();
  pkg.timeline.published_by = actor.id;
  pkg.timeline.published_at = publishedAt;
  pkg.package_hash = util.sha256Json({ ...pkg, package_hash: undefined });

  database
    .prepare("UPDATE awards SET status = 'published', published_by = ?, published_at = ?, package_json = ?, package_hash = ? WHERE award_id = ?")
    .run(actor.id, publishedAt, util.stableStringify(pkg), pkg.package_hash, awardId);

  // 轮次内全部发布后，轮次进入 published
  const remaining = database
    .prepare("SELECT COUNT(*) AS n FROM awards WHERE round_id = ? AND status != 'published'")
    .get(award.round_id).n;
  if (remaining === 0) database.prepare("UPDATE rounds SET status = 'published' WHERE round_id = ?").run(award.round_id);
  return { award_id: awardId, status: "published", package: pkg };
}

// 证据包独立核验：重算哈希，并复核冻结版本摘要、有效评分集合与法定人数。
function verifyAward(database, awardId) {
  const award = database.prepare("SELECT * FROM awards WHERE award_id = ?").get(awardId);
  if (!award) throw new HttpError(404, "award_not_found", "奖项不存在");
  if (!award.package_json) throw new HttpError(409, "not_published", "奖项尚未发布，无证据包");
  const stored = util.parseJsonObject(award.package_json);
  const storedHash = stored.package_hash;
  const recomputed = util.sha256Json({ ...stored, package_hash: undefined });
  const problems = validatePackage(database, stored);
  return {
    award_id: awardId,
    status: award.status,
    package_hash_intact: storedHash === recomputed && storedHash === award.package_hash,
    stored_package_hash: storedHash,
    recomputed_package_hash: recomputed,
    validation_problems: problems,
    verified: storedHash === recomputed && storedHash === award.package_hash && problems.length === 0,
  };
}

module.exports = {
  submitScore,
  itemProgress,
  validScores,
  submittedCount,
  closeScoring,
  categoryResults,
  openTie,
  addTiePanelist,
  castTieVote,
  resolveTie,
  proposeAward,
  confirmAward,
  publishAward,
  verifyAward,
  buildPackage,
};

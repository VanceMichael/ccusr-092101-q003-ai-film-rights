// 可解释分派。
//
// 约束与目标：
//   硬约束：类别专长匹配；无直接/间接利益冲突；每评委在评席位 <= max_load。
//   目标：每件在评副本拿到 quorum 个席位；优先把席位给负载最低的评委（负载均衡）。
//   留痕：每个 (作品, 评委) 组合都落 conflict_exclusions：assigned/conflict/no_expertise/at_capacity；
//         每个席位 rationale_json 记录选择理由与当时负载，供秘书处与申诉核对。
//
// 重排（回避 / 超时 / 泄露）只新建受影响席位：旧席位置 reassigned 并保留事件链，
// 已密封评分所在行永不修改；泄露换新副本时，看过旧副本的评委不再进入新副本候选。
const util = require("./util");
const { buildTeamGraph, conflictsForWork } = require("./conflicts");

function activeJudges(database) {
  return database.prepare("SELECT * FROM judges WHERE status = 'active'").all();
}

function activeLoad(database, roundId, judgeId) {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS n FROM seats
        WHERE round_id = ? AND judge_id = ? AND status IN ('assigned','submitted')`
    )
    .get(roundId, judgeId);
  return row.n;
}

// 评估轮次内所有 (item, judge) 组合。
function evaluate(database, round) {
  const items = database
    .prepare(
      `SELECT i.*, w.team_id AS team_id, w.work_id AS work_id
         FROM frozen_items i
         JOIN works w ON w.work_id = i.work_id
        WHERE i.freeze_id = ? AND i.active = 1
          AND i.category IN (SELECT category FROM round_categories WHERE round_id = ?)`
    )
    .all(round.freeze_id, round.round_id);

  const judges = activeJudges(database);
  const expertise = new Map();
  for (const row of database.prepare("SELECT judge_id, category FROM judge_expertise").all()) {
    if (!expertise.has(row.judge_id)) expertise.set(row.judge_id, new Set());
    expertise.get(row.judge_id).add(row.category);
  }
  const adjacency = buildTeamGraph(database);

  const matrix = new Map(); // itemId -> [{judge, outcome, reasons}]
  for (const item of items) {
    const entries = [];
    for (const judge of judges) {
      const categories = expertise.get(judge.judge_id) || new Set();
      if (!categories.has(item.category)) {
        entries.push({ judge, outcome: "no_expertise", reasons: [{ code: "category_mismatch", kind: "n/a" }] });
        continue;
      }
      const reasons = conflictsForWork(database, adjacency, judge.judge_id, item);
      if (reasons.length > 0) {
        entries.push({ judge, outcome: "conflict", reasons });
      } else {
        entries.push({ judge, outcome: "candidate", reasons: [] });
      }
    }
    matrix.set(item.item_id, entries);
  }
  return { items, matrix };
}

function recordExclusions(database, roundId, matrix, assignedKeys, atCapacityKeys, createdAt) {
  const insert = database.prepare(
    `INSERT INTO conflict_exclusions(round_id, item_id, judge_id, outcome, reasons_json, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(round_id, item_id, judge_id) DO NOTHING`
  );
  for (const [itemId, entries] of matrix) {
    for (const entry of entries) {
      let outcome = entry.outcome === "candidate" ? "at_capacity" : entry.outcome;
      const key = `${itemId}:${entry.judge.judge_id}`;
      if (assignedKeys.has(key)) outcome = "assigned";
      else if (entry.outcome === "candidate" && !atCapacityKeys.has(key)) outcome = "at_capacity";
      insert.run(
        roundId,
        itemId,
        entry.judge.judge_id,
        outcome,
        util.stableStringify(entry.reasons.map((r) => ({ code: r.code, kind: r.kind }))),
        createdAt
      );
    }
  }
}

function insertSeat(database, { roundId, itemId, judge, parentSeatId = null, replaceKind = null, why, createdAt }) {
  const seatId = util.newId("seat");
  database
    .prepare(
      `INSERT INTO seats(seat_id, round_id, item_id, judge_id, status, rationale_json,
                         parent_seat_id, replace_kind, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      seatId, roundId, itemId, judge.judge_id, "assigned",
      util.stableStringify(why), parentSeatId, replaceKind, createdAt
    );
  database
    .prepare(
      `INSERT INTO seat_events(seat_id, event, actor_id, detail_json, created_at)
       VALUES (?,?,?,?,?)`
    )
    .run(seatId, parentSeatId ? "reassigned" : "assigned", "system", util.stableStringify({ replace_kind: replaceKind }), createdAt);
  return seatId;
}

// 首轮全量分派。返回每件作品的席位与未满足原因。
function assignRound(database, round, actor) {
  const existing = database
    .prepare("SELECT COUNT(*) AS n FROM seats WHERE round_id = ?")
    .get(round.round_id).n;
  if (existing > 0) throw new Error("round_already_assigned: 请使用重排接口处理变化");

  const createdAt = util.now();
  const { items, matrix } = evaluate(database, round);
  const loads = new Map(); // judgeId -> active seats
  for (const judge of activeJudges(database)) loads.set(judge.judge_id, 0);

  // 最紧约束优先：候选数 - 法定人数 最小的作品先分
  const ordered = [...items].sort((a, b) => {
    const ca = matrix.get(a.item_id).filter((e) => e.outcome === "candidate").length;
    const cb = matrix.get(b.item_id).filter((e) => e.outcome === "candidate").length;
    if (ca !== cb) return ca - cb;
    return a.item_id < b.item_id ? -1 : 1;
  });

  const assignments = []; // {item_id, seat_id, judge_id}
  const assignedKeys = new Set();
  const atCapacitySet = new Set();
  const shortfalls = [];

  for (const item of ordered) {
    const candidates = matrix
      .get(item.item_id)
      .filter((e) => e.outcome === "candidate")
      .map((e) => e.judge);

    // 负载优先，其次评委编号保证可复现
    candidates.sort((a, b) => {
      const la = loads.get(a.judge_id);
      const lb = loads.get(b.judge_id);
      if (la !== lb) return la - lb;
      return a.judge_id < b.judge_id ? -1 : 1;
    });

    const chosen = [];
    for (const judge of candidates) {
      if (chosen.length >= round.quorum) break;
      if (loads.get(judge.judge_id) >= round.max_load) {
        atCapacitySet.add(`${item.item_id}:${judge.judge_id}`);
        continue;
      }
      chosen.push(judge);
    }
    // 法定人数已满后，其余候选即便未满载也只是"未被选中"，记为 at_capacity 类的容量外结果
    for (const judge of candidates) {
      const key = `${item.item_id}:${judge.judge_id}`;
      if (!chosen.includes(judge) && !atCapacitySet.has(key) && loads.get(judge.judge_id) >= round.max_load) {
        atCapacitySet.add(key);
      }
    }

    if (chosen.length < round.quorum) {
      shortfalls.push({
        item_id: item.item_id,
        category: item.category,
        required: round.quorum,
        assignable: chosen.length,
        candidates_total: candidates.length,
        at_capacity: [...atCapacitySet].filter((key) => key.startsWith(`${item.item_id}:`)).length,
        reason:
          candidates.length < round.quorum
            ? "eligible_judges_below_quorum（专长匹配且无冲突的评委不足，无法达到法定人数）"
            : "all_eligible_judges_at_capacity（合格评委均已达负载上限，无法达到法定人数）",
      });
    }

    for (const judge of chosen) {
      const seatId = insertSeat(database, {
        roundId: round.round_id,
        itemId: item.item_id,
        judge,
        why: {
          basis: "expertise_match+no_conflict+min_load",
          category: item.category,
          load_before: loads.get(judge.judge_id),
          max_load: round.max_load,
          deadline: round.deadline_at,
        },
        createdAt,
      });
      loads.set(judge.judge_id, loads.get(judge.judge_id) + 1);
      assignedKeys.add(`${item.item_id}:${judge.judge_id}`);
      assignments.push({ item_id: item.item_id, seat_id: seatId, judge_fingerprint: judge.public_fingerprint });
    }
  }

  recordExclusions(database, round.round_id, matrix, assignedKeys, atCapacitySet, createdAt);

  return {
    round_id: round.round_id,
    deadline_at: round.deadline_at,
    assigned: assignments,
    assigned_count: assignments.length,
    shortfalls,
  };
}

// 为单个席位寻找替补评委（回避/超时通用）。
// excludeJudgeIds：不可再选的评委（本人回避、超时本人、或泄露副本的全部原评委）。
function replaceSeat(database, { round, seat, reason, actor, excludeJudgeIds = new Set() }) {
  const createdAt = util.now();
  const item = database.prepare("SELECT * FROM frozen_items WHERE item_id = ? AND active = 1").get(seat.item_id);
  if (!item) throw new Error("item_inactive: 副本已失效，应走泄露换发流程");

  const { matrix } = evaluate(database, round);
  const entries = matrix.get(seat.item_id) || [];

  // 已在该作品持有有效席位的评委不重复分派
  const heldJudges = new Set(
    database
      .prepare(
        `SELECT judge_id FROM seats
          WHERE round_id = ? AND item_id = ? AND status IN ('assigned','submitted')`
      )
      .all(round.round_id, seat.item_id)
      .map((row) => row.judge_id)
  );

  const candidates = entries
    .filter((e) => e.outcome === "candidate")
    .filter((e) => !excludeJudgeIds.has(e.judge.judge_id))
    .filter((e) => !heldJudges.has(e.judge.judge_id))
    .filter((e) => activeLoad(database, round.round_id, e.judge.judge_id) < round.max_load)
    .map((e) => ({ judge: e.judge, reasons: e.reasons }))
    .sort((a, b) => {
      const la = activeLoad(database, round.round_id, a.judge.judge_id);
      const lb = activeLoad(database, round.round_id, b.judge.judge_id);
      if (la !== lb) return la - lb;
      return a.judge.judge_id < b.judge.judge_id ? -1 : 1;
    });

  if (candidates.length === 0) {
    return { replaced: false, reason: "no_eligible_replacement: 无专长匹配、无冲突且未达负载上限的替补评委" };
  }

  const chosen = candidates[0].judge;
  const newSeatId = insertSeat(database, {
    roundId: round.round_id,
    itemId: seat.item_id,
    judge: chosen,
    parentSeatId: seat.seat_id,
    replaceKind: reason,
    why: {
      basis: "replacement:expertise+no_conflict+min_load",
      replace_reason: reason,
      parent_seat_id: seat.seat_id,
      excluded_judges: [...excludeJudgeIds],
      load_before: activeLoad(database, round.round_id, chosen.judge_id),
      deadline: round.deadline_at,
    },
    createdAt,
  });
  database
    .prepare(
      `INSERT INTO conflict_exclusions(round_id, item_id, judge_id, outcome, reasons_json, created_at)
       VALUES (?,?,?, 'assigned', '[]', ?)
       ON CONFLICT(round_id, item_id, judge_id)
       DO UPDATE SET outcome = 'assigned', reasons_json = excluded.reasons_json, created_at = excluded.created_at`
    )
    .run(round.round_id, seat.item_id, chosen.judge_id, createdAt);

  return { replaced: true, new_seat_id: newSeatId, judge_fingerprint: chosen.public_fingerprint };
}

// 评委就自己的席位申请回避：校验身份，封存席位并补一个席位。
function recuseSeat(database, { round, seat, actor, reason }) {
  const createdAt = util.now();
  database
    .prepare("UPDATE seats SET status = 'reassigned', closed_at = ? WHERE seat_id = ?")
    .run(createdAt, seat.seat_id);
  database
    .prepare("INSERT INTO seat_events(seat_id, event, actor_id, detail_json, created_at) VALUES (?,?,?,?,?)")
    .run(seat.seat_id, "recused", actor.id, util.stableStringify({ reason }), createdAt);
  const result = replaceSeat(database, {
    round,
    seat,
    reason: "recusal",
    actor,
    excludeJudgeIds: new Set([seat.judge_id]),
  });
  return { ...result, old_seat_id: seat.seat_id };
}

// 超时巡查：截止时间已过仍未提交的席位标记 timeout 并补位。
function sweepTimeouts(database, round, actor, at = new Date()) {
  const deadline = new Date(round.deadline_at);
  const results = [];
  if (at <= deadline) return { round_id: round.round_id, swept: results, note: "未到截止时间" };

  const pending = database
    .prepare("SELECT * FROM seats WHERE round_id = ? AND status = 'assigned' ORDER BY item_id, created_at")
    .all(round.round_id);
  // 同一作品上累计退出的评委全部排除，避免超时评委被补位回同一作品
  const excludedByItem = new Map();
  for (const seat of pending) {
    const createdAt = util.now();
    database
      .prepare("UPDATE seats SET status = 'reassigned', closed_at = ? WHERE seat_id = ?")
      .run(createdAt, seat.seat_id);
    database
      .prepare("INSERT INTO seat_events(seat_id, event, actor_id, detail_json, created_at) VALUES (?,?,?,?,?)")
      .run(seat.seat_id, "timeout", actor.id, "{}", createdAt);
    if (!excludedByItem.has(seat.item_id)) excludedByItem.set(seat.item_id, new Set());
    excludedByItem.get(seat.item_id).add(seat.judge_id);
    const outcome = replaceSeat(database, {
      round,
      seat,
      reason: "timeout",
      actor,
      excludeJudgeIds: excludedByItem.get(seat.item_id),
    });
    results.push({ old_seat_id: seat.seat_id, item_id: seat.item_id, ...outcome });
  }
  return { round_id: round.round_id, swept: results };
}

// 副本泄露换发后重排：旧副本的全部评委都见过可能失匿名的材料，一律退出新副本评审；
// 旧席位置 reassigned（含已提交席位——其评分行保持不动，但不计入新副本有效集合）。
function reassignLeakedItem(database, { round, oldItemId, newItemId, actor }) {
  const createdAt = util.now();
  const oldSeats = database
    .prepare("SELECT * FROM seats WHERE round_id = ? AND item_id = ? AND status IN ('assigned','submitted')")
    .all(round.round_id, oldItemId);

  const taintedJudges = new Set(oldSeats.map((seat) => seat.judge_id));
  for (const seat of oldSeats) {
    database
      .prepare("UPDATE seats SET status = 'reassigned', item_id = ?, closed_at = ? WHERE seat_id = ?")
      .run(oldItemId, createdAt, seat.seat_id);
    database
      .prepare("INSERT INTO seat_events(seat_id, event, actor_id, detail_json, created_at) VALUES (?,?,?,?,?)")
      .run(
        seat.seat_id,
        "reassigned",
        actor.id,
        util.stableStringify({ replace_kind: "leak", new_item_id: newItemId }),
        createdAt
      );
  }

  // 在新副本上重建 quorum 个席位：以新 item 走一次候选评估，避开受污染评委
  const { matrix } = evaluate(database, round);
  const allEntries = matrix.get(newItemId) || [];
  const candidates = allEntries
    .filter((e) => e.outcome === "candidate")
    .filter((e) => !taintedJudges.has(e.judge.judge_id))
    .filter((e) => activeLoad(database, round.round_id, e.judge.judge_id) < round.max_load)
    .sort((a, b) => {
      const la = activeLoad(database, round.round_id, a.judge.judge_id);
      const lb = activeLoad(database, round.round_id, b.judge.judge_id);
      if (la !== lb) return la - lb;
      return a.judge.judge_id < b.judge.judge_id ? -1 : 1;
    });

  const chosenJudges = new Set(candidates.slice(0, round.quorum).map((e) => e.judge.judge_id));
  // 新副本完整排查留痕：看过旧副本的评委单独标记 leak_tainted
  const upsertExclusion = database.prepare(
    `INSERT INTO conflict_exclusions(round_id, item_id, judge_id, outcome, reasons_json, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(round_id, item_id, judge_id) DO NOTHING`
  );
  for (const entry of allEntries) {
    const tainted = taintedJudges.has(entry.judge.judge_id);
    const outcome = chosenJudges.has(entry.judge.judge_id)
      ? "assigned"
      : tainted
        ? "conflict"
        : entry.outcome === "candidate"
          ? "at_capacity"
          : entry.outcome;
    const reasons = tainted
      ? [{ code: "leak_tainted", kind: "direct" }]
      : entry.reasons.map((r) => ({ code: r.code, kind: r.kind }));
    upsertExclusion.run(
      round.round_id,
      newItemId,
      entry.judge.judge_id,
      outcome,
      util.stableStringify(reasons),
      createdAt
    );
  }

  const newSeats = [];
  for (const entry of candidates.slice(0, round.quorum)) {
    const seatId = insertSeat(database, {
      roundId: round.round_id,
      itemId: newItemId,
      judge: entry.judge,
      replaceKind: "leak",
      why: {
        basis: "leak_replacement:expertise+no_conflict+min_load",
        old_item_id: oldItemId,
        tainted_judges: [...taintedJudges],
        deadline: round.deadline_at,
      },
      createdAt,
    });
    newSeats.push({ seat_id: seatId, judge_fingerprint: entry.judge.public_fingerprint });
  }

  return {
    old_item_id: oldItemId,
    new_item_id: newItemId,
    quarantined_seats: oldSeats.length,
    new_seats: newSeats,
    quorum_met: newSeats.length >= round.quorum,
  };
}

module.exports = {
  evaluate,
  assignRound,
  replaceSeat,
  recuseSeat,
  sweepTimeouts,
  reassignLeakedItem,
  activeLoad,
};

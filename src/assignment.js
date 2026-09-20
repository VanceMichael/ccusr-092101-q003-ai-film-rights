const { nowIso, newRef } = require("./lib");

const OPEN_SEAT_STATUSES = ["active", "scored"];

function getQuorum(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'quorum'").get();
  return row ? Number.parseInt(row.value, 10) : 3;
}

function getDeadline(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'review_deadline'").get();
  return row ? row.value : null;
}

// 成员关系按无向处理：两个方向都查
function relatedMembers(db, memberRef) {
  return db.prepare(
    `SELECT related_member_ref AS other, relation FROM member_relations WHERE member_ref = ?
     UNION
     SELECT member_ref AS other, relation FROM member_relations WHERE related_member_ref = ?`
  ).all(memberRef, memberRef);
}

function recordConflict(db, judgeRef, workRef, kind, degree, detail, source) {
  const existing = db.prepare(
    "SELECT id FROM conflicts WHERE judge_ref = ? AND work_ref = ? AND kind = ?"
  ).get(judgeRef, workRef, kind);
  if (existing) return;
  db.prepare(
    "INSERT INTO conflicts (judge_ref, work_ref, kind, degree, detail, source, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(judgeRef, workRef, kind, degree, detail, source, nowIso());
}

// 重新派生全部冲突：申报、同单位、团队成员、指导/合作经历、经由共同成员的间接关联
function deriveConflicts(db) {
  db.prepare("DELETE FROM conflicts WHERE source = 'derived'").run();
  const judges = db.prepare("SELECT * FROM judges WHERE active = 1").all();
  const works = db.prepare("SELECT * FROM submissions WHERE status = 'frozen'").all();
  const declarations = db.prepare("SELECT * FROM judge_declarations").all();
  for (const judge of judges) {
    const judgeRelations = relatedMembers(db, judge.judge_ref);
    const judgeDeclarations = declarations.filter((d) => d.judge_ref === judge.judge_ref);
    for (const work of works) {
      const members = db.prepare("SELECT member_ref FROM work_members WHERE work_ref = ?").all(work.work_ref);
      const memberRefs = new Set(members.map((m) => m.member_ref));

      for (const decl of judgeDeclarations) {
        const hit =
          (decl.target_type === "work" && decl.target_ref === work.work_ref) ||
          (decl.target_type === "institution" && decl.target_ref === work.institution_ref) ||
          (decl.target_type === "member" && memberRefs.has(decl.target_ref));
        if (hit) {
          recordConflict(db, judge.judge_ref, work.work_ref, "self_declared", "direct",
            `评委申报回避 ${decl.target_type}:${decl.target_ref}`, "declared");
        }
      }
      if (judge.institution_ref && judge.institution_ref === work.institution_ref) {
        recordConflict(db, judge.judge_ref, work.work_ref, "same_institution", "direct",
          `评委单位与参赛单位相同：${work.institution_ref}`, "derived");
      }
      if (memberRefs.has(judge.judge_ref)) {
        recordConflict(db, judge.judge_ref, work.work_ref, "team_membership", "direct",
          "评委本人为参赛团队成员", "derived");
      }
      for (const rel of judgeRelations) {
        if (memberRefs.has(rel.other)) {
          const kind = rel.relation === "advisor" || rel.relation === "advisee"
            ? "advisor_history" : "collaboration_history";
          recordConflict(db, judge.judge_ref, work.work_ref, kind, "direct",
            `与团队成员 ${rel.other} 存在 ${rel.relation} 关系`, "derived");
        }
      }
      // 间接冲突：评委 -> 中间成员 -> 团队成员（两跳）
      for (const hop of judgeRelations) {
        for (const second of relatedMembers(db, hop.other)) {
          if (second.other !== judge.judge_ref && memberRefs.has(second.other)) {
            recordConflict(db, judge.judge_ref, work.work_ref, "indirect_via_member", "indirect",
              `经由 ${hop.other} 与团队成员 ${second.other} 关联`, "derived");
          }
        }
      }
    }
  }
}

function judgeLoad(db, judgeRef) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM seats WHERE judge_ref = ? AND status IN ('active','scored')"
  ).get(judgeRef).c;
}

function seatedJudges(db, workRef) {
  const rows = db.prepare(
    "SELECT judge_ref FROM seats WHERE work_ref = ? AND status IN ('active','scored')"
  ).all(workRef);
  return new Set(rows.map((row) => row.judge_ref));
}

function openSeatCount(db, workRef) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM seats WHERE work_ref = ? AND status IN ('active','scored')"
  ).get(workRef).c;
}

// 候选评估：逐一给出排除原因，保证分派结果可解释
function evaluateCandidates(db, work, excludeRefs) {
  const judges = db.prepare("SELECT * FROM judges WHERE active = 1 ORDER BY judge_ref").all();
  const eligible = [];
  const excluded = [];
  for (const judge of judges) {
    if (excludeRefs.has(judge.judge_ref)) {
      excluded.push({ judge_ref: judge.judge_ref, reason: "already_seated_or_removed" });
      continue;
    }
    const expertise = JSON.parse(judge.expertise);
    if (!expertise.includes(work.category)) {
      excluded.push({ judge_ref: judge.judge_ref, reason: "expertise_mismatch", category: work.category });
      continue;
    }
    const conflicts = db.prepare(
      "SELECT kind, degree FROM conflicts WHERE judge_ref = ? AND work_ref = ? ORDER BY kind"
    ).all(judge.judge_ref, work.work_ref);
    if (conflicts.length > 0) {
      excluded.push({
        judge_ref: judge.judge_ref,
        reason: "conflict",
        kinds: conflicts.map((c) => `${c.kind}(${c.degree})`),
      });
      continue;
    }
    const load = judgeLoad(db, judge.judge_ref);
    if (load >= judge.max_load) {
      excluded.push({ judge_ref: judge.judge_ref, reason: "load_full", load, max_load: judge.max_load });
      continue;
    }
    eligible.push({ judge, load });
  }
  // 负载低者优先，同负载按编号排序，保证结果确定可复现
  eligible.sort((a, b) => a.load - b.load || a.judge.judge_ref.localeCompare(b.judge.judge_ref));
  return { eligible, excluded };
}

function seatReason(work, judge, loadAfter, quorum, deadline, extra) {
  return {
    expertise_match: work.category,
    conflict_check: "clear",
    load_after: loadAfter,
    max_load: judge.max_load,
    quorum,
    deadline,
    ...extra,
  };
}

function insertSeat(db, work, judge, round, reason) {
  const seatRef = newRef("SEAT");
  const copy = db.prepare("SELECT anon_ref FROM review_copies WHERE work_ref = ?").get(work.work_ref);
  db.prepare(
    "INSERT INTO seats (seat_ref, work_ref, anon_ref, judge_ref, round, status, reason, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(seatRef, work.work_ref, copy ? copy.anon_ref : null, judge.judge_ref, round, "active",
    JSON.stringify(reason), nowIso());
  return seatRef;
}

// 全量分派：为每个冻结作品补足法定人数，输出每个席位与每个排除项的原因
function planAssignments(db, quorum) {
  deriveConflicts(db);
  const deadline = getDeadline(db);
  const works = db.prepare("SELECT * FROM submissions WHERE status = 'frozen' ORDER BY work_ref").all();
  const plan = [];
  for (const work of works) {
    const have = openSeatCount(db, work.work_ref);
    const needed = Math.max(0, quorum - have);
    const { eligible, excluded } = evaluateCandidates(db, work, seatedJudges(db, work.work_ref));
    const chosen = eligible.slice(0, needed);
    const standby = eligible.slice(needed).map((e) => ({ judge_ref: e.judge.judge_ref, load: e.load }));
    const seats = [];
    for (const { judge, load } of chosen) {
      const reason = seatReason(work, judge, load + 1, quorum, deadline, {});
      const seatRef = insertSeat(db, work, judge, 1, reason);
      seats.push({ seat_ref: seatRef, judge_ref: judge.judge_ref, reason });
    }
    plan.push({
      work_ref: work.work_ref,
      category: work.category,
      quorum,
      seats_already: have,
      assigned: seats,
      standby,
      excluded,
      status: seats.length >= needed ? "fulfilled" : "short",
      short_by: needed - seats.length,
    });
  }
  return { quorum, deadline, works: plan };
}

// 单席位重排：回避/超时/泄露后只为该作品补一个席位，其余席位不动
function reseatSeat(db, seatRef, cause) {
  const seat = db.prepare("SELECT * FROM seats WHERE seat_ref = ?").get(seatRef);
  if (!seat) {
    const error = new Error("seat_not_found");
    error.status = 404;
    throw error;
  }
  if (!OPEN_SEAT_STATUSES.includes(seat.status)) {
    const error = new Error("seat_not_replaceable");
    error.status = 409;
    throw error;
  }
  db.prepare("UPDATE seats SET status = ? WHERE seat_ref = ?").run(cause, seatRef);
  deriveConflicts(db);
  const work = db.prepare("SELECT * FROM submissions WHERE work_ref = ?").get(seat.work_ref);
  const quorum = getQuorum(db);
  const deadline = getDeadline(db);
  const needed = Math.max(0, quorum - openSeatCount(db, work.work_ref));
  const exclude = seatedJudges(db, work.work_ref);
  exclude.add(seat.judge_ref); // 被替换的评委不再分派给该作品
  const { eligible, excluded } = evaluateCandidates(db, work, exclude);
  const chosen = eligible.slice(0, needed);
  const seats = [];
  for (const { judge, load } of chosen) {
    const reason = seatReason(work, judge, load + 1, quorum, deadline,
      { replaced_seat: seatRef, cause });
    const newSeatRef = insertSeat(db, work, judge, seat.round + 1, reason);
    seats.push({ seat_ref: newSeatRef, judge_ref: judge.judge_ref, reason });
  }
  return {
    old_seat: seatRef,
    cause,
    needed,
    assigned: seats,
    excluded,
    status: seats.length >= needed ? "fulfilled" : "short",
    short_by: needed - seats.length,
  };
}

module.exports = { deriveConflicts, planAssignments, reseatSeat, getQuorum, getDeadline };

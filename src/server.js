const http = require("node:http");
const path = require("node:path");
const { openDatabase } = require("./db");
const { nowIso, hashObject, newRef, sha256 } = require("./lib");
const { planAssignments, reseatSeat, getQuorum } = require("./assignment");

const ROLES = ["admin", "assignment_officer", "judge", "reviewer", "award_confirmer", "appeal_officer"];

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function createServer(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH
    || path.join(process.cwd(), "data", "app.sqlite3");
  const db = openDatabase(databasePath);

  function requireRole(actor, roles) {
    if (!actor) throw new HttpError(401, "unauthenticated");
    if (!roles.includes(actor.role)) throw new HttpError(403, "forbidden");
  }

  // 追加式审计：每条记录携带前一条的摘要，形成可校验的哈希链
  function audit(actor, action, targetRef, detail) {
    const prev = db.prepare("SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1").get();
    const prevHash = prev ? prev.entry_hash : "GENESIS";
    const createdAt = nowIso();
    const entry = {
      prev_hash: prevHash,
      actor_ref: actor ? actor.actor_ref : null,
      role: actor ? actor.role : null,
      action,
      target_ref: targetRef || null,
      detail: detail || null,
      created_at: createdAt,
    };
    const entryHash = hashObject(entry);
    db.prepare(
      "INSERT INTO audit_log (actor_ref, role, action, target_ref, detail, prev_hash, entry_hash, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(entry.actor_ref, entry.role, action, entry.target_ref,
      entry.detail ? JSON.stringify(entry.detail) : null, prevHash, entryHash, createdAt);
  }

  // 有效评分集合：仅统计仍处于 scored 状态的席位；被回避/超时/泄露的席位
  // 评分保持密封存档，不参与计分，也绝不被改写
  function validScores(workRef) {
    return db.prepare(
      `SELECT sc.seat_ref, sc.score, sc.sealed_at, sc.score_hash
       FROM scores sc JOIN seats st ON st.seat_ref = sc.seat_ref
       WHERE st.work_ref = ? AND st.status = 'scored'
       ORDER BY sc.sealed_at, sc.seat_ref`
    ).all(workRef);
  }

  function tallyFor(workRef) {
    const scores = validScores(workRef);
    const quorum = getQuorum(db);
    if (scores.length < quorum) {
      throw new HttpError(409, "quorum_not_reached", { sealed: scores.length, quorum });
    }
    const average = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    return {
      quorum,
      count: scores.length,
      average,
      score_set_hash: hashObject(scores.map((s) => s.score_hash).sort()),
      scores,
    };
  }

  const routes = [];
  function route(method, pattern, roles, handler) {
    routes.push({ method, segments: pattern.split("/").filter(Boolean), roles, handler });
  }

  route("GET", "/health", null, async () => ({ body: { status: "ok" } }));

  // ---- 主体与权限 ----

  route("POST", "/actors", null, async ({ body, actor }) => {
    const count = db.prepare("SELECT COUNT(*) AS c FROM actors").get().c;
    if (count === 0) {
      if (body.role !== "admin") throw new HttpError(400, "bootstrap_requires_admin");
    } else {
      requireRole(actor, ["admin"]);
    }
    if (!body.actor_ref || !ROLES.includes(body.role)) throw new HttpError(400, "invalid_actor");
    db.prepare("INSERT INTO actors (actor_ref, role, created_at) VALUES (?,?,?)")
      .run(body.actor_ref, body.role, nowIso());
    audit({ actor_ref: body.actor_ref, role: body.role }, "actor_registered", body.actor_ref, { role: body.role });
    return { status: 201, body: { actor_ref: body.actor_ref, role: body.role } };
  });

  route("POST", "/judges", ["admin"], async ({ body, actor }) => {
    if (!body.judge_ref) throw new HttpError(400, "invalid_judge");
    const expertise = Array.isArray(body.expertise) ? body.expertise : [];
    db.prepare(
      `INSERT INTO judges (judge_ref, institution_ref, expertise, max_load, active, created_at)
       VALUES (?,?,?,?,1,?)
       ON CONFLICT(judge_ref) DO UPDATE SET
         institution_ref = excluded.institution_ref,
         expertise = excluded.expertise,
         max_load = excluded.max_load`
    ).run(body.judge_ref, body.institution_ref || null, JSON.stringify(expertise),
      body.max_load || 12, nowIso());
    db.prepare("INSERT OR IGNORE INTO actors (actor_ref, role, created_at) VALUES (?,?,?)")
      .run(body.judge_ref, "judge", nowIso());
    audit(actor, "judge_registered", body.judge_ref, { expertise, max_load: body.max_load || 12 });
    return { status: 201, body: { judge_ref: body.judge_ref } };
  });

  route("POST", "/judges/:judge_ref/declarations", ["admin", "assignment_officer", "judge"], async ({ params, body, actor }) => {
    if (actor.role === "judge" && actor.actor_ref !== params.judge_ref) throw new HttpError(403, "forbidden");
    if (!["work", "institution", "member"].includes(body.target_type) || !body.target_ref) {
      throw new HttpError(400, "invalid_declaration");
    }
    db.prepare("INSERT INTO judge_declarations (judge_ref, target_type, target_ref, detail, created_at) VALUES (?,?,?,?,?)")
      .run(params.judge_ref, body.target_type, body.target_ref, body.detail || null, nowIso());
    audit(actor, "conflict_declared", params.judge_ref,
      { target_type: body.target_type, target_ref: body.target_ref });
    return { status: 201, body: { ok: true } };
  });

  // ---- 收件与冻结 ----

  route("POST", "/submissions", ["admin"], async ({ body, actor }) => {
    for (const key of ["work_ref", "category", "title", "file_ref", "file_sha256", "submitted_at"]) {
      if (!body[key]) throw new HttpError(400, "invalid_submission");
    }
    db.prepare(
      `INSERT INTO submissions (work_ref, category, title, institution_ref, region_ref, file_ref, file_sha256, submitted_at, status)
       VALUES (?,?,?,?,?,?,?,?,'received')`
    ).run(body.work_ref, body.category, body.title, body.institution_ref || null,
      body.region_ref || null, body.file_ref, body.file_sha256, body.submitted_at);
    const members = Array.isArray(body.members) ? body.members : [];
    for (const member of members) {
      if (!member.member_ref) throw new HttpError(400, "invalid_member");
      db.prepare("INSERT INTO work_members (work_ref, member_ref, role) VALUES (?,?,?)")
        .run(body.work_ref, member.member_ref, member.role || "creator");
    }
    audit(actor, "submission_received", body.work_ref, { category: body.category, members: members.length });
    return { status: 201, body: { work_ref: body.work_ref, status: "received" } };
  });

  route("POST", "/relations", ["admin"], async ({ body, actor }) => {
    if (!body.member_ref || !body.related_member_ref || !body.relation) {
      throw new HttpError(400, "invalid_relation");
    }
    db.prepare("INSERT OR IGNORE INTO member_relations (member_ref, related_member_ref, relation) VALUES (?,?,?)")
      .run(body.member_ref, body.related_member_ref, body.relation);
    audit(actor, "relation_recorded", body.member_ref,
      { related: body.related_member_ref, relation: body.relation });
    return { status: 201, body: { ok: true } };
  });

  route("POST", "/submissions/:work_ref/withdraw", ["admin"], async ({ params, actor }) => {
    const info = db.prepare("UPDATE submissions SET status = 'withdrawn' WHERE work_ref = ? AND status = 'received'")
      .run(params.work_ref);
    if (info.changes === 0) throw new HttpError(409, "not_withdrawable");
    audit(actor, "submission_withdrawn", params.work_ref, null);
    return { body: { work_ref: params.work_ref, status: "withdrawn" } };
  });

  route("POST", "/settings", ["admin"], async ({ body, actor }) => {
    if (!body.key || body.value === undefined) throw new HttpError(400, "invalid_setting");
    db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(body.key, String(body.value));
    audit(actor, "setting_updated", body.key, { value: String(body.value) });
    return { body: { key: body.key, value: String(body.value) } };
  });

  // 截止冻结：锁定实际参评版本，生成不含院校、地区、成员身份的匿名评审副本
  route("POST", "/freeze", ["admin"], async ({ actor }) => {
    const rows = db.prepare("SELECT * FROM submissions WHERE status = 'received' ORDER BY work_ref").all();
    const frozenAt = nowIso();
    const scrubbedFields = ["title", "institution_ref", "region_ref", "members", "file_ref", "file_metadata"];
    const frozen = [];
    for (const row of rows) {
      const anonRef = newRef("ANON");
      const copyHash = sha256(`${row.file_sha256}|${anonRef}|scrubbed`);
      db.prepare("INSERT INTO frozen_versions (work_ref, version_no, file_sha256, frozen_at) VALUES (?,?,?,?)")
        .run(row.work_ref, 1, row.file_sha256, frozenAt);
      db.prepare("INSERT INTO review_copies (anon_ref, work_ref, copy_sha256, scrubbed_fields, created_at) VALUES (?,?,?,?,?)")
        .run(anonRef, row.work_ref, copyHash, JSON.stringify(scrubbedFields), frozenAt);
      db.prepare("UPDATE submissions SET status = 'frozen' WHERE work_ref = ?").run(row.work_ref);
      frozen.push(row.work_ref);
    }
    audit(actor, "submissions_frozen", null, { count: frozen.length, works: frozen });
    return { body: { frozen: frozen.length, works: frozen } };
  });

  // ---- 分派 ----

  route("POST", "/assignments/run", ["assignment_officer"], async ({ body, actor }) => {
    const quorum = body.quorum || getQuorum(db);
    const plan = planAssignments(db, quorum);
    audit(actor, "assignments_planned", null, {
      quorum,
      works: plan.works.map((w) => ({ work_ref: w.work_ref, assigned: w.assigned.length, status: w.status })),
    });
    return { body: plan };
  });

  route("GET", "/assignments", ["assignment_officer", "admin"], async ({ query }) => {
    const workRef = query.get("work_ref");
    const seats = workRef
      ? db.prepare("SELECT * FROM seats WHERE work_ref = ? ORDER BY created_at, seat_ref").all(workRef)
      : db.prepare("SELECT * FROM seats ORDER BY created_at, seat_ref").all();
    return { body: { seats: seats.map((s) => ({ ...s, reason: s.reason ? JSON.parse(s.reason) : null })) } };
  });

  route("GET", "/conflicts", ["assignment_officer", "admin"], async ({ query }) => {
    const workRef = query.get("work_ref");
    const rows = workRef
      ? db.prepare("SELECT * FROM conflicts WHERE work_ref = ? ORDER BY judge_ref, kind").all(workRef)
      : db.prepare("SELECT * FROM conflicts ORDER BY work_ref, judge_ref, kind").all();
    return { body: { conflicts: rows } };
  });

  function reseatHandler(cause) {
    return async ({ params, body, actor }) => {
      const seat = db.prepare("SELECT * FROM seats WHERE seat_ref = ?").get(params.seat_ref);
      if (!seat) throw new HttpError(404, "seat_not_found");
      if (cause === "recused" && actor.role === "judge" && seat.judge_ref !== actor.actor_ref) {
        throw new HttpError(403, "forbidden");
      }
      const result = reseatSeat(db, params.seat_ref, cause);
      audit(actor, `seat_${cause}`, params.seat_ref, {
        judge_ref: seat.judge_ref,
        replacement: result.assigned.map((s) => s.seat_ref),
        reason: body.reason || null,
      });
      return { body: result };
    };
  }
  route("POST", "/seats/:seat_ref/recuse", ["judge", "assignment_officer", "admin"], reseatHandler("recused"));
  route("POST", "/seats/:seat_ref/timeout", ["assignment_officer", "admin"], reseatHandler("timed_out"));
  route("POST", "/seats/:seat_ref/leak", ["assignment_officer", "admin"], reseatHandler("leaked"));

  // ---- 评委侧（只见匿名编号） ----

  route("GET", "/judge/seats", ["judge"], async ({ actor }) => {
    const seats = db.prepare(
      `SELECT s.seat_ref, s.anon_ref, s.status, s.round, s.created_at, sub.category
       FROM seats s JOIN submissions sub ON sub.work_ref = s.work_ref
       WHERE s.judge_ref = ? ORDER BY s.created_at, s.seat_ref`
    ).all(actor.actor_ref);
    return { body: { seats } };
  });

  route("GET", "/works/:anon_ref", ["judge"], async ({ params, actor }) => {
    const copy = db.prepare("SELECT * FROM review_copies WHERE anon_ref = ?").get(params.anon_ref);
    if (!copy) throw new HttpError(404, "not_found");
    const seat = db.prepare(
      "SELECT seat_ref FROM seats WHERE anon_ref = ? AND judge_ref = ? AND status IN ('active','scored')"
    ).get(params.anon_ref, actor.actor_ref);
    if (!seat) throw new HttpError(403, "not_assigned");
    const work = db.prepare("SELECT category FROM submissions WHERE work_ref = ?").get(copy.work_ref);
    return {
      body: {
        anon_ref: copy.anon_ref,
        category: work.category,
        copy_sha256: copy.copy_sha256,
        scrubbed_fields: JSON.parse(copy.scrubbed_fields),
      },
    };
  });

  // ---- 密封评分 ----

  route("POST", "/scores", ["judge"], async ({ body, actor }) => {
    const seat = db.prepare("SELECT * FROM seats WHERE seat_ref = ?").get(body.seat_ref || "");
    if (!seat) throw new HttpError(404, "seat_not_found");
    if (seat.judge_ref !== actor.actor_ref) throw new HttpError(403, "forbidden");
    if (seat.status !== "active") throw new HttpError(409, "seat_not_active");
    const score = Number(body.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new HttpError(400, "invalid_score");
    const sealedAt = nowIso();
    const scoreHash = hashObject({
      seat_ref: seat.seat_ref,
      work_ref: seat.work_ref,
      judge_ref: seat.judge_ref,
      score,
      comment: body.comment || null,
      sealed_at: sealedAt,
    });
    db.prepare("INSERT INTO scores (seat_ref, work_ref, judge_ref, score, comment, sealed_at, score_hash) VALUES (?,?,?,?,?,?,?)")
      .run(seat.seat_ref, seat.work_ref, seat.judge_ref, score, body.comment || null, sealedAt, scoreHash);
    db.prepare("UPDATE seats SET status = 'scored' WHERE seat_ref = ?").run(seat.seat_ref);
    audit(actor, "score_sealed", seat.seat_ref, { score_hash: scoreHash });
    return { status: 201, body: { seat_ref: seat.seat_ref, sealed_at: sealedAt, score_hash: scoreHash } };
  });

  // 达到法定人数前，评委彼此不可见评分
  route("GET", "/works/:anon_ref/scores", ["judge"], async ({ params, actor }) => {
    const copy = db.prepare("SELECT * FROM review_copies WHERE anon_ref = ?").get(params.anon_ref);
    if (!copy) throw new HttpError(404, "not_found");
    const ownSeat = db.prepare("SELECT seat_ref FROM seats WHERE anon_ref = ? AND judge_ref = ?")
      .get(params.anon_ref, actor.actor_ref);
    if (!ownSeat) throw new HttpError(403, "not_assigned");
    const quorum = getQuorum(db);
    const sealed = validScores(copy.work_ref);
    if (sealed.length < quorum) {
      throw new HttpError(403, "quorum_not_reached", { sealed: sealed.length, quorum });
    }
    return { body: { anon_ref: params.anon_ref, quorum, scores: sealed } };
  });

  route("GET", "/tally/:work_ref", ["admin", "award_confirmer", "reviewer"], async ({ params }) => {
    const work = db.prepare("SELECT * FROM submissions WHERE work_ref = ?").get(params.work_ref);
    if (!work) throw new HttpError(404, "not_found");
    const tally = tallyFor(params.work_ref);
    return { body: { work_ref: work.work_ref, category: work.category, ...tally } };
  });

  // ---- 同分复议与定奖（不同权限，各自留痕） ----

  route("POST", "/reconsiderations", ["reviewer"], async ({ body, actor }) => {
    if (!Array.isArray(body.work_refs) || body.work_refs.length < 2 || !body.reason) {
      throw new HttpError(400, "invalid_reconsideration");
    }
    const ref = newRef("REC");
    db.prepare("INSERT INTO reconsiderations (reconsideration_ref, work_refs, reason, opened_by, created_at) VALUES (?,?,?,?,?)")
      .run(ref, JSON.stringify(body.work_refs), body.reason, actor.actor_ref, nowIso());
    audit(actor, "reconsideration_opened", ref, { work_refs: body.work_refs, reason: body.reason });
    return { status: 201, body: { reconsideration_ref: ref, status: "open" } };
  });

  route("POST", "/reconsiderations/:ref/resolve", ["reviewer"], async ({ params, body, actor }) => {
    const info = db.prepare(
      "UPDATE reconsiderations SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE reconsideration_ref = ? AND status = 'open'"
    ).run(body.resolution || null, actor.actor_ref, nowIso(), params.ref);
    if (info.changes === 0) throw new HttpError(409, "not_resolvable");
    audit(actor, "reconsideration_resolved", params.ref, { resolution: body.resolution || null });
    return { body: { reconsideration_ref: params.ref, status: "resolved" } };
  });

  route("POST", "/awards", ["award_confirmer"], async ({ body, actor }) => {
    if (!body.work_ref || !body.award_name) throw new HttpError(400, "invalid_award");
    const work = db.prepare("SELECT * FROM submissions WHERE work_ref = ? AND status = 'frozen'").get(body.work_ref);
    if (!work) throw new HttpError(404, "work_not_frozen");
    const tally = tallyFor(work.work_ref);
    // 同类别同分必须先完成复议
    const peers = db.prepare(
      "SELECT work_ref FROM submissions WHERE category = ? AND status = 'frozen' AND work_ref != ?"
    ).all(work.category, work.work_ref);
    const tied = [];
    for (const peer of peers) {
      try {
        const other = tallyFor(peer.work_ref);
        if (Math.abs(other.average - tally.average) < 1e-9) tied.push(peer.work_ref);
      } catch (error) {
        if (!(error instanceof HttpError && error.code === "quorum_not_reached")) throw error;
      }
    }
    if (tied.length > 0) {
      const resolved = db.prepare("SELECT work_refs FROM reconsiderations WHERE status = 'resolved'").all();
      const covered = resolved.some((row) => {
        const refs = JSON.parse(row.work_refs);
        return refs.includes(work.work_ref) && tied.every((t) => refs.includes(t));
      });
      if (!covered) throw new HttpError(409, "tie_requires_reconsideration", { tied_with: tied });
    }
    const frozen = db.prepare("SELECT * FROM frozen_versions WHERE work_ref = ?").get(work.work_ref);
    const conflicts = db.prepare(
      "SELECT judge_ref, kind, degree FROM conflicts WHERE work_ref = ? ORDER BY judge_ref, kind"
    ).all(work.work_ref);
    const invalidatedSeats = db.prepare(
      "SELECT seat_ref, status FROM seats WHERE work_ref = ? AND status IN ('recused','timed_out','leaked') ORDER BY seat_ref"
    ).all(work.work_ref);
    // 排除记录对外只暴露评委摘要，不暴露评委编号
    const exclusionRecord = {
      conflicts: conflicts.map((c) => ({ judge_hash: sha256(c.judge_ref), kind: c.kind, degree: c.degree })),
      invalidated_seats: invalidatedSeats,
    };
    const scoreSet = tally.scores.map((s) => s.score_hash).sort();
    const awardRef = newRef("AWARD");
    db.prepare(
      `INSERT INTO awards (award_ref, work_ref, award_name, status, average_score, frozen_hash,
         score_set_hash, score_set, exclusion_hash, exclusion_record, confirmed_by, confirmed_at)
       VALUES (?,?,?,'confirmed',?,?,?,?,?,?,?,?)`
    ).run(awardRef, work.work_ref, body.award_name, tally.average, frozen.file_sha256,
      tally.score_set_hash, JSON.stringify(scoreSet), hashObject(exclusionRecord),
      JSON.stringify(exclusionRecord), actor.actor_ref, nowIso());
    audit(actor, "award_confirmed", awardRef, { work_ref: work.work_ref, award_name: body.award_name });
    return {
      status: 201,
      body: {
        award_ref: awardRef,
        work_ref: work.work_ref,
        award_name: body.award_name,
        average_score: tally.average,
        frozen_hash: frozen.file_sha256,
        score_set_hash: tally.score_set_hash,
        exclusion_hash: hashObject(exclusionRecord),
      },
    };
  });

  route("POST", "/awards/:award_ref/publish", ["admin"], async ({ params, actor }) => {
    const info = db.prepare("UPDATE awards SET status = 'published', published_at = ? WHERE award_ref = ? AND status = 'confirmed'")
      .run(nowIso(), params.award_ref);
    if (info.changes === 0) throw new HttpError(409, "not_publishable");
    audit(actor, "award_published", params.award_ref, null);
    return { body: { award_ref: params.award_ref, status: "published" } };
  });

  // 公开核验：冻结版本、有效评分集合、冲突排除记录三者可独立复算
  route("GET", "/awards/:award_ref/verification", null, async ({ params }) => {
    const award = db.prepare("SELECT * FROM awards WHERE award_ref = ?").get(params.award_ref);
    if (!award) throw new HttpError(404, "not_found");
    const frozen = db.prepare("SELECT * FROM frozen_versions WHERE work_ref = ?").get(award.work_ref);
    const scoreSet = JSON.parse(award.score_set);
    const found = scoreSet.filter(
      (hash) => db.prepare("SELECT 1 AS x FROM scores WHERE score_hash = ?").get(hash)
    );
    const exclusionRecord = JSON.parse(award.exclusion_record);
    const checks = {
      frozen_version: {
        stored: award.frozen_hash,
        current: frozen ? frozen.file_sha256 : null,
        match: Boolean(frozen) && frozen.file_sha256 === award.frozen_hash,
      },
      score_set: {
        stored_hash: award.score_set_hash,
        recomputed_hash: hashObject(scoreSet),
        sealed_scores_found: found.length,
        sealed_scores_expected: scoreSet.length,
        match: hashObject(scoreSet) === award.score_set_hash && found.length === scoreSet.length,
      },
      exclusion_record: {
        stored_hash: award.exclusion_hash,
        recomputed_hash: hashObject(exclusionRecord),
        match: hashObject(exclusionRecord) === award.exclusion_hash,
      },
    };
    const verified = Object.values(checks).every((check) => check.match);
    return {
      body: {
        award_ref: award.award_ref,
        work_ref: award.work_ref,
        award_name: award.award_name,
        status: award.status,
        average_score: award.average_score,
        checks,
        verified,
      },
    };
  });

  // ---- 申诉：只核对本作品的资格、分派与计分，不暴露评委身份与他作品信息 ----

  route("POST", "/appeals", ["appeal_officer", "admin"], async ({ body, actor }) => {
    const work = db.prepare("SELECT work_ref FROM submissions WHERE work_ref = ?").get(body.work_ref || "");
    if (!work) throw new HttpError(404, "not_found");
    const ref = newRef("APL");
    db.prepare("INSERT INTO appeals (appeal_ref, work_ref, grounds, created_at) VALUES (?,?,?,?)")
      .run(ref, body.work_ref, body.grounds || null, nowIso());
    audit(actor, "appeal_opened", ref, { work_ref: body.work_ref });
    return { status: 201, body: { appeal_ref: ref, status: "open" } };
  });

  route("GET", "/appeals/:appeal_ref/review", ["appeal_officer"], async ({ params }) => {
    const appeal = db.prepare("SELECT * FROM appeals WHERE appeal_ref = ?").get(params.appeal_ref);
    if (!appeal) throw new HttpError(404, "not_found");
    const work = db.prepare("SELECT * FROM submissions WHERE work_ref = ?").get(appeal.work_ref);
    const frozen = db.prepare("SELECT * FROM frozen_versions WHERE work_ref = ?").get(appeal.work_ref);
    const seats = db.prepare(
      "SELECT seat_ref, round, status, reason, created_at FROM seats WHERE work_ref = ? ORDER BY created_at, seat_ref"
    ).all(appeal.work_ref);
    const conflictSummary = db.prepare(
      "SELECT kind, degree, COUNT(*) AS count FROM conflicts WHERE work_ref = ? GROUP BY kind, degree ORDER BY kind"
    ).all(appeal.work_ref);
    const quorum = getQuorum(db);
    const sealed = validScores(appeal.work_ref);
    const scoring = { quorum, sealed: sealed.length };
    if (sealed.length >= quorum) {
      scoring.scores = sealed.map((s) => ({
        seat_ref: s.seat_ref, score: s.score, sealed_at: s.sealed_at, score_hash: s.score_hash,
      }));
      scoring.average = sealed.reduce((sum, s) => sum + s.score, 0) / sealed.length;
      scoring.score_set_hash = hashObject(sealed.map((s) => s.score_hash).sort());
    }
    return {
      body: {
        appeal_ref: appeal.appeal_ref,
        work_ref: appeal.work_ref,
        status: appeal.status,
        eligibility: {
          category: work.category,
          status: work.status,
          submitted_at: work.submitted_at,
          frozen: Boolean(frozen),
          frozen_at: frozen ? frozen.frozen_at : null,
          version_no: frozen ? frozen.version_no : null,
          file_sha256: frozen ? frozen.file_sha256 : null,
        },
        assignment: {
          seats: seats.map((s) => ({ ...s, reason: s.reason ? JSON.parse(s.reason) : null })),
          excluded_conflicts: conflictSummary,
        },
        scoring,
      },
    };
  });

  route("POST", "/appeals/:appeal_ref/resolve", ["appeal_officer"], async ({ params, body, actor }) => {
    const info = db.prepare("UPDATE appeals SET status = 'resolved', resolution = ?, resolved_at = ? WHERE appeal_ref = ? AND status = 'open'")
      .run(body.resolution || null, nowIso(), params.appeal_ref);
    if (info.changes === 0) throw new HttpError(409, "not_resolvable");
    audit(actor, "appeal_resolved", params.appeal_ref, { resolution: body.resolution || null });
    return { body: { appeal_ref: params.appeal_ref, status: "resolved" } };
  });

  // ---- 审计 ----

  route("GET", "/audit", ["admin"], async () => {
    const rows = db.prepare("SELECT * FROM audit_log ORDER BY seq").all();
    return { body: { entries: rows } };
  });

  route("GET", "/audit/verify", ["admin"], async () => {
    const rows = db.prepare("SELECT * FROM audit_log ORDER BY seq").all();
    let prev = "GENESIS";
    for (const row of rows) {
      const entry = {
        prev_hash: row.prev_hash,
        actor_ref: row.actor_ref,
        role: row.role,
        action: row.action,
        target_ref: row.target_ref,
        detail: row.detail ? JSON.parse(row.detail) : null,
        created_at: row.created_at,
      };
      if (row.prev_hash !== prev || hashObject(entry) !== row.entry_hash) {
        return { body: { ok: false, broken_at: row.seq } };
      }
      prev = row.entry_hash;
    }
    return { body: { ok: true, entries: rows.length } };
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      const body = await readJson(request);
      const actorRef = request.headers["x-actor-ref"];
      const actor = actorRef
        ? db.prepare("SELECT actor_ref, role FROM actors WHERE actor_ref = ?").get(actorRef) || null
        : null;
      for (const r of routes) {
        if (r.method !== request.method || r.segments.length !== segments.length) continue;
        const params = {};
        let matched = true;
        for (let i = 0; i < segments.length; i += 1) {
          if (r.segments[i].startsWith(":")) {
            params[r.segments[i].slice(1)] = decodeURIComponent(segments[i]);
          } else if (r.segments[i] !== segments[i]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        if (r.roles) {
          if (!actor) throw new HttpError(401, "unauthenticated");
          if (!r.roles.includes(actor.role)) throw new HttpError(403, "forbidden");
        }
        const result = await r.handler({ params, body, actor, query: url.searchParams });
        send(response, result.status || 200, result.body === undefined ? { ok: true } : result.body);
        return;
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      if (error instanceof HttpError) {
        send(response, error.status, { error: error.code, ...(error.extra || {}) });
      } else {
        send(response, 500, { error: "internal_error" });
      }
    }
  });

  server.db = db;
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };

// 路由装配：所有业务接口位于 /v1 下，角色守卫 + 事务 + 审计一并完成。
const { requireRole, HttpError } = require("./auth");
const { send, requireFields, createRouter } = require("./http");
const { db, transaction, appendAudit } = require("./db");
const util = require("./util");
const anonymize = require("./anonymize");
const assignment = require("./assignment");
const scoring = require("./scoring");
const appeals = require("./appeals");
const auditVerify = require("./audit");

// 执行业务并在同一事务中追加审计
function audit(actor, action, entityType, entityId, fn) {
  return transaction((database) => {
    const result = fn(database);
    appendAudit(database, { actor, action, entityType, entityId: entityId || "", detail: result && result._audit ? result._audit : {} });
    if (result && result._audit) delete result._audit;
    return result;
  });
}

function getRound(database, roundId) {
  const round = database.prepare("SELECT * FROM rounds WHERE round_id = ?").get(roundId);
  if (!round) throw new HttpError(404, "round_not_found", "轮次不存在");
  return round;
}

function routes() {
  const r = [];
  const add = (method, pattern, roles, handler) =>
    r.push({ method, pattern, roles: roles || [], handler });

  // -------------------------------------------------------------------------
  // 令牌签发（SECRETARIAT）
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/tokens$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["subject_id", "subject_kind", "roles"]);
    if (!Array.isArray(body.roles) || body.roles.length === 0) {
      throw new HttpError(400, "bad_roles", "roles 必须是非空数组");
    }
    const plaintext = util.randomToken();
    const tokenId = util.newId("tok");
    const result = audit(actor, "issue_token", "api_token", tokenId, (database) => {
      database
        .prepare(
          `INSERT INTO api_tokens(token_id, token_hash, subject_id, subject_kind, roles_json, label, issued_at)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          tokenId,
          util.sha256(plaintext),
          body.subject_id,
          body.subject_kind,
          util.stableStringify(body.roles),
          body.label || "",
          util.now()
        );
      return {
        token: plaintext,
        token_id: tokenId,
        subject_id: body.subject_id,
        subject_kind: body.subject_kind,
        roles: body.roles,
        _audit: { subject_id: body.subject_id, kind: body.subject_kind, roles: body.roles },
      };
    });
    send(res, 201, result); // 明文令牌仅此一次返回
  });

  add("POST", /^\/v1\/tokens\/(?<id>[^/]+)\/revoke$/, ["SECRETARIAT"], (req, res, params, _b, _q, actor) => {
    audit(actor, "revoke_token", "api_token", params.id, (database) => {
      const info = database
        .prepare("UPDATE api_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
        .run(util.now(), params.id);
      return { revoked: info.changes > 0 };
    });
    send(res, 200, { token_id: params.id, revoked: true });
  });

  // -------------------------------------------------------------------------
  // 收件：团队 / 成员 / 关系 / 合作单位
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/teams$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["team_id", "team_name", "school", "region"]);
    const result = audit(actor, "create_team", "team", body.team_id, (database) => {
      database
        .prepare("INSERT INTO teams(team_id, team_name, school, region, created_at) VALUES (?,?,?,?,?)")
        .run(body.team_id, body.team_name, body.school, body.region, util.now());
      return { team_id: body.team_id };
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/members$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["member_id", "full_name"]);
    const result = audit(actor, "create_member", "member", body.member_id, (database) => {
      database.prepare("INSERT INTO members(member_id, full_name, created_at) VALUES (?,?,?)").run(
        body.member_id, body.full_name, util.now()
      );
      return { member_id: body.member_id };
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/affiliations$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["member_id", "team_id"]);
    audit(actor, "add_affiliation", "member", body.member_id, (database) => {
      database
        .prepare("INSERT OR IGNORE INTO member_affiliations(member_id, team_id, role) VALUES (?,?,?)")
        .run(body.member_id, body.team_id, body.role || "成员");
      return {};
    });
    send(res, 201, { member_id: body.member_id, team_id: body.team_id });
  });

  add("POST", /^\/v1\/team-relations$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["team_a", "team_b", "kind"]);
    if (body.team_a === body.team_b) throw new HttpError(400, "self_relation", "不能建立团队自关联");
    const [a, b] = body.team_a < body.team_b ? [body.team_a, body.team_b] : [body.team_b, body.team_a];
    audit(actor, "add_team_relation", "team_relation", `${a}|${b}`, (database) => {
      database
        .prepare("INSERT OR IGNORE INTO team_relations(team_a, team_b, kind, detail, created_at) VALUES (?,?,?,?,?)")
        .run(a, b, body.kind, body.detail || "", util.now());
      return {};
    });
    send(res, 201, { team_a: a, team_b: b, kind: body.kind });
  });

  add("POST", /^\/v1\/partner-units$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["team_id", "unit_name"]);
    audit(actor, "add_partner_unit", "team", body.team_id, (database) => {
      database
        .prepare("INSERT OR IGNORE INTO team_partner_units(team_id, unit_name) VALUES (?,?)")
        .run(body.team_id, body.unit_name);
      return {};
    });
    send(res, 201, { team_id: body.team_id, unit_name: body.unit_name });
  });

  // -------------------------------------------------------------------------
  // 收件：作品与版本
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/works$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["work_id", "team_id", "category", "title"]);
    const result = audit(actor, "register_work", "work", body.work_id, (database) => {
      database
        .prepare("INSERT INTO works(work_id, team_id, category, title, submitted_at) VALUES (?,?,?,?,?)")
        .run(body.work_id, body.team_id, body.category, body.title, util.now());
      return { work_id: body.work_id };
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/works\/(?<id>[^/]+)\/versions$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["media_sha256", "media_ref"]);
    const result = audit(actor, "submit_version", "work", params.id, (database) => {
      const work = database.prepare("SELECT * FROM works WHERE work_id = ?").get(params.id);
      if (!work) throw new HttpError(404, "work_not_found", "作品不存在");
      if (work.status !== "received") throw new HttpError(409, "work_frozen", "截止冻结后不得再提交版本");
      const nextSeq =
        (database.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM work_versions WHERE work_id = ?").get(params.id).n) + 1;
      const versionId = body.version_id || util.newId("ver");
      database
        .prepare(
          `INSERT INTO work_versions(version_id, work_id, seq, media_sha256, media_ref, source_filename, metadata_json, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          versionId, params.id, body.seq || nextSeq, body.media_sha256, body.media_ref,
          body.source_filename || "", util.stableStringify(body.metadata || {}), util.now()
        );
      database.prepare("UPDATE works SET current_version_id = ? WHERE work_id = ?").run(versionId, params.id);
      return { version_id: versionId, work_id: params.id, seq: body.seq || nextSeq, _audit: { version_id: versionId } };
    });
    send(res, 201, result);
  });

  // -------------------------------------------------------------------------
  // 收件：评委、专长、单位关联、指导、回避
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/judges$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["judge_id", "full_name"]);
    const result = audit(actor, "register_judge", "judge", body.judge_id, (database) => {
      const fingerprint = body.public_fingerprint || `JP-${util.randomHex(4).toUpperCase()}`;
      database
        .prepare(
          `INSERT INTO judges(judge_id, full_name, school, region, public_fingerprint, created_at)
           VALUES (?,?,?,?,?,?)`
        )
        .run(body.judge_id, body.full_name, body.school || "", body.region || "", fingerprint, util.now());
      for (const category of body.categories || []) {
        database.prepare("INSERT OR IGNORE INTO judge_expertise(judge_id, category) VALUES (?,?)").run(
          body.judge_id, category
        );
      }
      return { judge_id: body.judge_id, public_fingerprint: fingerprint };
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/judges\/(?<id>[^/]+)\/unit-links$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["unit_name", "kind"]);
    audit(actor, "add_judge_unit_link", "judge", params.id, (database) => {
      database
        .prepare("INSERT OR IGNORE INTO judge_unit_links(judge_id, unit_name, kind) VALUES (?,?,?)")
        .run(params.id, body.unit_name, body.kind);
      return {};
    });
    send(res, 201, { judge_id: params.id, unit_name: body.unit_name });
  });

  add("POST", /^\/v1\/judges\/(?<id>[^/]+)\/mentorships$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    const result = audit(actor, "declare_mentorship", "judge", params.id, (database) => {
      if (!body.team_id && !body.work_id && !body.member_id) {
        throw new HttpError(400, "missing_anchor", "指导经历至少锚定团队/作品/成员之一");
      }
      const info = database
        .prepare(
          `INSERT INTO judge_mentorships(judge_id, team_id, work_id, member_id, detail, declared_at)
           VALUES (?,?,?,?,?,?)`
        )
        .run(params.id, body.team_id || null, body.work_id || null, body.member_id || null, body.detail || "", util.now());
      return { id: info.lastInsertRowid };
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/judges\/(?<id>[^/]+)\/recusals$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["scope"]);
    if (!["TEAM", "WORK"].includes(body.scope)) throw new HttpError(400, "bad_scope", "scope 必须是 TEAM 或 WORK");
    const result = audit(actor, "declare_recusal", "judge", params.id, (database) => {
      const info = database
        .prepare(
          `INSERT INTO judge_recusals(judge_id, scope, team_id, work_id, reason, declared_at)
           VALUES (?,?,?,?,?,?)`
        )
        .run(params.id, body.scope, body.team_id || null, body.work_id || null, body.reason || "", util.now());
      return { id: info.lastInsertRowid };
    });
    send(res, 201, result);
  });

  // -------------------------------------------------------------------------
  // 截止冻结与匿名副本
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/freezes$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["name"]);
    const freezeId = util.newId("frz");
    const result = audit(actor, "freeze_submissions", "freeze", freezeId, (database) => {
      return anonymize.freezeSubmissions(database, {
        freezeId,
        name: body.name,
        triggeredBy: actor.id,
        note: body.note || "",
      });
    });
    send(res, 201, result);
  });

  add("GET", /^\/v1\/freezes\/(?<id>[^/]+)$/, ["SECRETARIAT"], (req, res, params) => {
    const database = db();
    const freeze = database.prepare("SELECT freeze_id, name, note, created_at, triggered_by FROM freeze_events WHERE freeze_id = ?").get(params.id);
    if (!freeze) throw new HttpError(404, "freeze_not_found", "冻结事件不存在");
    const items = database
      .prepare("SELECT item_id, category, active, replaces_item_id, copy_sha256, scrub_report_json FROM frozen_items WHERE freeze_id = ?")
      .all(params.id);
    const exclusions = database.prepare("SELECT work_id, reason FROM freeze_exclusions WHERE freeze_id = ?").all(params.id);
    const envelope = database
      .prepare("SELECT envelope_id, content_sha256, opened_at, opened_by FROM identity_envelopes WHERE freeze_id = ?")
      .get(params.id);
    send(res, 200, {
      ...freeze,
      items: items.map((i) => ({ ...i, active: !!i.active, scrub_report: util.parseJsonObject(i.scrub_report_json) })),
      exclusions,
      envelope,
    });
  });

  // 副本泄露：换发全新匿名副本（旧副本立即失效）
  add("POST", /^\/v1\/items\/(?<id>[^/]+)\/leak-replacement$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    const result = audit(actor, "replace_leaked_copy", "frozen_item", params.id, (database) => {
      return anonymize.replaceLeakedCopy(database, { oldItemId: params.id, reason: body.reason || "", actor });
    });
    send(res, 201, result);
  });

  // 双人开启密封信封：Authorization 为 SECRETARIAT，X-Co-Authorization 为 AUDITOR
  add("POST", /^\/v1\/envelopes\/(?<id>[^/]+)\/open$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["reason"]);
    const coHeader = req.headers["x-co-authorization"] || "";
    const coMatch = /^Bearer\s+(\S+)$/i.exec(coHeader);
    if (!coMatch) throw new HttpError(401, "co_authorization_required", "开启信封需 AUDITOR 令牌于 X-Co-Authorization 共同授权");
    const { authenticate } = require("./auth");
    const coActor = authenticate({ headers: { authorization: coHeader } });
    if (!coActor || !coActor.roles.includes("AUDITOR")) {
      throw new HttpError(403, "co_authorization_forbidden", "共同授权人必须具备 AUDITOR 角色");
    }
    const result = audit(actor, "open_identity_envelope", "identity_envelope", params.id, (database) => {
      const opened = anonymize.openEnvelope(database, {
        envelopeId: params.id,
        openedBy: actor.id,
        coAuthorizedBy: coActor.id,
        reason: body.reason,
      });
      opened._audit = { co_authorized_by: coActor.id, reason: body.reason, item_count: opened.mapping.items.length };
      return opened;
    });
    send(res, 200, result);
  });

  // -------------------------------------------------------------------------
  // 轮次与分派
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/rounds$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["name", "freeze_id", "categories", "quorum", "max_load", "deadline_at"]);
    if (!Array.isArray(body.categories) || body.categories.length === 0) {
      throw new HttpError(400, "bad_categories", "categories 必须是非空数组");
    }
    if (Number.isNaN(Date.parse(body.deadline_at))) throw new HttpError(400, "bad_deadline", "截止时间不是合法 ISO 8601");
    const roundId = util.newId("rnd");
    const result = audit(actor, "create_round", "round", roundId, (database) => {
      const freeze = database.prepare("SELECT 1 FROM freeze_events WHERE freeze_id = ?").get(body.freeze_id);
      if (!freeze) throw new HttpError(404, "freeze_not_found", "冻结事件不存在");
      database
        .prepare(
          `INSERT INTO rounds(round_id, freeze_id, name, quorum, max_load, deadline_at, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(roundId, body.freeze_id, body.name, body.quorum, body.max_load, body.deadline_at, actor.id, util.now());
      for (const category of body.categories) {
        database.prepare("INSERT OR IGNORE INTO round_categories(round_id, category) VALUES (?,?)").run(roundId, category);
      }
      return { round_id: roundId };
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/rounds\/(?<id>[^/]+)\/assign$/, ["SECRETARIAT"], (req, res, params, _b, _q, actor) => {
    const result = audit(actor, "assign_round", "round", params.id, (database) => {
      const round = getRound(database, params.id);
      return assignment.assignRound(database, round, actor);
    });
    send(res, 201, result);
  });

  // 分派解释矩阵：每件作品每位评委的排查结论与原因。
  // 分派前返回实时候选评估；分派后返回落库的排查留痕（assigned/conflict/no_expertise/at_capacity）。
  add("GET", /^\/v1\/rounds\/(?<id>[^/]+)\/plan$/, ["SECRETARIAT"], (req, res, params) => {
    const database = db();
    const round = getRound(database, params.id);
    const stored = database
      .prepare("SELECT COUNT(*) AS n FROM conflict_exclusions WHERE round_id = ?")
      .get(round.round_id).n;
    const plan = {};
    if (stored > 0) {
      const rows = database
        .prepare(
          `SELECT e.item_id, e.outcome, e.reasons_json, j.public_fingerprint AS fingerprint
             FROM conflict_exclusions e
             JOIN judges j ON j.judge_id = e.judge_id
            WHERE e.round_id = ? ORDER BY e.item_id, e.id`
        )
        .all(round.round_id);
      for (const row of rows) {
        if (!plan[row.item_id]) plan[row.item_id] = [];
        plan[row.item_id].push({
          judge_fingerprint: row.fingerprint,
          outcome: row.outcome,
          reasons: util.parseJsonArray(row.reasons_json),
        });
      }
    } else {
      const { matrix } = assignment.evaluate(database, round);
      for (const [itemId, entries] of matrix) {
        plan[itemId] = entries.map((entry) => ({
          judge_fingerprint: entry.judge.public_fingerprint,
          outcome: entry.outcome,
          reasons: entry.reasons.map((reason) => ({ code: reason.code, kind: reason.kind })),
        }));
      }
    }
    send(res, 200, {
      round_id: round.round_id,
      quorum: round.quorum,
      max_load: round.max_load,
      deadline_at: round.deadline_at,
      plan,
    });
  });

  add("POST", /^\/v1\/rounds\/(?<id>[^/]+)\/sweep-timeouts$/, ["SECRETARIAT"], (req, res, params, _b, _q, actor) => {
    const result = audit(actor, "sweep_timeouts", "round", params.id, (database) => {
      const round = getRound(database, params.id);
      return assignment.sweepTimeouts(database, round, actor);
    });
    send(res, 200, result);
  });

  // 泄露换发后的席位重排
  add("POST", /^\/v1\/rounds\/(?<id>[^/]+)\/reassign-leak$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["old_item_id", "new_item_id"]);
    const result = audit(actor, "reassign_leaked_item", "round", params.id, (database) => {
      const round = getRound(database, params.id);
      return assignment.reassignLeakedItem(database, {
        round,
        oldItemId: body.old_item_id,
        newItemId: body.new_item_id,
        actor,
      });
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/rounds\/(?<id>[^/]+)\/close$/, ["SECRETARIAT"], (req, res, params, _b, _q, actor) => {
    try {
      const result = audit(actor, "close_scoring", "round", params.id, (database) => {
        const round = getRound(database, params.id);
        return scoring.closeScoring(database, round);
      });
      send(res, 200, result);
    } catch (error) {
      if (error.message === "quorum_unmet") throw new HttpError(409, "quorum_unmet", "仍有作品未达法定人数", { pending: error.pending });
      throw error;
    }
  });

  add("GET", /^\/v1\/rounds\/(?<id>[^/]+)\/results$/, ["SECRETARIAT"], (req, res, params, _b, query) => {
    const database = db();
    const round = getRound(database, params.id);
    const categories = query.getAll("category");
    const list = categories.length
      ? categories
      : database.prepare("SELECT category FROM round_categories WHERE round_id = ?").all(params.id).map((row) => row.category);
    const results = Object.fromEntries(list.map((category) => [category, scoring.categoryResults(database, round.round_id, category)]));
    send(res, 200, { round_id: round.round_id, status: round.status, results });
  });

  // -------------------------------------------------------------------------
  // 评委：我的任务、提交、回避
  // -------------------------------------------------------------------------
  add("GET", /^\/v1\/me\/assignments$/, ["JUDGE"], (req, res, _p, _b, _q, actor) => {
    const database = db();
    const rows = database
      .prepare(
        `SELECT s.seat_id, s.round_id, s.status, s.created_at, r.deadline_at,
                i.item_id, i.category, i.copy_ref, i.copy_sha256, i.scrubbed_title, i.scrubbed_synopsis
           FROM seats s
           JOIN rounds r ON r.round_id = s.round_id
           JOIN frozen_items i ON i.item_id = s.item_id
          WHERE s.judge_id = ? AND s.status IN ('assigned','submitted')
          ORDER BY r.deadline_at`
      )
      .all(actor.id);
    send(res, 200, {
      assignments: rows.map((row) => ({
        seat_id: row.seat_id,
        round_id: row.round_id,
        status: row.status,
        deadline_at: row.deadline_at,
        item: {
          item_id: row.item_id,
          category: row.category,
          title: row.scrubbed_title,
          synopsis: row.scrubbed_synopsis,
          copy_ref: row.copy_ref,
          copy_sha256: row.copy_sha256,
        },
      })),
    });
  });

  add("POST", /^\/v1\/seats\/(?<id>[^/]+)\/score$/, ["JUDGE"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["value"]);
    const result = audit(actor, "submit_score", "seat", params.id, (database) => {
      return scoring.submitScore(database, { seatId: params.id, actor, value: body.value, comment: body.comment });
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/seats\/(?<id>[^/]+)\/recuse$/, ["JUDGE"], (req, res, params, body, _q, actor) => {
    const result = audit(actor, "recuse_seat", "seat", params.id, (database) => {
      const seat = database.prepare("SELECT * FROM seats WHERE seat_id = ? AND judge_id = ?").get(params.id, actor.id);
      if (!seat) throw new HttpError(404, "seat_not_found", "席位不存在或不属于你");
      const round = getRound(database, seat.round_id);
      return assignment.recuseSeat(database, { round, seat, actor, reason: body.reason || "" });
    });
    send(res, 201, result);
  });

  // 进度：法定人数前分值不可见；限本人参与作品的评委或秘书处
  add("GET", /^\/v1\/items\/(?<id>[^/]+)\/progress$/, ["JUDGE", "SECRETARIAT"], (req, res, params, _b, query, actor) => {
    const database = db();
    const item = database.prepare("SELECT * FROM frozen_items WHERE item_id = ?").get(params.id);
    if (!item) throw new HttpError(404, "item_not_found", "评审副本不存在");
    const roundId = query.get("round_id");
    if (!roundId) throw new HttpError(400, "missing_round", "需要 round_id 查询参数");
    const round = getRound(database, roundId);
    if (actor.roles.includes("JUDGE") && !actor.roles.includes("SECRETARIAT")) {
      const mine = database
        .prepare("SELECT 1 FROM seats WHERE round_id = ? AND item_id = ? AND judge_id = ? AND status IN ('assigned','submitted')")
        .get(roundId, params.id, actor.id);
      if (!mine) throw new HttpError(403, "not_assigned", "只能查看本人参与作品的进度");
    }
    send(res, 200, scoring.itemProgress(database, round, params.id));
  });

  // -------------------------------------------------------------------------
  // 同分复议
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/tie-groups$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["round_id", "category", "item_ids"]);
    const result = audit(actor, "open_tie", "tie_group", null, (database) => {
      const round = getRound(database, body.round_id);
      return scoring.openTie(database, { round, category: body.category, itemIds: body.item_ids, openedBy: actor.id });
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/tie-groups\/(?<id>[^/]+)\/panel$/, ["SECRETARIAT"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["judge_id"]);
    const result = audit(actor, "add_tie_panelist", "tie_group", params.id, (database) => {
      return scoring.addTiePanelist(database, { tieId: params.id, judgeId: body.judge_id });
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/tie-groups\/(?<id>[^/]+)\/vote$/, ["TIE_REVIEWER"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["ranking"]);
    const result = audit(actor, "cast_tie_vote", "tie_group", params.id, (database) => {
      return scoring.castTieVote(database, { tieId: params.id, actor, ranking: body.ranking, comment: body.comment });
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/tie-groups\/(?<id>[^/]+)\/resolve$/, ["SECRETARIAT"], (req, res, params, _b, _q, actor) => {
    const result = audit(actor, "resolve_tie", "tie_group", params.id, (database) => {
      return scoring.resolveTie(database, { tieId: params.id, actor });
    });
    send(res, 200, result);
  });

  add("GET", /^\/v1\/tie-groups\/(?<id>[^/]+)$/, ["SECRETARIAT", "TIE_REVIEWER", "AUDITOR"], (req, res, params) => {
    const database = db();
    const tie = database.prepare("SELECT * FROM tie_groups WHERE tie_id = ?").get(params.id);
    if (!tie) throw new HttpError(404, "tie_not_found", "复议不存在");
    const panel = database
      .prepare("SELECT j.public_fingerprint FROM tie_panel p JOIN judges j ON j.judge_id = p.judge_id WHERE p.tie_id = ?")
      .all(params.id).map((row) => row.public_fingerprint);
    const voteCount = database.prepare("SELECT COUNT(*) AS n FROM tie_votes WHERE tie_id = ?").get(params.id).n;
    send(res, 200, {
      tie_id: tie.tie_id,
      round_id: tie.round_id,
      category: tie.category,
      item_ids: util.parseJsonArray(tie.item_ids_json),
      tied_score: tie.tied_score,
      status: tie.status,
      panel_fingerprints: panel,
      votes_sealed: voteCount,
      resolution: tie.resolution_json ? util.parseJsonObject(tie.resolution_json) : null,
    });
  });

  // -------------------------------------------------------------------------
  // 奖项：提名 → 确认（异人）→ 发布（异人）→ 公开可验证
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/awards$/, ["SECRETARIAT"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["round_id", "category", "place", "item_id"]);
    const result = audit(actor, "propose_award", "award", null, (database) => {
      const round = getRound(database, body.round_id);
      return scoring.proposeAward(database, {
        round, category: body.category, place: body.place, itemId: body.item_id,
        tieId: body.tie_id || null, actor,
      });
    });
    send(res, 201, result);
  });

  add("POST", /^\/v1\/awards\/(?<id>[^/]+)\/confirm$/, ["AWARD_CONFIRMER"], (req, res, params, _b, _q, actor) => {
    const result = audit(actor, "confirm_award", "award", params.id, (database) => {
      return scoring.confirmAward(database, { awardId: params.id, actor });
    });
    send(res, 200, result);
  });

  add("POST", /^\/v1\/awards\/(?<id>[^/]+)\/publish$/, ["SECRETARIAT"], (req, res, params, _b, _q, actor) => {
    const result = audit(actor, "publish_award", "award", params.id, (database) => {
      return scoring.publishAward(database, { awardId: params.id, actor });
    });
    send(res, 200, result);
  });

  add("GET", /^\/v1\/awards\/(?<id>[^/]+)\/verify$/, ["AUDITOR", "SECRETARIAT"], (req, res, params) => {
    send(res, 200, scoring.verifyAward(db(), params.id));
  });

  // 已发布奖项的证据包：凭奖项编号可公开核验（无需令牌）
  add("GET", /^\/v1\/public\/awards\/(?<id>[^/]+)$/, [], (req, res, params) => {
    const database = db();
    const award = database.prepare("SELECT * FROM awards WHERE award_id = ?").get(params.id);
    if (!award || award.status !== "published") throw new HttpError(404, "award_not_public", "奖项不存在或尚未公布");
    send(res, 200, util.parseJsonObject(award.package_json));
  });

  // -------------------------------------------------------------------------
  // 申诉
  // -------------------------------------------------------------------------
  add("POST", /^\/v1\/appeals$/, ["TEAM"], (req, res, _p, body, _q, actor) => {
    requireFields(body, ["work_id", "reason"]);
    const result = audit(actor, "file_appeal", "appeal", null, (database) => {
      return appeals.fileAppeal(database, { workId: body.work_id, teamId: actor.id, reason: body.reason, actor });
    });
    send(res, 201, result);
  });

  add("GET", /^\/v1\/appeals\/(?<id>[^/]+)\/review$/, ["AUDITOR"], (req, res, params, _b, query, actor) => {
    const scope = query.get("scope") || "eligibility";
    const result = audit(actor, "review_appeal", "appeal", params.id, (database) => {
      return appeals.reviewAppeal(database, { appealId: params.id, scope, actor });
    });
    send(res, 200, result);
  });

  add("POST", /^\/v1\/appeals\/(?<id>[^/]+)\/answer$/, ["AUDITOR"], (req, res, params, body, _q, actor) => {
    requireFields(body, ["resolution_note"]);
    const result = audit(actor, "answer_appeal", "appeal", params.id, (database) => {
      return appeals.answerAppeal(database, { appealId: params.id, resolutionNote: body.resolution_note, actor });
    });
    send(res, 200, result);
  });

  add("GET", /^\/v1\/appeals$/, ["TEAM", "AUDITOR"], (req, res, _p, _b, _q, actor) => {
    const database = db();
    const rows = actor.roles.includes("AUDITOR")
      ? database.prepare("SELECT appeal_id, work_id, status, created_at FROM appeals ORDER BY created_at DESC").all()
      : database.prepare("SELECT appeal_id, work_id, status, created_at FROM appeals WHERE team_id = ? ORDER BY created_at DESC").all(actor.id);
    send(res, 200, { appeals: rows });
  });

  // -------------------------------------------------------------------------
  // 审计核查
  // -------------------------------------------------------------------------
  add("GET", /^\/v1\/audit\/verify$/, ["AUDITOR"], (req, res) => {
    const database = db();
    send(res, 200, {
      audit_chain: auditVerify.verifyAuditChain(database),
      score_chain: auditVerify.verifyScoreChain(database),
      tie_votes: auditVerify.verifyTieVotes(database),
    });
  });

  add("GET", /^\/v1\/audit$/, ["AUDITOR"], (req, res, _p, _b, query) => {
    const database = db();
    const limit = Math.min(Number.parseInt(query.get("limit") || "100", 10), 500);
    const afterSeq = Number.parseInt(query.get("after_seq") || "0", 10);
    const rows = database
      .prepare("SELECT seq, created_at, actor_id, actor_role, action, entity_type, entity_id, detail_json, entry_hash FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(afterSeq, limit);
    send(res, 200, {
      entries: rows.map((row) => ({ ...row, detail_json: util.parseJsonObject(row.detail_json) })),
    });
  });

  return r;
}

// 包装：在 handler 前注入当前 actor（公开接口无需角色）
function buildRoutes() {
  const raw = routes();
  return raw.map((route) => ({
    method: route.method,
    pattern: route.pattern,
    handler: (request, response, params, body, query) => {
      const actor = route.roles.length === 0 ? null : requireRole(request, ...route.roles);
      return route.handler(request, response, params, body, query, actor);
    },
  }));
}

function handler() {
  return createRouter(buildRoutes());
}

module.exports = { handler };

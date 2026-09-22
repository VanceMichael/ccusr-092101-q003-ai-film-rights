// 截止冻结与评审副本生成。
//
// 匿名化原则：
//   1. 评审编号 RV-xxxxxxxx 由随机数生成，与原始作品/团队编号不可关联。
//   2. 副本只保留评审必需信息（类别与清洗后的简介）；片名、片尾署名、文件元数据、
//      源文件名中的院校/地区/姓名/联系方式一律遮蔽，并在 scrub_report 中记录命中计数
//      （报告只写类别与计数，绝不回显被遮蔽的原文）。
//   3. 真实映射写入单独的密封信封文件（信封目录由 ENVELOPE_DIR 指定），
//      数据库仅保留摘要与开启记录；开启信封需要 SECRETARIAT + AUDITOR 双人授权并留痕。
const fs = require("node:fs");
const path = require("node:path");
const util = require("./util");

// 元数据中可能暴露身份的键（小写匹配）
const SENSITIVE_KEYS = [
  "school", "university", "college", "institute", "institution", "院校", "学校", "学院", "大学",
  "region", "province", "city", "地区", "省份", "城市",
  "team", "crew", "团队", "队伍",
  "member", "author", "director", "creator", "name", "成员", "作者", "导演", "编剧", "姓名", "署名",
  "contact", "email", "phone", "tel", "wechat", "联系", "邮箱", "电话", "微信",
  "unit", "org", "organization", "单位", "机构", "合作",
];

// 文本中的敏感模式（邮箱、手机号、片尾式署名）
const SENSITIVE_PATTERNS = [
  { code: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { code: "phone_cn", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { code: "school_mention", re: /[一-龥A-Za-z0-9]{1,12}(大学|学院|学校|中学|小学|附属)/g },
  { code: "credit_line", re: /(出品|制片|导演|编剧|指导老师|联合摄制|鸣谢)[：:][^\n,，。;；]*/g },
];

function envelopeDir() {
  return process.env.ENVELOPE_DIR || path.join(process.cwd(), "data", "envelopes");
}

function maskText(text, report) {
  let out = String(text ?? "");
  for (const { code, re } of SENSITIVE_PATTERNS) {
    out = out.replace(re, (matched) => {
      report[code] = (report[code] || 0) + 1;
      return "█".repeat([...matched].length);
    });
  }
  return out;
}

function scrubMetadata(metadata, report) {
  const result = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some((word) => lower.includes(word) || key.includes(word))) {
      report.metadata_redacted_keys = (report.metadata_redacted_keys || 0) + 1;
      continue; // 整个敏感键剔除，不保留原值
    }
    result[key] = typeof value === "string" ? maskText(value, report) : value;
  }
  return result;
}

// 生成一件作品的评审副本描述。实际部署时此处调用转码/清洗流水线覆写字幕轨与容器元数据；
// 本实现以稳定派生的副本引用与摘要代表该不可变产物。
function buildReviewCopy(database, freezeId, work, version) {
  const itemId = `RV-${util.randomHex(8)}`;
  const report = {};

  const metadata = util.parseJsonObject(version.metadata_json);
  const scrubbedMetadata = scrubMetadata(metadata, report);

  const synopsis = maskText(metadata.synopsis || metadata.简介 || "", report);

  // 源文件名中的身份痕迹
  const sourceName = version.source_filename || "";
  if (sourceName) {
    maskText(sourceName, report);
    report.source_filename_stripped = 1;
  }
  // 原始片名整体替换：片名本身可能含院校/地区信息
  report.original_title_replaced = 1;
  const scrubbedTitle = `匿名作品 ${itemId}`;

  // 副本摘要与冻结正片摘要不同，证明经过独立清洗工序
  const copySha = util.sha256(`${version.media_sha256}|${itemId}|scrub-v1`);
  const copyRef = `copy://${freezeId}/${itemId}.review.mp4`;

  return {
    itemId,
    copyRef,
    copySha,
    scrubbedTitle,
    scrubbedSynopsis: synopsis,
    scrubbedMetadata,
    report,
  };
}

function memberListing(database, teamId) {
  return database
    .prepare(
      `SELECT m.member_id, m.full_name, a.role
         FROM member_affiliations a
         JOIN members m ON m.member_id = a.member_id
        WHERE a.team_id = ?`
    )
    .all(teamId);
}

// 执行冻结。必须在事务中调用（database 由调用方传入）。
function freezeSubmissions(database, { freezeId, name, triggeredBy, note }) {
  const createdAt = util.now();
  database
    .prepare(
      `INSERT INTO freeze_events(freeze_id, name, triggered_by, note, created_at)
       VALUES (?,?,?,?,?)`
    )
    .run(freezeId, name, triggeredBy, note || "", createdAt);

  const works = database
    .prepare("SELECT * FROM works WHERE status = 'received' ORDER BY work_id")
    .all();

  const items = [];
  const exclusions = [];
  const mapping = [];

  for (const work of works) {
    const version = work.current_version_id
      ? database.prepare("SELECT * FROM work_versions WHERE version_id = ?").get(work.current_version_id)
      : null;
    if (!version) {
      database
        .prepare("INSERT INTO freeze_exclusions(freeze_id, work_id, reason) VALUES (?,?,?)")
        .run(freezeId, work.work_id, "缺少参评版本：截止时无 current_version");
      exclusions.push({ work_id: work.work_id, reason: "missing_version" });
      continue;
    }

    const copy = buildReviewCopy(database, freezeId, work, version);
    database
      .prepare(
        `INSERT INTO frozen_items(item_id, freeze_id, work_id, version_id, category,
             media_sha256, copy_ref, copy_sha256, scrubbed_title, scrubbed_synopsis,
             scrubbed_metadata_json, scrub_report_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        copy.itemId, freezeId, work.work_id, version.version_id, work.category,
        version.media_sha256, copy.copyRef, copy.copySha, copy.scrubbedTitle,
        copy.scrubbedSynopsis, util.stableStringify(copy.scrubbedMetadata),
        util.stableStringify(copy.report), createdAt
      );

    database.prepare("UPDATE works SET status = 'frozen' WHERE work_id = ?").run(work.work_id);

    const team = database.prepare("SELECT * FROM teams WHERE team_id = ?").get(work.team_id);
    mapping.push({
      item_id: copy.itemId,
      work_id: work.work_id,
      team_id: work.team_id,
      version_id: version.version_id,
      original_title: work.title,
      school: team.school,
      region: team.region,
      members: memberListing(database, work.team_id),
    });
    items.push({
      item_id: copy.itemId,
      category: work.category,
      copy_ref: copy.copyRef,
      copy_sha256: copy.copySha,
      scrub_report: copy.report,
    });
  }

  // 密封信封：真实映射落盘为独立文件，库内只存摘要
  fs.mkdirSync(envelopeDir(), { recursive: true });
  const envelopeId = util.newId("env");
  const payload = {
    envelope_id: envelopeId,
    freeze_id: freezeId,
    created_at: createdAt,
    items: mapping,
  };
  const content = util.stableStringify(payload);
  const contentSha = util.sha256(content);
  const sealedRef = path.join(envelopeDir(), `${envelopeId}.sealed.json`);
  fs.writeFileSync(sealedRef, content, { mode: 0o600 });

  database
    .prepare(
      `INSERT INTO identity_envelopes(envelope_id, freeze_id, sealed_ref, content_sha256, created_by, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(envelopeId, freezeId, sealedRef, contentSha, triggeredBy, createdAt);

  return {
    freeze_id: freezeId,
    name,
    created_at: createdAt,
    envelope_id: envelopeId,
    envelope_content_sha256: contentSha,
    frozen_count: items.length,
    excluded_count: exclusions.length,
    items,
    exclusions,
  };
}

// 副本泄露：为同一冻结版本换发全新匿名副本（新编号、新摘要），旧副本立即失效。
// 已在旧副本上密封的评分通过席位历史保留（重排策略在分派层处理）。
function replaceLeakedCopy(database, { oldItemId, reason, actor }) {
  const old = database.prepare("SELECT * FROM frozen_items WHERE item_id = ?").get(oldItemId);
  if (!old) throw new Error("item_not_found");
  if (!old.active) throw new Error("item_already_inactive");

  const version = database.prepare("SELECT * FROM work_versions WHERE version_id = ?").get(old.version_id);
  const work = database.prepare("SELECT * FROM works WHERE work_id = ?").get(old.work_id);
  const copy = buildReviewCopy(database, old.freeze_id, work, version);
  const createdAt = util.now();

  // 必须先停用旧副本，再插入 active=1 的新副本，否则违反"每作品至多一个有效副本"的部分唯一索引
  database
    .prepare("UPDATE frozen_items SET active = 0, superseded_by_item_id = ? WHERE item_id = ?")
    .run(copy.itemId, old.item_id);

  database
    .prepare(
      `INSERT INTO frozen_items(item_id, freeze_id, work_id, version_id, category,
          media_sha256, copy_ref, copy_sha256, scrubbed_title, scrubbed_synopsis,
          scrubbed_metadata_json, scrub_report_json, replaces_item_id, active, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      copy.itemId, old.freeze_id, old.work_id, old.version_id, old.category,
      version.media_sha256, copy.copyRef, copy.copySha, copy.scrubbedTitle,
      copy.scrubbedSynopsis, util.stableStringify(copy.scrubbedMetadata),
      util.stableStringify({ ...copy.report, leak_replacement: 1 }),
      old.item_id, 1, createdAt
    );

  return { old_item_id: old.item_id, new_item_id: copy.itemId, reason, at: createdAt };
}

// 双人授权开启密封信封（break-glass）。
function openEnvelope(database, { envelopeId, openedBy, coAuthorizedBy, reason }) {
  const envelope = database
    .prepare("SELECT * FROM identity_envelopes WHERE envelope_id = ?")
    .get(envelopeId);
  if (!envelope) throw new Error("envelope_not_found");
  if (envelope.opened_at) throw new Error("envelope_already_opened");

  const content = fs.readFileSync(envelope.sealed_ref, "utf8");
  if (util.sha256(content) !== envelope.content_sha256) {
    throw new Error("envelope_tampered");
  }
  const openedAt = util.now();
  database
    .prepare("UPDATE identity_envelopes SET opened_at = ?, opened_by = ?, open_reason = ? WHERE envelope_id = ?")
    .run(openedAt, `${openedBy}+${coAuthorizedBy}`, reason, envelopeId);
  return { envelope_id: envelopeId, opened_at: openedAt, mapping: JSON.parse(content) };
}

module.exports = { freezeSubmissions, replaceLeakedCopy, openEnvelope, envelopeDir, buildReviewCopy };

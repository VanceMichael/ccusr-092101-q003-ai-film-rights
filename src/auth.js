// 令牌认证与基于角色的授权。
// 令牌以 sha256 摘要存储，明文仅在签发时返回一次。
// 角色：SECRETARIAT 秘书处 / JUDGE 评委 / TIE_REVIEWER 复议人 /
//       AWARD_CONFIRMER 奖项确认人 / AUDITOR 申诉核查人 / TEAM 团队 / ADMIN 管理员。
const { db } = require("./db");
const util = require("./util");

function issueToken({ subjectId, subjectKind, roles, label = "" }) {
  const plaintext = util.randomToken();
  const tokenId = util.newId("tok");
  db()
    .prepare(
      `INSERT INTO api_tokens(token_id, token_hash, subject_id, subject_kind, roles_json, label, issued_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      tokenId,
      util.sha256(plaintext),
      subjectId,
      subjectKind,
      util.stableStringify(roles),
      label,
      util.now()
    );
  return { token: plaintext, tokenId, subjectId, subjectKind, roles };
}

function revokeToken(tokenId) {
  const result = db()
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL")
    .run(util.now(), tokenId);
  return result.changes > 0;
}

// 引导令牌：首次部署时通过环境变量 SECRETARIAT_BOOTSTRAP_TOKEN 获得秘书处身份，
// 之后可凭其签发受限令牌；不入库，不落日志。
function bootstrapActor(token) {
  const secret = process.env.SECRETARIAT_BOOTSTRAP_TOKEN;
  if (secret && token === secret) {
    return { id: "secretariat-bootstrap", kind: "service", roles: ["SECRETARIAT"], tokenId: "bootstrap" };
  }
  return null;
}

function authenticate(request) {
  const header = request.headers["authorization"] || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const presented = match[1];

  const boot = bootstrapActor(presented);
  if (boot) return boot;

  const row = db()
    .prepare("SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .get(util.sha256(presented));
  if (!row) return null;
  return {
    id: row.subject_id,
    kind: row.subject_kind,
    roles: util.parseJsonArray(row.roles_json),
    tokenId: row.token_id,
    label: row.label,
  };
}

class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// 从请求中解析演员；require 为 true 时无凭证直接 401。
function requireActor(request) {
  const actor = authenticate(request);
  if (!actor) throw new HttpError(401, "unauthorized", "缺少或无效的访问令牌");
  return actor;
}

// 守卫：动作必须由具备指定角色之一的人执行。返回的 actor 附带本次授权角色，供审计留痕。
function requireRole(request, ...roles) {
  const actor = requireActor(request);
  const used = roles.find((role) => actor.roles.includes(role));
  if (!used) {
    throw new HttpError(403, "forbidden_role", `需要角色：${roles.join(" / ")}`);
  }
  return { ...actor, role: used };
}

module.exports = { issueToken, revokeToken, authenticate, requireActor, requireRole, HttpError };

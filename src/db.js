// 数据库单例：进程内复用一个已迁移连接，带事务封装。
const { openDatabase, migrate } = require("../scripts/migrate");
const util = require("./util");

let _db;

function db() {
  if (!_db) {
    _db = migrate();
  }
  return _db;
}

// 在一个事务内执行；审计链与业务写入在同一事务里提交。
function transaction(fn) {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// 追加一行带哈希链的审计记录，必须在事务中调用。
function appendAudit(database, { actor, action, entityType, entityId = "", detail = {} }) {
  const last = database
    .prepare("SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
    .get();
  const prevHash = last ? last.entry_hash : "GENESIS";
  const createdAt = util.now();
  const body = {
    a: actor.id,
    r: actor.role,
    act: action,
    et: entityType,
    eid: entityId,
    d: detail,
    t: createdAt,
  };
  const entryHash = util.sha256(prevHash + util.stableStringify(body));
  database
    .prepare(
      `INSERT INTO audit_log(created_at, actor_id, actor_role, action, entity_type, entity_id,
                             detail_json, prev_hash, entry_hash)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      createdAt,
      actor.id,
      actor.role,
      action,
      entityType,
      entityId,
      util.stableStringify(detail),
      prevHash,
      entryHash
    );
  return entryHash;
}

// 测试专用：切换到临时数据库文件并重置单例。
function _resetForTests(file) {
  if (_db) {
    _db.close();
    _db = undefined;
  }
  process.env.DATABASE_PATH = file;
  _db = migrate(openDatabase(file));
  return _db;
}

module.exports = { db, transaction, appendAudit, _resetForTests };

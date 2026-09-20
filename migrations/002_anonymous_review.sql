-- 匿名评审：收件冻结、利益冲突、可解释分派、密封评分、复议定奖与申诉
-- 约定：所有 *_ref 均为不含真实身份的引用编号；时间为 ISO 8601 字符串。

-- 操作主体与角色（admin=秘书处管理员，assignment_officer=分派官，judge=评委，
-- reviewer=复议人，award_confirmer=定奖确认人，appeal_officer=申诉核对人）
CREATE TABLE IF NOT EXISTS actors (
    actor_ref  TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('admin','assignment_officer','judge','reviewer','award_confirmer','appeal_officer')),
    created_at TEXT NOT NULL
);

-- 评委档案：单位与专长用于冲突派生与分派匹配
CREATE TABLE IF NOT EXISTS judges (
    judge_ref       TEXT PRIMARY KEY,
    institution_ref TEXT,
    expertise       TEXT NOT NULL DEFAULT '[]',
    max_load        INTEGER NOT NULL DEFAULT 12,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL
);

-- 评委主动申报的利益冲突（原始申报记录，派生结果写入 conflicts）
CREATE TABLE IF NOT EXISTS judge_declarations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_ref   TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('work','institution','member')),
    target_ref  TEXT NOT NULL,
    detail      TEXT,
    created_at  TEXT NOT NULL
);

-- 投稿（原始身份字段仅管理端可见）
CREATE TABLE IF NOT EXISTS submissions (
    work_ref        TEXT PRIMARY KEY,
    category        TEXT NOT NULL,
    title           TEXT NOT NULL,
    institution_ref TEXT,
    region_ref      TEXT,
    file_ref        TEXT NOT NULL,
    file_sha256     TEXT NOT NULL,
    submitted_at    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','frozen','withdrawn','disqualified'))
);

-- 团队成员与署名角色（保密，仅供冲突派生）
CREATE TABLE IF NOT EXISTS work_members (
    work_ref   TEXT NOT NULL,
    member_ref TEXT NOT NULL,
    role       TEXT NOT NULL,
    PRIMARY KEY (work_ref, member_ref, role)
);

-- 跨团队合作与指导经历（无向关系，查询时双向匹配）
CREATE TABLE IF NOT EXISTS member_relations (
    member_ref         TEXT NOT NULL,
    related_member_ref TEXT NOT NULL,
    relation           TEXT NOT NULL CHECK (relation IN ('teammate','collaborator','advisor','advisee')),
    PRIMARY KEY (member_ref, related_member_ref, relation)
);

-- 截止时冻结的实际参评版本
CREATE TABLE IF NOT EXISTS frozen_versions (
    work_ref    TEXT PRIMARY KEY,
    version_no  INTEGER NOT NULL,
    file_sha256 TEXT NOT NULL,
    frozen_at   TEXT NOT NULL
);

-- 评审副本：匿名编号 + 脱敏副本摘要；anon_ref -> work_ref 映射仅服务端保存
CREATE TABLE IF NOT EXISTS review_copies (
    anon_ref        TEXT PRIMARY KEY,
    work_ref        TEXT NOT NULL UNIQUE,
    copy_sha256     TEXT NOT NULL,
    scrubbed_fields TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- 冲突排除记录（declared=评委申报，derived=系统派生；degree=direct/indirect）
CREATE TABLE IF NOT EXISTS conflicts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_ref  TEXT NOT NULL,
    work_ref   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    degree     TEXT NOT NULL CHECK (degree IN ('direct','indirect')),
    detail     TEXT,
    source     TEXT NOT NULL CHECK (source IN ('declared','derived')),
    created_at TEXT NOT NULL
);

-- 评审席位：一次分派一个席位；回避/超时/泄露只重排对应席位
CREATE TABLE IF NOT EXISTS seats (
    seat_ref   TEXT PRIMARY KEY,
    work_ref   TEXT NOT NULL,
    anon_ref   TEXT NOT NULL,
    judge_ref  TEXT NOT NULL,
    round      INTEGER NOT NULL DEFAULT 1,
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','scored','recused','timed_out','leaked')),
    reason     TEXT,
    created_at TEXT NOT NULL
);

-- 密封评分：只允许插入，触发器禁止任何修改与删除（管理员也不例外）
CREATE TABLE IF NOT EXISTS scores (
    seat_ref   TEXT PRIMARY KEY,
    work_ref   TEXT NOT NULL,
    judge_ref  TEXT NOT NULL,
    score      REAL NOT NULL,
    comment    TEXT,
    sealed_at  TEXT NOT NULL,
    score_hash TEXT NOT NULL
);

-- 同分复议（reviewer 权限，与定奖确认分离）
CREATE TABLE IF NOT EXISTS reconsiderations (
    reconsideration_ref TEXT PRIMARY KEY,
    work_refs   TEXT NOT NULL,
    reason      TEXT,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    resolution  TEXT,
    opened_by   TEXT NOT NULL,
    resolved_by TEXT,
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);

-- 奖项：确认时固化可验证包（冻结版本摘要 + 有效评分集合 + 冲突排除记录）
CREATE TABLE IF NOT EXISTS awards (
    award_ref       TEXT PRIMARY KEY,
    work_ref        TEXT NOT NULL,
    award_name      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','published')),
    average_score   REAL NOT NULL,
    frozen_hash     TEXT NOT NULL,
    score_set_hash  TEXT NOT NULL,
    score_set       TEXT NOT NULL,
    exclusion_hash  TEXT NOT NULL,
    exclusion_record TEXT NOT NULL,
    confirmed_by    TEXT NOT NULL,
    confirmed_at    TEXT NOT NULL,
    published_at    TEXT
);

-- 申诉
CREATE TABLE IF NOT EXISTS appeals (
    appeal_ref  TEXT PRIMARY KEY,
    work_ref    TEXT NOT NULL,
    grounds     TEXT,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    resolution  TEXT,
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 追加式审计日志：哈希链，禁止改删
CREATE TABLE IF NOT EXISTS audit_log (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_ref  TEXT,
    role       TEXT,
    action     TEXT NOT NULL,
    target_ref TEXT,
    detail     TEXT,
    prev_hash  TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS scores_immutable_update BEFORE UPDATE ON scores
BEGIN SELECT RAISE(ABORT, 'scores_immutable'); END;

CREATE TRIGGER IF NOT EXISTS scores_immutable_delete BEFORE DELETE ON scores
BEGIN SELECT RAISE(ABORT, 'scores_immutable'); END;

CREATE TRIGGER IF NOT EXISTS audit_immutable_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_immutable'); END;

CREATE TRIGGER IF NOT EXISTS audit_immutable_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_immutable'); END;

INSERT OR IGNORE INTO settings(key, value) VALUES ('quorum', '3');
INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_anonymous_review');

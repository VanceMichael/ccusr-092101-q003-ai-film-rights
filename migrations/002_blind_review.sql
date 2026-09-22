-- 002_blind_review.sql
-- 匿名评审后端：从收件到定奖
--
-- 边界约定：
--   1. identity_* 侧保存真实院校/地区/成员/指导/合作/回避信息；评审侧（items/seats/scores…）
--      只持有匿名编号，两侧通过 frozen_items 与密封信封间接对应，映射的读取受应用角色守卫。
--   2. scores / tie_votes / audit_log 只追加：触发器拒绝 UPDATE 与 DELETE，
--      管理员亦无法代改已密封评分；重排只产生新席位，旧记录保留。
--   3. 所有时间为带偏移量 ISO 8601 文本；附件只保存受控引用与 sha256 摘要。

-- ---------------------------------------------------------------------------
-- 身份侧：团队与成员
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    team_id     TEXT PRIMARY KEY,
    team_name   TEXT NOT NULL,
    school      TEXT NOT NULL,          -- 院校（盲评敏感字段，绝不进入评审副本）
    region      TEXT NOT NULL,          -- 地区（盲评敏感字段）
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
    member_id   TEXT PRIMARY KEY,
    full_name   TEXT NOT NULL,          -- 真实姓名（盲评敏感字段）
    created_at  TEXT NOT NULL
);

-- 成员可跨团队：同一成员出现在多个团队即构成团队间的间接合作关系
CREATE TABLE IF NOT EXISTS member_affiliations (
    member_id   TEXT NOT NULL REFERENCES members(member_id),
    team_id     TEXT NOT NULL REFERENCES teams(team_id),
    role        TEXT NOT NULL DEFAULT '成员',
    PRIMARY KEY (member_id, team_id)
);

-- 团队间直接合作关系（无向，存储时保证 team_a < team_b）
CREATE TABLE IF NOT EXISTS team_relations (
    team_a      TEXT NOT NULL REFERENCES teams(team_id),
    team_b      TEXT NOT NULL REFERENCES teams(team_id),
    kind        TEXT NOT NULL,          -- 联合摄制 / 素材共用 / 跨校协作 …
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (team_a, team_b),
    CHECK (team_a < team_b)
);

-- 团队的合作单位（与评委的单位关联共同构成冲突）
CREATE TABLE IF NOT EXISTS team_partner_units (
    team_id     TEXT NOT NULL REFERENCES teams(team_id),
    unit_name   TEXT NOT NULL,
    PRIMARY KEY (team_id, unit_name)
);

-- ---------------------------------------------------------------------------
-- 身份侧：作品与版本
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS works (
    work_id             TEXT PRIMARY KEY,
    team_id             TEXT NOT NULL REFERENCES teams(team_id),
    category            TEXT NOT NULL,      -- 作品类别，如 微电影 / 微视频 / AI漫剧
    title               TEXT NOT NULL,      -- 原始片名（可能暴露身份，不直接进入副本）
    status              TEXT NOT NULL DEFAULT 'received', -- received | frozen | superseded
    current_version_id  TEXT,
    submitted_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_versions (
    version_id      TEXT PRIMARY KEY,
    work_id         TEXT NOT NULL REFERENCES works(work_id),
    seq             INTEGER NOT NULL,       -- 版本序号，截止时冻结当前序号
    media_sha256    TEXT NOT NULL,          -- 正片摘要
    media_ref       TEXT NOT NULL,          -- 受控存储引用
    source_filename TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}', -- 片头片尾/文件元数据等可能泄密的字段
    created_at      TEXT NOT NULL,
    UNIQUE (work_id, seq)
);

-- ---------------------------------------------------------------------------
-- 身份侧：评委、专长与利益冲突申报
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judges (
    judge_id            TEXT PRIMARY KEY,
    full_name           TEXT NOT NULL,
    school              TEXT NOT NULL DEFAULT '',
    region              TEXT NOT NULL DEFAULT '',
    public_fingerprint  TEXT NOT NULL UNIQUE, -- 对外可验证但不暴露身份的指纹，如 JP-7F3A9C
    status              TEXT NOT NULL DEFAULT 'active',
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judge_expertise (
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    category    TEXT NOT NULL,
    PRIMARY KEY (judge_id, category)
);

-- 评委与单位的关联（任职 / 合作 / 顾问 …），命中团队合作单位即冲突
CREATE TABLE IF NOT EXISTS judge_unit_links (
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    unit_name   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    PRIMARY KEY (judge_id, unit_name)
);

-- 评委指导经历：可锚定到团队 / 具体作品 / 具体成员
CREATE TABLE IF NOT EXISTS judge_mentorships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_id        TEXT NOT NULL REFERENCES judges(judge_id),
    team_id         TEXT REFERENCES teams(team_id),
    work_id         TEXT REFERENCES works(work_id),
    member_id       TEXT REFERENCES members(member_id),
    detail          TEXT NOT NULL DEFAULT '',
    declared_at     TEXT NOT NULL
);

-- 评委主动申报的回避
CREATE TABLE IF NOT EXISTS judge_recusals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    scope       TEXT NOT NULL CHECK (scope IN ('TEAM','WORK')),
    team_id     TEXT REFERENCES teams(team_id),
    work_id     TEXT REFERENCES works(work_id),
    reason      TEXT NOT NULL DEFAULT '',
    declared_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 评审侧：冻结事件与匿名副本
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS freeze_events (
    freeze_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS frozen_items (
    item_id             TEXT PRIMARY KEY,          -- 匿名评审编号 RV-XXXXXX
    freeze_id           TEXT NOT NULL REFERENCES freeze_events(freeze_id),
    work_id             TEXT NOT NULL REFERENCES works(work_id),
    version_id          TEXT NOT NULL REFERENCES work_versions(version_id),
    category            TEXT NOT NULL,
    -- 原始冻结版本
    media_sha256        TEXT NOT NULL,
    -- 脱敏评审副本（模拟转码/清洗流水线产物）
    copy_ref            TEXT NOT NULL,
    copy_sha256         TEXT NOT NULL,
    scrubbed_title      TEXT NOT NULL,
    scrubbed_synopsis   TEXT NOT NULL DEFAULT '',
    scrubbed_metadata_json TEXT NOT NULL DEFAULT '{}',
    scrub_report_json   TEXT NOT NULL DEFAULT '{}', -- 命中类别与计数字典，不含被遮蔽原文
    -- 副本泄露后换新：旧 item 指向新 item
    replaces_item_id    TEXT REFERENCES frozen_items(item_id),
    superseded_by_item_id TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL
);
-- 同一冻结批次同一作品只允许一个有效副本；失效的历史副本（如泄露换发）可共存
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_frozen
    ON frozen_items(freeze_id, work_id)
    WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_frozen_active ON frozen_items(active, category);

-- 资格不符（缺少参评版本/成员等）的作品在冻结时记录原因，供申诉核对
CREATE TABLE IF NOT EXISTS freeze_exclusions (
    freeze_id   TEXT NOT NULL REFERENCES freeze_events(freeze_id),
    work_id     TEXT NOT NULL REFERENCES works(work_id),
    reason      TEXT NOT NULL,
    PRIMARY KEY (freeze_id, work_id)
);

-- 真实身份映射的密封信封：文件另存于密封目录，库里只留摘要与责任记录
CREATE TABLE IF NOT EXISTS identity_envelopes (
    envelope_id     TEXT PRIMARY KEY,
    freeze_id       TEXT NOT NULL REFERENCES freeze_events(freeze_id),
    sealed_ref      TEXT NOT NULL,          -- 密封文件受控引用
    content_sha256  TEXT NOT NULL,          -- 信封内容摘要（含 code→真实作品映射）
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    opened_at       TEXT,                   -- break-glass 开启时间
    opened_by       TEXT,
    open_reason     TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- 评审侧：轮次、席位
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rounds (
    round_id    TEXT PRIMARY KEY,
    freeze_id   TEXT NOT NULL REFERENCES freeze_events(freeze_id),
    name        TEXT NOT NULL,
    quorum      INTEGER NOT NULL CHECK (quorum >= 1),  -- 每件作品最低评审人数
    max_load    INTEGER NOT NULL CHECK (max_load >= 1),-- 评委同期最大席位负载
    deadline_at TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','scoring_closed','published')),
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS round_categories (
    round_id    TEXT NOT NULL REFERENCES rounds(round_id),
    category    TEXT NOT NULL,
    PRIMARY KEY (round_id, category)
);

CREATE TABLE IF NOT EXISTS seats (
    seat_id         TEXT PRIMARY KEY,
    round_id        TEXT NOT NULL REFERENCES rounds(round_id),
    item_id         TEXT NOT NULL REFERENCES frozen_items(item_id),
    judge_id        TEXT NOT NULL REFERENCES judges(judge_id),
    status          TEXT NOT NULL DEFAULT 'assigned'
                    CHECK (status IN ('assigned','submitted','recused','timeout','reassigned')),
    -- 分派解释：专长、四类冲突排查、负载等，供秘书处与申诉核查
    rationale_json  TEXT NOT NULL DEFAULT '{}',
    parent_seat_id  TEXT REFERENCES seats(seat_id),  -- 重排时指向原席位
    replace_kind    TEXT CHECK (replace_kind IN ('recusal','timeout','leak')),
    created_at      TEXT NOT NULL,
    submitted_at    TEXT,
    closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_seats_round ON seats(round_id, status);
CREATE INDEX IF NOT EXISTS idx_seats_judge ON seats(judge_id, status);
CREATE INDEX IF NOT EXISTS idx_seats_item  ON seats(item_id);
-- 同一轮次同一在评副本，同一评委同时只能持有一个有效席位
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_seat
    ON seats(round_id, item_id, judge_id)
    WHERE status IN ('assigned','submitted');

-- 分派时对每件作品、每位评委的排查结论留痕：assigned / excluded（含原因）
-- 奖项证据包据此重放"为何是这些评委、其他人为何被排除"。
CREATE TABLE IF NOT EXISTS conflict_exclusions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id    TEXT NOT NULL REFERENCES rounds(round_id),
    item_id     TEXT NOT NULL REFERENCES frozen_items(item_id),
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    outcome     TEXT NOT NULL CHECK (outcome IN ('assigned','conflict','no_expertise','at_capacity')),
    reasons_json TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exclusions_item ON conflict_exclusions(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_exclusion ON conflict_exclusions(round_id, item_id, judge_id);

CREATE TABLE IF NOT EXISTS seat_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    seat_id     TEXT NOT NULL REFERENCES seats(seat_id),
    event       TEXT NOT NULL,          -- assigned | recused | timeout | submitted | reassigned
    actor_id    TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seat_events ON seat_events(seat_id, id);

-- ---------------------------------------------------------------------------
-- 评审侧：密封评分（只追加）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scores (
    score_id    TEXT PRIMARY KEY,
    seat_id     TEXT NOT NULL UNIQUE REFERENCES seats(seat_id),
    item_id     TEXT NOT NULL REFERENCES frozen_items(item_id),
    round_id    TEXT NOT NULL REFERENCES rounds(round_id),
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    value       REAL NOT NULL CHECK (value BETWEEN 0 AND 100),
    comment_text TEXT NOT NULL DEFAULT '',
    prev_hash   TEXT NOT NULL DEFAULT '',
    entry_hash  TEXT NOT NULL,          -- 本行内容哈希；链首 prev_hash 为 GENESIS
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_item ON scores(item_id);

CREATE TRIGGER IF NOT EXISTS trg_scores_no_update BEFORE UPDATE ON scores
BEGIN
    SELECT RAISE(ABORT, 'scores_immutable: 密封评分不得修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_scores_no_delete BEFORE DELETE ON scores
BEGIN
    SELECT RAISE(ABORT, 'scores_immutable: 密封评分不得删除');
END;

-- ---------------------------------------------------------------------------
-- 评审侧：同分复议
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tie_groups (
    tie_id          TEXT PRIMARY KEY,
    round_id        TEXT NOT NULL REFERENCES rounds(round_id),
    category        TEXT NOT NULL,
    item_ids_json   TEXT NOT NULL,           -- 同分作品编号集合
    tied_score      REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','resolved','cancelled')),
    opened_by       TEXT NOT NULL,
    opened_at       TEXT NOT NULL,
    resolved_at     TEXT,
    resolution_json TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tie_panel (
    tie_id      TEXT NOT NULL REFERENCES tie_groups(tie_id),
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    added_at    TEXT NOT NULL,
    PRIMARY KEY (tie_id, judge_id)
);

CREATE TABLE IF NOT EXISTS tie_votes (
    vote_id     TEXT PRIMARY KEY,
    tie_id      TEXT NOT NULL REFERENCES tie_groups(tie_id),
    judge_id    TEXT NOT NULL REFERENCES judges(judge_id),
    ranking_json TEXT NOT NULL,              -- 匿名编号排序
    comment_text TEXT NOT NULL DEFAULT '',
    entry_hash  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (tie_id, judge_id)
);
CREATE TRIGGER IF NOT EXISTS trg_tie_votes_no_update BEFORE UPDATE ON tie_votes
BEGIN
    SELECT RAISE(ABORT, 'tie_votes_immutable: 复议投票不得修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_tie_votes_no_delete BEFORE DELETE ON tie_votes
BEGIN
    SELECT RAISE(ABORT, 'tie_votes_immutable: 复议投票不得删除');
END;

-- ---------------------------------------------------------------------------
-- 评审侧：奖项与证据包
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS awards (
    award_id        TEXT PRIMARY KEY,
    round_id        TEXT NOT NULL REFERENCES rounds(round_id),
    category        TEXT NOT NULL,
    place           INTEGER NOT NULL CHECK (place >= 1),
    item_id         TEXT NOT NULL REFERENCES frozen_items(item_id),
    tie_id          TEXT REFERENCES tie_groups(tie_id), -- 经历复议时关联
    status          TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','confirmed','published')),
    proposed_by     TEXT NOT NULL,
    proposed_at     TEXT NOT NULL,
    confirmed_by    TEXT,                    -- 必须是 AWARD_CONFIRMER 且非复议参与人/提名人
    confirmed_at    TEXT,
    published_by    TEXT,
    published_at    TEXT,
    package_json    TEXT NOT NULL DEFAULT '',
    package_hash    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_awards_round ON awards(round_id, status);

-- ---------------------------------------------------------------------------
-- 申诉：申诉期间对资格 / 分派 / 计分的脱敏核对
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appeals (
    appeal_id   TEXT PRIMARY KEY,
    work_id     TEXT NOT NULL REFERENCES works(work_id),
    team_id     TEXT NOT NULL REFERENCES teams(team_id),
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','answered','closed')),
    created_at  TEXT NOT NULL,
    answered_by TEXT,
    answered_at TEXT,
    resolution_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);

CREATE TABLE IF NOT EXISTS appeal_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    appeal_id   TEXT NOT NULL REFERENCES appeals(appeal_id),
    actor_id    TEXT NOT NULL,               -- 核对人（AUDITOR）
    scope       TEXT NOT NULL,               -- eligibility | assignment | scoring
    created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 认证与审计
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_tokens (
    token_id    TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,        -- 仅存 sha256(token)
    subject_id  TEXT NOT NULL,               -- judge_id / team_id / 服务账号名
    subject_kind TEXT NOT NULL,              -- judge | team | service
    roles_json  TEXT NOT NULL DEFAULT '[]',  -- SECRETARIAT/JUDGE/TIE_REVIEWER/AWARD_CONFIRMER/AUDITOR/TEAM/ADMIN
    label       TEXT NOT NULL DEFAULT '',
    issued_at   TEXT NOT NULL,
    revoked_at  TEXT
);

-- 只追加的审计哈希链：每个业务动作落一行，entry_hash = sha256(prev_hash || canonical(detail))
CREATE TABLE IF NOT EXISTS audit_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    actor_id    TEXT NOT NULL,
    actor_role  TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    prev_hash   TEXT NOT NULL DEFAULT '',
    entry_hash  TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_immutable: 审计日志不得修改');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_immutable: 审计日志不得删除');
END;

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_blind_review');

# 两岸微电影 / 微视频 / AI 漫剧匿名评审后端

从收件、截止冻结、匿名副本、利益冲突排查、可解释分派、密封评分、同分复议、
奖项确认到公布证据包的全流程后端。作品近五百部、师生跨团队合作、评委可能指导过参赛者、
AI 漫剧片头片尾与文件元数据可能提前暴露作者——本系统以"身份侧 / 评审侧隔离 +
只追加存证 + 双人分权"保证盲评公平。

- 运行时：Node.js ≥ 22（使用内置 `node:sqlite`），**零第三方依赖**。
- 存储：SQLite 单文件，位置由 `DATABASE_PATH` 指定；身份密封信封目录由 `ENVELOPE_DIR` 指定。
- 接口：HTTP/JSON，前缀 `/v1`；时间一律为带偏移量 ISO 8601；附件只存受控引用与 `sha256` 摘要。
- 认证：`Authorization: Bearer <token>`，令牌仅以 `sha256` 摘要入库；首个秘书处令牌由
  环境变量 `SECRETARIAT_BOOTSTRAP_TOKEN` 引导，之后由秘书处签发受限令牌。

## 本地开发

```bash
make migrate   # 初始化/升级数据文件
make test      # node --test 端到端测试（21 项）
make run       # 启动服务（PORT 默认 8080）
```

也可用 `docker compose up --build`，宿主机端口通过 `APP_PORT` 调整。

## 角色

| 角色 | 职责 |
| --- | --- |
| `SECRETARIAT` | 收件、冻结、轮次与分派、回避/超时/泄露处置、提名与发布 |
| `JUDGE` | 查看分派给自己的匿名副本、提交评分、就本人席位回避 |
| `TIE_REVIEWER` | 同分复议组投票（不得与组内作品有冲突） |
| `AWARD_CONFIRMER` | 确认奖项（异于提名人、复议参与人） |
| `AUDITOR` | 申诉核查、证据包与审计链核验、密封信封共同开启 |
| `TEAM` | 对本团队作品提出申诉、查看答复 |
| `ADMIN` | 运维角色；**没有**代改密封评分的路径 |

## 流程与对应接口

### 1. 收件（身份侧）
团队、跨团队成员、团队合作关系、合作单位、作品与版本、评委专长 / 单位关联 /
指导经历 / 主动回避，全部在截止前登记：

`POST /v1/teams`、`/v1/members`、`/v1/affiliations`、`/v1/team-relations`、
`/v1/partner-units`、`/v1/works`、`/v1/works/{id}/versions`、
`/v1/judges`、`/v1/judges/{id}/unit-links`、`/v1/judges/{id}/mentorships`、
`/v1/judges/{id}/recusals`。

### 2. 截止冻结与匿名副本
`POST /v1/freezes` 冻结每件作品的当前版本（`work_versions` 中最新一版），
冻结后作品不可再提交版本。系统生成随机评审编号 `RV-xxxxxxxx` 与脱敏副本：

- 原始片名整段替换为"匿名作品 RV-…"；
- 文本中邮箱、手机号、片尾署名行、院校名称按模式遮蔽；
- 文件元数据中含院校/地区/团队/姓名/联系方式/单位等语义的键整键剔除；
- `scrub_report` 只记录命中类别与计数，**绝不回显被遮蔽原文**；
- 无参评版本的作品进入 `freeze_exclusions` 并附原因，供申诉核对。

真实"编号→作品/团队/院校/成员"映射写入 `ENVELOPE_DIR` 下权限 0600 的密封信封，
数据库只留信封内容摘要。开启信封须秘书处令牌 + `X-Co-Authorization` 携带的
审计员令牌（`POST /v1/envelopes/{id}/open`），开启即留痕。

### 3. 利益冲突与分派
`POST /v1/rounds` 设定类别、法定人数 `quorum`、单评委负载 `max_load`、截止时间；
`POST /v1/rounds/{id}/assign` 分派。

冲突模型（`src/conflicts.js`）：

- **直接**：评委指导/申报过该团队、作品或成员；评委关联单位命中团队合作单位；
- **间接**：团队间"联合摄制等关系 + 共享跨团队成员"构成无向图，
  评委的冲突锚点团队若与投稿团队在同一关系闭包内即排除（报告 BFS 距离）。

分派硬约束为类别专长匹配、零冲突、不超负载；按"候选数−法定人数"最紧约束优先、
同约束负载最低优先，保证负载均衡。每个 (作品, 评委) 组合都写 `conflict_exclusions`：
`assigned / conflict / no_expertise / at_capacity` 及原因；`GET /v1/rounds/{id}/plan`
给出可解释矩阵。合格评委不足以达法定人数时返回 `shortfalls` 而非强行分派。

### 4. 回避 / 超时 / 副本泄露——只重排受影响席位
- 评委回避：`POST /v1/seats/{id}/recuse`，旧席位置 `reassigned` 并补一名新评委；
- 超时：截止后 `POST /v1/rounds/{id}/sweep-timeouts`，仅未提交席位被补位，
  截止时间未到不动作；同作品上累计退出者不会被补回；
- 泄露：`POST /v1/items/{id}/leak-replacement` 换发全新编号副本（旧副本立即失效），
  再 `POST /v1/rounds/{id}/reassign-leak` 重排——看过旧副本的评委全部标记
  `leak_tainted` 退出新副本，旧评分行原样保留供审计但不计入新副本有效集合。

其他作品、其他席位均不受影响。

### 5. 密封评分与法定人数
评委 `GET /v1/me/assignments` 只看到匿名副本（编号、类别、清洗后简介、副本摘要），
`POST /v1/seats/{id}/score` 就本人席位提交（0–100）。`scores` 表由触发器禁止
UPDATE/DELETE，评分自带哈希链；数据库管理员直接改删也会被拒绝。

一件作品有效评分达 `quorum` 前，`GET /v1/items/{id}/progress` 对**所有人**只返回
进度计数（`scores: null`）；达成后才开放分值与均分。

### 6. 同分复议（分权、留痕）
关轮 `POST /v1/rounds/{id}/close` 要求全部作品达法定人数。秘书处对实际并列组
`POST /v1/tie-groups` 开启复议，并从无冲突评委中组建复议组（有冲突者加入被拒）。
复议人 `POST /v1/tie-groups/{id}/vote` 提交匿名编号排序，投票只追加、不可改；
全票到齐后 Borda 计票裁决（仍并列则要求扩充复议组）。

### 7. 奖项确认与可验证公布
提名（秘书处）→ 确认（`AWARD_CONFIRMER`，**不得**是提名人或该作品复议参与人）
→ 发布（秘书处，**不得**是确认人），三步异人留痕。发布时固化证据包：

- 冻结版本：评审编号、冻结的 `version_id`、正片与副本 `sha256`；
- 有效评分集合：评分 id、评委指纹、分值、密封时间；
- 冲突排除记录：每位评委的 assigned/conflict/… 结论与原因；
- 席位替补史、复议裁决、提名/确认/发布时间线。

发布前 `validatePackage` 复核版本摘要、有效评分集合与法定人数，不通过则拒绝。
`GET /v1/awards/{id}/verify`（审计员/秘书处）与
`GET /v1/public/awards/{id}`（**无需令牌**，已公布奖项）支持任何人独立重算
`package_hash` 核验。

### 8. 申诉（可见过程，不见身份）
团队 `POST /v1/appeals` 只能就本团队作品申诉。审计员按
`?scope=eligibility|assignment|scoring` 调 `GET /v1/appeals/{id}/review`，
每次查看写 `appeal_views` 与审计日志。视图中：

- 评委只以 `JP-xxxxxxxx` 指纹出现，无姓名/院校/地区；
- 只返回该申诉作品的数据，其他作品编号也不出现；
- 不含院校、地区、成员、原片名；席位理由中的内部评委编号数组被剥离。

`GET /v1/audit/verify` 重算审计链、评分链与复议票哈希，可定位被破坏的行号。

## 主要数据表

- 身份侧：`teams / members / member_affiliations / team_relations /
  team_partner_units / works / work_versions / judges / judge_expertise /
  judge_unit_links / judge_mentorships / judge_recusals / identity_envelopes`
- 评审侧：`freeze_events / freeze_exclusions / frozen_items / rounds /
  round_categories / seats / seat_events / conflict_exclusions / scores /
  tie_groups / tie_panel / tie_votes / awards / appeals / appeal_views`
- 认证与存证：`api_tokens / audit_log / schema_migrations`

`scores`、`tie_votes`、`audit_log` 由触发器只追加；`frozen_items` 以部分唯一索引
保证每作品至多一个有效副本。

## 安全边界与已知取舍

- 本仓库以稳定派生的 `copy://` 引用与摘要代表脱敏后的成片；接入真实转码/清洗
  流水线时，在 `src/anonymize.js` 的 `buildReviewCopy` 处替换为实际产物即可。
- 身份映射信封与数据库必须分开授权与备份；0600 文件权限之外的磁盘加密由部署保障。
- 令牌为不透明 Bearer 令牌，生产中应经 TLS 传输，并按需短期签发、及时吊销。

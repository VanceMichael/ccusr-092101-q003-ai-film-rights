// 标准测试场景：
//   团队 T-A（校A/华东）、T-B（校B/华北）、T-C（校C/华南）
//   T-A 与 T-B 联合摄制；成员 M-X 同时隶属 T-B、T-C（共享成员边）
//   作品 W-1（T-A/微电影）、W-2（T-B/AI漫剧）、W-3（T-C/微电影）、W-4（T-A/微视频，无版本，应被冻结排除）
//   T-C 合作单位"校C产业中心"，评委 J-4 在该单位任职
//   评委 J-1 指导过 T-A（对 W-1 直接冲突，对 W-2/W-3 沿关系闭包间接冲突）
//   评委 J-3 主动回避 W-2；J-6/J-7 为干净评委，复议时可作新鲜复议人
const JUDGE_IDS = ["J-1", "J-2", "J-3", "J-4", "J-5", "J-6", "J-7", "J-8", "J-9", "J-10",
  "J-11", "J-12", "J-13", "J-14", "J-15"];

async function buildScenario(api, secretariat) {
  const post = (url, token, body, headers) => api.request("POST", url, token, body, headers);
  const S = secretariat;

  for (const team of [
    { team_id: "T-A", team_name: "甲创作组", school: "校A大学", region: "华东" },
    { team_id: "T-B", team_name: "乙创作组", school: "校B学院", region: "华北" },
    { team_id: "T-C", team_name: "丙创作组", school: "校C大学", region: "华南" },
  ]) {
    await post("/v1/teams", S, team);
  }
  await post("/v1/members", S, { member_id: "M-1", full_name: "张三" });
  await post("/v1/members", S, { member_id: "M-X", full_name: "李四（跨团队）" });
  await post("/v1/affiliations", S, { member_id: "M-1", team_id: "T-A" });
  await post("/v1/affiliations", S, { member_id: "M-X", team_id: "T-B" });
  await post("/v1/affiliations", S, { member_id: "M-X", team_id: "T-C" });
  await post("/v1/team-relations", S, { team_a: "T-A", team_b: "T-B", kind: "联合摄制" });
  await post("/v1/partner-units", S, { team_id: "T-C", unit_name: "校C产业中心" });

  for (const work of [
    { work_id: "W-1", team_id: "T-A", category: "微电影", title: "校A大学出品：青春纪事" },
    { work_id: "W-2", team_id: "T-B", category: "AI漫剧", title: "乙组秘档" },
    { work_id: "W-3", team_id: "T-C", category: "微电影", title: "南方夜话" },
    { work_id: "W-4", team_id: "T-A", category: "微视频", title: "无版本作品" },
  ]) {
    await post("/v1/works", S, work);
  }

  // 带泄露痕迹的元数据：片尾署名、邮箱、手机号、敏感键
  const leakyMetadata = {
    synopsis: "指导老师：王老师 出品：校A大学影视系，联系邮箱 demo@school.edu.cn 或 13800138000",
    school: "校A大学",
    author: "张三",
    GPS: "31.2,121.5",
    duration_sec: 120,
  };
  const versions = {
    "W-1": { media_sha256: "a".repeat(64), media_ref: "store://w1/v3.mp4", source_filename: "校A大学_张三_终审.mp4", metadata: leakyMetadata },
    "W-2": { media_sha256: "b".repeat(64), media_ref: "store://w2/v1.mp4", source_filename: "final.mp4", metadata: { duration_sec: 90 } },
    "W-3": { media_sha256: "c".repeat(64), media_ref: "store://w3/v2.mp4", source_filename: "south.mp4", metadata: { team: "丙创作组", duration_sec: 60 } },
  };
  for (const [workId, version] of Object.entries(versions)) {
    await post(`/v1/works/${workId}/versions`, S, version);
  }

  const judges = JUDGE_IDS.map((id, index) => ({
    judge_id: id,
    full_name: `评委${index + 1}`,
    ...(id === "J-1" ? { school: "校D大学" } : {}),
    categories: ["微电影", "AI漫剧", "微视频"],
  }));
  const fingerprints = {};
  for (const judge of judges) {
    const created = await post("/v1/judges", S, judge);
    fingerprints[judge.judge_id] = created.body.public_fingerprint;
  }

  await post("/v1/judges/J-1/mentorships", S, { team_id: "T-A", detail: "指导过甲创作组赛前工作坊" });
  await post("/v1/judges/J-3/recusals", S, { scope: "WORK", work_id: "W-2", reason: "与乙组成员有私交" });
  await post("/v1/judges/J-4/unit-links", S, { unit_name: "校C产业中心", kind: "任职" });

  // 令牌
  const issue = async (subjectId, subjectKind, roles, label) =>
    (await post("/v1/tokens", S, { subject_id: subjectId, subject_kind: subjectKind, roles, label })).body;
  const tokens = {};
  for (const id of JUDGE_IDS) {
    const roles = ["JUDGE"];
    tokens[id] = (await issue(id, "judge", roles)).token;
  }
  tokens.auditor = (await issue("auditor-1", "service", ["AUDITOR"])).token;
  tokens.confirmer = (await issue("confirmer-1", "service", ["AWARD_CONFIRMER"])).token;
  tokens.teamA = (await issue("T-A", "team", ["TEAM"])).token;
  tokens.teamB = (await issue("T-B", "team", ["TEAM"])).token;

  return { tokens, fingerprints };
}

// 冻结并通过双人开启信封得到 item_id → work_id 映射（仅测试端使用）
async function freezeAndMap(api, secretariat, tokens, name = "初评冻结") {
  const frozen = (await api.request("POST", "/v1/freezes", secretariat, { name })).body;
  const opened = (
    await api.request("POST", `/v1/envelopes/${frozen.envelope_id}/open`, secretariat,
      { reason: "测试：建立编号映射" },
      { "x-co-authorization": `Bearer ${tokens.auditor}` })
  ).body;
  const itemByWork = Object.fromEntries(opened.mapping.items.map((item) => [item.work_id, item.item_id]));
  return { frozen, itemByWork, freezeId: frozen.freeze_id };
}

module.exports = { buildScenario, freezeAndMap, JUDGE_IDS };

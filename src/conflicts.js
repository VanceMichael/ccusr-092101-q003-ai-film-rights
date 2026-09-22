// 利益冲突计算。
//
// 直接冲突：
//   - 评委指导过该作品的团队 / 作品 / 成员（指导经历）
//   - 评委主动申报回避该团队 / 作品
//   - 评委关联单位命中该团队的合作单位
// 间接冲突：
//   - 团队间存在直接合作关系，或共享跨团队成员；以无向图传递闭包计算。
//   - 评委指导/申报过的"锚点团队"若与投稿团队在同一闭包内，视为间接冲突。
//
// 本模块可以读取身份侧表，但只输出原因代码与锚点编号；
// 面向评委和申诉的输出在路由层进一步脱敏。

function buildTeamGraph(database) {
  const adjacency = new Map();
  const link = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  const ensure = (id) => {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
  };

  for (const team of database.prepare("SELECT team_id FROM teams").all()) ensure(team.team_id);

  // 团队间直接合作关系（无向）
  for (const row of database.prepare("SELECT team_a, team_b FROM team_relations").all()) {
    link(row.team_a, row.team_b);
    link(row.team_b, row.team_a);
  }

  // 共享成员：同一成员隶属多个团队时，这些团队两两相连
  const rows = database
    .prepare(
      `SELECT a.team_id AS ta, b.team_id AS tb
         FROM member_affiliations a
         JOIN member_affiliations b ON a.member_id = b.member_id AND a.team_id < b.team_id`
    )
    .all();
  for (const row of rows) {
    link(row.ta, row.tb);
    link(row.tb, row.ta);
  }
  return adjacency;
}

// 从若干锚点团队出发，沿合作图求闭包（含锚点自身）。
function closureFrom(adjacency, seeds) {
  const reached = new Set();
  const queue = [];
  for (const seed of seeds) {
    if (seed && !reached.has(seed)) {
      reached.add(seed);
      queue.push(seed);
    }
  }
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

// 评委的冲突锚点：指导经历与主动回避所指向的团队集合
function judgeAnchorTeams(database, judgeId) {
  const anchors = new Map(); // teamId -> [原因代码]
  const add = (teamId, code) => {
    if (!teamId) return;
    if (!anchors.has(teamId)) anchors.set(teamId, []);
    anchors.get(teamId).push(code);
  };

  const mentorships = database
    .prepare("SELECT team_id, work_id, member_id FROM judge_mentorships WHERE judge_id = ?")
    .all(judgeId);
  for (const row of mentorships) {
    if (row.team_id) add(row.team_id, "mentorship");
    if (row.work_id) {
      const work = database.prepare("SELECT team_id FROM works WHERE work_id = ?").get(row.work_id);
      if (work) add(work.team_id, "mentorship");
    }
    if (row.member_id) {
      for (const aff of database
        .prepare("SELECT team_id FROM member_affiliations WHERE member_id = ?")
        .all(row.member_id)) {
        add(aff.team_id, "mentorship");
      }
    }
  }

  const recusals = database
    .prepare("SELECT team_id, work_id FROM judge_recusals WHERE judge_id = ?")
    .all(judgeId);
  for (const row of recusals) {
    if (row.team_id) add(row.team_id, "recusal");
    if (row.work_id) {
      const work = database.prepare("SELECT team_id FROM works WHERE work_id = ?").get(row.work_id);
      if (work) add(work.team_id, "recusal");
    }
  }
  return anchors;
}

// 返回该评委对某件作品的冲突原因列表（空数组表示无冲突）。
// 原因项：{ code, kind: direct|indirect, via?: 锚点团队编号（仅服务端留痕） }
function conflictsForWork(database, adjacency, judgeId, work) {
  const reasons = [];
  const anchors = judgeAnchorTeams(database, judgeId);

  // 以投稿团队为源点求合作图距离
  const distance = new Map([[work.team_id, 0]]);
  const queue = [work.team_id];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (!distance.has(next)) {
        distance.set(next, (distance.get(current) || 0) + 1);
        queue.push(next);
      }
    }
  }

  // 直接：锚点就是投稿团队
  for (const code of new Set(anchors.get(work.team_id) || [])) {
    reasons.push({ code, kind: "direct" });
  }
  // 间接：锚点团队与投稿团队在同一关系闭包内（合作图可达，距离 >= 1）
  for (const [anchorTeam, codes] of anchors) {
    const dist = distance.get(anchorTeam);
    if (dist !== undefined && dist >= 1) {
      reasons.push({ code: `${codes[0]}_indirect`, kind: "indirect", via: anchorTeam, distance: dist });
    }
  }

  // 合作单位
  const unitHits = database
    .prepare(
      `SELECT p.unit_name AS unit
         FROM team_partner_units p
         JOIN judge_unit_links j ON j.unit_name = p.unit_name AND j.judge_id = ?
        WHERE p.team_id = ?`
    )
    .all(judgeId, work.team_id);
  for (const hit of unitHits) {
    reasons.push({ code: "partner_unit", kind: "direct", unit: hit.unit });
  }

  return reasons;
}

module.exports = { buildTeamGraph, closureFrom, judgeAnchorTeams, conflictsForWork };

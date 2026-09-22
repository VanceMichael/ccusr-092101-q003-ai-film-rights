// 端到端：收件 → 截止冻结 → 匿名副本
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeContext } = require("./helpers");
const { buildScenario, freezeAndMap } = require("./scenario");

test("冻结生成不泄露身份的评审副本并单独密封真实映射", async (context) => {
  const api = makeContext("freeze");
  context.after(() => api.close());

  await buildScenario(api, api.SECRETARIAT).then(async ({ tokens }) => {
    const { frozen, itemByWork } = await freezeAndMap(api, api.SECRETARIAT, tokens);

    // W-4 无参评版本，应被排除且原因可查
    assert.equal(frozen.frozen_count, 3);
    assert.equal(frozen.excluded_count, 1);
    assert.equal(frozen.exclusions[0].work_id, "W-4");

    // 副本不含原片名与院校信息
    const detail = await api.request("GET", `/v1/freezes/${frozen.freeze_id}`, api.SECRETARIAT);
    const w1Item = detail.body.items.find((i) => i.item_id === itemByWork["W-1"]);
    assert.ok(w1Item);
    const report = w1Item.scrub_report;
    assert.ok(report.original_title_replaced === 1);
    assert.ok(report.email >= 1, "邮箱应被遮蔽");
    assert.ok(report.phone_cn >= 1, "手机号应被遮蔽");
    assert.ok(report.credit_line >= 1, "片尾署名行应被遮蔽");
    assert.ok(report.school_mention >= 1, "院校名称应被遮蔽");
    assert.ok(report.metadata_redacted_keys >= 2, "school/author 等敏感键应剔除");
  });
});

test("密封信封默认不可读，开启需秘书处+审计双人授权", async (context) => {
  const api = makeContext("envelope");
  context.after(() => api.close());

  const { tokens } = await buildScenario(api, api.SECRETARIAT);
  const frozen = (await api.request("POST", "/v1/freezes", api.SECRETARIAT, { name: "冻结" })).body;

  // 单人尝试开启：缺少共同授权头
  const alone = await api.request("POST", `/v1/envelopes/${frozen.envelope_id}/open`, api.SECRETARIAT, { reason: "x" });
  assert.equal(alone.status, 401);

  // 非 AUDITOR 的共同授权被拒
  const judgeCo = await api.request(
    "POST", `/v1/envelopes/${frozen.envelope_id}/open`, api.SECRETARIAT,
    { reason: "x" }, { "x-co-authorization": `Bearer ${tokens["J-2"]}` }
  );
  assert.equal(judgeCo.status, 403);

  // 双人成功
  const opened = await api.request(
    "POST", `/v1/envelopes/${frozen.envelope_id}/open`, api.SECRETARIAT,
    { reason: "合法开启" }, { "x-co-authorization": `Bearer ${tokens.auditor}` }
  );
  assert.equal(opened.status, 200);
  assert.ok(opened.body.mapping.items[0].school);
});

test("冻结后不得再提交新版本", async (context) => {
  const api = makeContext("frozen-deadline");
  context.after(() => api.close());

  await buildScenario(api, api.SECRETARIAT);
  await api.request("POST", "/v1/freezes", api.SECRETARIAT, { name: "冻结" });
  const late = await api.request("POST", "/v1/works/W-1/versions", api.SECRETARIAT, {
    media_sha256: "d".repeat(64),
    media_ref: "store://late.mp4",
  });
  assert.equal(late.status, 409);
});

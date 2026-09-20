# AI影视团队作品权属中枢

创作团队、素材许可、作品版本、署名份额与展映确认需要彼此对应。

服务通过 HTTP 接口交换业务事件，并使用 SQLite 文件保存本地状态。监听端口由 `PORT` 指定，数据文件位置由 `DATABASE_PATH` 指定；`contracts/entities.json` 记录首批稳定字段，`fixtures/example.json` 提供不含真实身份信息的示例。

## 匿名评审后端

在权属中枢之上，本服务提供从收件到定奖的匿名评审流程（`migrations/002_anonymous_review.sql`）：

1. **收件与冻结**：`POST /submissions` 登记投稿与团队成员，`POST /relations` 记录跨团队合作与指导经历；截止后 `POST /freeze` 冻结实际参评版本（`frozen_versions` 保存文件摘要），并为每件作品生成匿名评审副本（`review_copies`，脱敏字段清单留痕，匿名编号到作品的映射仅服务端保存）。
2. **利益冲突**：评委通过 `POST /judges/:ref/declarations` 主动申报；分派时系统另从单位、团队成员、指导/合作经历派生直接与间接冲突，全部写入 `conflicts` 供核对。
3. **可解释分派**：`POST /assignments/run` 按类别专长匹配、负载均衡与法定人数分派席位，每个席位与每个排除项都附带结构化原因（专长、负载、法定人数、截止时间、冲突类型）。
4. **单席位重排**：评委回避（`POST /seats/:ref/recuse`）、超时（`/timeout`）、副本泄露（`/leak`）只替换受影响席位，其余席位与已密封评分不受影响。
5. **密封评分**：`POST /scores` 只允许评委对本人活跃席位投递一次；评分一经密封，数据库触发器禁止任何修改与删除，管理员也无法代改；达到法定人数前评委彼此不可见评分。
6. **复议与定奖分权**：同类别同分必须先由 `reviewer` 完成复议（`POST /reconsiderations`），再由 `award_confirmer` 确认奖项（`POST /awards`），两类操作分别留痕。
7. **申诉核对**：`GET /appeals/:ref/review` 只返回该作品的资格、分派与计分信息，不含评委编号、院校成员或其他作品。
8. **可验证公布**：每个奖项固化冻结版本摘要、有效评分集合摘要与冲突排除记录摘要，`GET /awards/:ref/verification` 可公开复算核验。

角色通过 `POST /actors` 注册（首个注册主体必须为 `admin` 完成引导），请求以 `x-actor-ref` 头标识身份。全部关键操作写入哈希链审计日志，`GET /audit/verify` 校验完整性。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行现有自动化检查，`make run` 启动服务。也可以使用 `docker compose up --build` 构建并运行容器，宿主机端口通过 `APP_PORT` 调整。

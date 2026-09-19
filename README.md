# AI影视团队作品权属中枢

创作团队、素材许可、作品版本、署名份额与展映确认需要彼此对应。

服务通过 HTTP 接口交换业务事件，并使用 SQLite 文件保存本地状态。监听端口由 `PORT` 指定，数据文件位置由 `DATABASE_PATH` 指定；`contracts/entities.json` 记录首批稳定字段，`fixtures/example.json` 提供不含真实身份信息的示例。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行现有自动化检查，`make run` 启动服务。也可以使用 `docker compose up --build` 构建并运行容器，宿主机端口通过 `APP_PORT` 调整。

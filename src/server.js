const http = require("node:http");
const { handler } = require("./routes");

function createServer() {
  return http.createServer(handler());
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`匿名评审服务已启动，监听端口 ${port}`);
  });
}

module.exports = { createServer };

// 测试辅助：临时数据库、信封目录、一次性服务器与请求封装。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../src/server");
const { _resetForTests } = require("../src/db");

process.env.SECRETARIAT_BOOTSTRAP_TOKEN = "test-bootstrap-secret";

function makeContext(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `br-${label}-`));
  const dbFile = path.join(dir, "test.sqlite3");
  process.env.ENVELOPE_DIR = path.join(dir, "envelopes");
  _resetForTests(dbFile);

  const server = createServer();
  const baseReady = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  async function request(method, urlPath, token, body, headers = {}) {
    await baseReady;
    const { port } = server.address();
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (token) init.headers["authorization"] = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, body: json, headers: response.headers };
  }

  function close() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { request, close, dir, SECRETARIAT: process.env.SECRETARIAT_BOOTSTRAP_TOKEN };
}

module.exports = { makeContext };

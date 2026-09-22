// 极简 HTTP 路由辅助：无第三方依赖。
const { HttpError } = require("./auth");

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HttpError(400, "bad_json", "请求体必须是 JSON 对象");
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
  }
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw new HttpError(400, "missing_field", `缺少必填字段：${field}`, { field });
    }
  }
}

// 声明式路由：[{ method, pattern: /^...$/, roles: [...], handler(req,res,params,body) }]
function createRouter(routes) {
  return async function router(request, response) {
    const url = new URL(request.url, "http://localhost");
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      try {
        const params = match.groups || {};
        const body = request.method === "GET" || request.method === "DELETE" ? {} : await readJson(request);
        await route.handler(request, response, params, body, url.searchParams);
        return;
      } catch (error) {
        if (error instanceof HttpError) {
          send(response, error.status, { error: error.code, message: error.message, detail: error.detail });
          return;
        }
        // 外键约束等数据库错误不泄露细节，统一 409/400
        const message = String(error && error.message ? error.message : error);
        const status = /FOREIGN KEY|UNIQUE|CHECK|constraint/i.test(message) ? 409 : 500;
        if (status === 500) console.error(error);
        send(response, status, {
          error: status === 409 ? "constraint_violation" : "internal_error",
          message: status === 409 ? message : "服务器内部错误",
        });
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { status: "ok" });
      return;
    }
    send(response, 404, { error: "not_found" });
  };
}

module.exports = { send, readJson, requireFields, createRouter };

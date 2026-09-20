const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

// 键序稳定的规范化序列化，保证同一内容始终得到同一摘要
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function hashObject(value) {
  return sha256(canonical(value));
}

function newRef(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

module.exports = { nowIso, canonical, sha256, hashObject, newRef };

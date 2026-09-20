const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationsDir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    database.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return database;
}

module.exports = { openDatabase };

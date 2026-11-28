'use strict';
// 每周工作的建表与迁移。只依赖传入的 db（node:sqlite 的 DatabaseSync），所以可以用内存数据库离线测试。

// 建表（可重复执行）、预置默认人员、把旧结构里的待办迁到 work_todos
function initWorkSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS work_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES work_people(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,            -- 现在只会是 done；kind 和 done 两列是旧结构留下的，不再使用
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_entries_person_date ON work_entries(person_id, date);
    CREATE TABLE IF NOT EXISTS work_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES work_people(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      due_date TEXT NOT NULL DEFAULT '',     -- 空串 = 没选日期
      done INTEGER NOT NULL DEFAULT 0,
      done_date TEXT NOT NULL DEFAULT '',    -- 未完成时恒为空串
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_todos_person_done ON work_todos(person_id, done);
  `);
  if (!db.prepare('SELECT 1 FROM work_people LIMIT 1').get()) {
    db.prepare('INSERT INTO work_people(name, sort) VALUES(?, ?)').run('我', 0);
  }
  migrateTodos(db);
}

// 旧结构里待办和记录同在 work_entries（kind = 'todo'）。搬进 work_todos：
// 原日期 → 待办日期；已完成的完成日期取原日期；完成状态、创建时间、归属都保持。
// 一个事务，失败回滚；搬完后旧表里没有 todo 了，所以重复执行什么都不做。返回搬了多少行。
function migrateTodos(db) {
  if (!db.prepare("SELECT 1 FROM work_entries WHERE kind = 'todo' LIMIT 1").get()) return 0;
  db.exec('BEGIN');
  try {
    const moved = Number(db.prepare(`
      INSERT INTO work_todos(person_id, text, due_date, done, done_date, created_at)
      SELECT person_id, text, date, done, CASE WHEN done = 1 THEN date ELSE '' END, created_at
      FROM work_entries WHERE kind = 'todo' ORDER BY id
    `).run().changes);
    db.prepare("DELETE FROM work_entries WHERE kind = 'todo'").run();
    db.exec('COMMIT');
    return moved;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { initWorkSchema, migrateTodos };

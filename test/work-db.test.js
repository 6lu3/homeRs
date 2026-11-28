// 每周工作的建表与迁移测试：node test/work-db.test.js（用内存数据库，不需要启动服务）
const { DatabaseSync } = require('node:sqlite');
const { initWorkSchema, migrateTodos } = require('../lib/work-db');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

// 旧结构（本次改动之前线上的样子）：待办和记录都在 work_entries 里
function oldDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE work_people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE work_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES work_people(id) ON DELETE CASCADE,
      date TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO work_people(name, sort) VALUES('我', 0)").run();
  db.prepare("INSERT INTO work_people(name, sort) VALUES('乙', 1)").run();
  const ins = db.prepare('INSERT INTO work_entries(person_id, date, kind, text, done, created_at) VALUES(?, ?, ?, ?, ?, ?)');
  ins.run(1, '2032-03-02', 'done', '修了bug', 0, '2032-03-02T01:00:00.000Z');
  ins.run(1, '2032-03-04', 'todo', '写方案', 0, '2032-03-04T01:00:00.000Z');
  ins.run(1, '2032-03-05', 'todo', '评审', 1, '2032-03-05T01:00:00.000Z');
  ins.run(2, '2032-03-06', 'todo', '乙的事', 0, '2032-03-06T01:00:00.000Z');
  return db;
}
const todos = db => db.prepare('SELECT person_id, text, due_date, done, done_date, created_at FROM work_todos ORDER BY id').all().map(r => ({ ...r }));
const entries = db => db.prepare('SELECT person_id, text, kind FROM work_entries ORDER BY id').all().map(r => ({ ...r }));

check('迁移：旧待办搬进 work_todos，日期、完成状态、归属、创建时间都对得上', () => {
  const db = oldDb();
  initWorkSchema(db);
  eq(todos(db), [
    { person_id: 1, text: '写方案', due_date: '2032-03-04', done: 0, done_date: '', created_at: '2032-03-04T01:00:00.000Z' },
    { person_id: 1, text: '评审', due_date: '2032-03-05', done: 1, done_date: '2032-03-05', created_at: '2032-03-05T01:00:00.000Z' },
    { person_id: 2, text: '乙的事', due_date: '2032-03-06', done: 0, done_date: '', created_at: '2032-03-06T01:00:00.000Z' },
  ]);
});
check('迁移：work_entries 里只剩「已做」记录，没有 todo', () => {
  const db = oldDb();
  initWorkSchema(db);
  eq(entries(db), [{ person_id: 1, text: '修了bug', kind: 'done' }]);
});
check('迁移：重复执行不再改动任何数据', () => {
  const db = oldDb();
  initWorkSchema(db);
  const t1 = todos(db), e1 = entries(db);
  initWorkSchema(db);
  eq(migrateTodos(db), 0);
  eq(todos(db), t1);
  eq(entries(db), e1);
});
check('全新库：不抛错，只预置一个人员「我」，没有待办；再初始化一次仍是一个人员', () => {
  const db = new DatabaseSync(':memory:');
  initWorkSchema(db);
  eq(db.prepare('SELECT name FROM work_people').all().map(r => r.name), ['我']);
  eq(todos(db), []);
  initWorkSchema(db);
  eq(db.prepare('SELECT COUNT(*) AS n FROM work_people').get().n, 1);
});
check('迁移失败时回滚：已经搬过去的行也撤销、旧待办不被删、连接不停在事务里', () => {
  const db = oldDb();
  initWorkSchema(db);                      // 先把旧数据迁完，新表和默认数据都就位
  db.prepare("INSERT INTO work_entries(person_id, date, kind, text, done, created_at) VALUES(1, '2032-04-01', 'todo', '还在', 0, 'x')").run();
  const before = todos(db).length;
  // 让「INSERT 成功、DELETE 失败」：这样才真的走到事务中途出错。（以前这条用例是删掉新表，INSERT 一开始就失败，没测到回滚）
  db.exec("CREATE TRIGGER block_delete BEFORE DELETE ON work_entries BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  let threw = false;
  try { migrateTodos(db); } catch { threw = true; }
  eq(threw, true);
  eq(todos(db).length, before);            // 已经 INSERT 进去的那一行被回滚了，没有留下半截
  eq(db.prepare("SELECT COUNT(*) AS n FROM work_entries WHERE kind = 'todo'").get().n, 1);   // 旧待办还在
  // 连接没有停在「事务中」：再开一个事务不会报「cannot start a transaction within a transaction」
  db.exec('BEGIN'); db.exec('ROLLBACK');
  // 去掉障碍后可以重新迁移成功，说明失败没有留下需要手动修复的状态
  db.exec('DROP TRIGGER block_delete');
  eq(migrateTodos(db), 1);
  eq(todos(db).length, before + 1);
  eq(db.prepare("SELECT COUNT(*) AS n FROM work_entries WHERE kind = 'todo'").get().n, 0);
});

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exit(1);

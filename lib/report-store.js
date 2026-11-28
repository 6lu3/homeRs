'use strict';
// 周报的文件存储：模板 docx、设置、示例（纯文字）。全部放在传入的目录下（data/report）。
// 写入先写临时文件再改名；读取时损坏的文件被跳过，不让接口 500。
const fs = require('node:fs');
const path = require('node:path');
const { weekStart } = require('./menu');
const { DEFAULT_ANCHOR } = require('./report-dates');
const { LIMITS } = require('./report-ai');

const cut = (s, n) => [...String(s)].slice(0, n).join('');

function createReportStore(dir) {
  const exDir = path.join(dir, 'examples');
  const ensure = () => fs.mkdirSync(exDir, { recursive: true });
  function writeAtomic(file, data) {
    ensure();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }
  const tryRead = file => { try { return fs.readFileSync(file); } catch { return null; } };

  // 所有可用的示例，按 id 升序
  function examples() {
    let names;
    try { names = fs.readdirSync(exDir); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(exDir, n), 'utf8'));
        if (j && typeof j.title === 'string' && typeof j.text === 'string') out.push({ id: Number(n.slice(0, -5)), title: j.title, text: j.text });
      } catch { /* 损坏的跳过 */ }
    }
    return out.sort((a, b) => a.id - b.id);
  }
  // 现有文件里最大的 id（含损坏的），新 id 必须比它大，避免和旧文件重名
  function maxFileId() {
    try { return Math.max(0, ...fs.readdirSync(exDir).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.slice(0, -5)))); } catch { return 0; }
  }
  const rm = id => { try { fs.unlinkSync(path.join(exDir, `${id}.json`)); return true; } catch { return false; } };

  return {
    getTemplate() { return tryRead(path.join(dir, 'template.docx')); },
    hasTemplate() { return fs.existsSync(path.join(dir, 'template.docx')); },   // status 只要知道有没有，不必把整个模板读进内存
    setTemplate(buf) { writeAtomic(path.join(dir, 'template.docx'), buf); },
    getSettings() {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
        return { anchor: weekStart(String(j.anchor)) };
      } catch { return { anchor: DEFAULT_ANCHOR }; }
    },
    setSettings({ anchor }) {
      const a = weekStart(anchor);   // 非法日期抛错
      writeAtomic(path.join(dir, 'settings.json'), JSON.stringify({ anchor: a }));
    },
    listExamples() { return examples().map(e => ({ id: e.id, title: e.title, chars: [...e.text].length })); },
    readExamples() { return examples().map(e => e.text); },
    addExample({ title, text }) {
      ensure();
      const t = cut(String(title ?? '').trim(), 40) || '示例';
      const id = Math.max(Date.now(), maxFileId() + 1);
      const old = examples().filter(e => e.title === t).map(e => e.id);   // 同标题的旧示例，等新的写成功之后再删（写失败时旧的还在）
      writeAtomic(path.join(exDir, `${id}.json`), JSON.stringify({ title: t, text: cut(text, LIMITS.example) }));
      for (const oldId of old) rm(oldId);
      const all = examples();
      for (const e of all.slice(0, Math.max(0, all.length - LIMITS.examples))) rm(e.id);   // 超过 4 份丢最旧的
      return id;
    },
    removeExample(id) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return false;
      return rm(id);
    },
  };
}

module.exports = { createReportStore };

/* エンドロール 実行環境（Claude以外のブラウザでも動かすための代替レイヤー）
   - user:      この端末だけの利用者（ログイン不要）
   - db:        ブラウザ内（IndexedDB）に保存。サーバーには送らない
   - downloads: ファイルをこの端末に保存
   - sample:    AI。利用者が自分の Anthropic APIキーを入れた場合のみ動く（キーはこの端末にだけ保存） */
(function () {
  "use strict";
  const MODEL = "claude-sonnet-5-5";
  const KEY_NAME = "endroll_apikey";

  /* ---------- user ---------- */
  const AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="#9aa0b8"/><circle cx="32" cy="25" r="11" fill="#fff"/><path d="M10 58c3-14 13-20 22-20s19 6 22 20z" fill="#fff"/></svg>');
  const user = { me: async () => ({ id: "local", name: "あなた", avatarUrl: AVATAR }) };

  /* ---------- db (IndexedDB) ---------- */
  let dbp = null;
  const openDb = () => dbp || (dbp = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error("no indexedDB"));
    const r = indexedDB.open("endroll", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("docs");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((res, rej) => {
      const t = db.transaction("docs", mode), s = t.objectStore("docs");
      let out; try { out = fn(s); } catch (e) { return rej(e); }
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const collection = path => ({
    doc: id => ({
      set: async data => {
        try { await tx("readwrite", s => s.put(data, path + "/" + id)); }
        catch (e) { throw { code: e && e.name === "QuotaExceededError" ? "quota_exceeded" : "write_failed" }; }
      },
      delete: async () => { await tx("readwrite", s => s.delete(path + "/" + id)); }
    }),
    onSnapshot: (ok, fail) => {
      openDb()
        .then(async db => {
          const docs = await new Promise((res, rej) => {
            const out = [], rg = IDBKeyRange.bound(path + "/", path + "/￿");
            const c = db.transaction("docs").objectStore("docs").openCursor(rg);
            c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ id: String(cur.key).slice(path.length + 1), data: cur.value }); cur.continue(); } else res(out); };
            c.onerror = () => rej(c.error);
          });
          ok({ metadata: { fromCache: false }, docChanges: () => docs.map(d => ({ type: "added", doc: { id: d.id, data: () => d.data } })) });
        })
        .catch(e => fail && fail(e));
      return () => {};
    }
  });
  const dbCap = { collection };

  /* ---------- downloads ---------- */
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  };

  /* ---------- AI (利用者自身のAPIキー) ---------- */
  const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ""; } catch (_) { return ""; } };
  const setKey = v => { try { v ? localStorage.setItem(KEY_NAME, v) : localStorage.removeItem(KEY_NAME); } catch (_) {} };

  async function call(messages, opts) {
    opts = opts || {};
    const key = getKey();
    if (!key) { openDialog(); throw { code: "not_granted" }; }
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: opts.signal,
        headers: {
          "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 16000, stream: true, messages })
      });
    } catch (e) { throw e && e.name === "AbortError" ? { code: "cancelled" } : { code: "network" }; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) { openDialog(); throw { code: "not_granted" }; }
      if (res.status === 429) throw { code: "rate_limited" };
      if (res.status === 413) throw { code: "prompt_too_large" };
      throw { code: "api_" + res.status };
    }
    const rd = res.body.getReader(), dec = new TextDecoder();
    let buf = "", text = "";
    try {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch (_) { continue; }
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
            text += ev.delta.text; if (opts.onText) opts.onText({ text });
          } else if (ev.type === "error") throw { code: "api_error" };
        }
      }
    } catch (e) { throw e && e.name === "AbortError" ? { code: "cancelled" } : (e && e.code ? e : { code: "network" }); }
    return { text };
  }

  const sample = async (messages, opts) => call(messages, opts);
  sample.json = async (prompt, opts) => {
    const { text } = await call([{ role: "user", content: prompt }], opts);
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try { return JSON.parse(text.slice(a, b + 1)); } catch (_) { throw { code: "invalid_json" }; }
  };

  /* ---------- AI設定ダイアログ ---------- */
  let dlg;
  function openDialog() {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.style.cssText = "max-width:min(560px,92vw);border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;background:var(--card,#fff);color:var(--ink,#222);font:16px/1.7 var(--font-body,sans-serif)";
      dlg.innerHTML =
        '<h2 style="margin:0 0 8px;font-size:18px">AIの設定</h2>' +
        '<p style="margin:0 0 10px">AIで議事録を作る・質問するには、ご自身の Anthropic APIキーが必要です。キーはこの端末のブラウザにだけ保存され、開発者や他の人には送られません。</p>' +
        '<p style="margin:0 0 10px;padding:10px 12px;border-radius:10px;background:var(--warn-tint,#f1eadb)"><b>ご注意：</b>AIを使うと、文字起こしと資料の内容が Anthropic 社のサーバー（国外）に送信されます。「庁内限り」「要配慮（個人情報等）」の会議は、所属組織のルールを確認してから使ってください。共有PCではキーを保存しないでください。</p>' +
        '<label style="display:block;margin:0 0 4px">APIキー</label>' +
        '<input id="er-key" type="password" autocomplete="off" placeholder="sk-ant-..." style="width:100%;padding:10px;border:1px solid var(--line,#ccc);border-radius:8px;font-size:16px;background:var(--bg,#fff);color:inherit">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap">' +
        '<button type="button" id="er-del" class="btn quiet">キーを削除</button><button type="button" id="er-cancel" class="btn quiet">閉じる</button><button type="button" id="er-save" class="btn">保存</button></div>';
      document.body.appendChild(dlg);
      dlg.querySelector("#er-cancel").onclick = () => dlg.close();
      dlg.querySelector("#er-del").onclick = () => { setKey(""); dlg.querySelector("#er-key").value = ""; dlg.close(); };
      dlg.querySelector("#er-save").onclick = () => { setKey(dlg.querySelector("#er-key").value.trim()); dlg.close(); };
    }
    dlg.querySelector("#er-key").value = getKey();
    if (!dlg.open) dlg.showModal();
  }
  function addButton() {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn sm quiet"; b.textContent = "AIの設定";
    b.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:50;box-shadow:0 2px 8px rgba(0,0,0,.15);background:var(--card,#fff)";
    b.onclick = openDialog; document.body.appendChild(b);
  }
  document.addEventListener("DOMContentLoaded", addButton);

  /* ---------- window.claude 互換 ---------- */
  const caps = { user, db: dbCap, sample, downloads };
  if (!window.claude) window.claude = { use: async n => caps[n] || null };
})();

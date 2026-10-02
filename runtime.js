/* エンドロール 実行環境（Claude以外のブラウザでも動かすための代替レイヤー）
   - user:      この端末だけの利用者（ログイン不要）
   - db:        ブラウザ内（IndexedDB）に保存。サーバーには送らない
   - downloads: ファイルをこの端末に保存
   - sample:    AI。標準は「この端末のAI」（WebLLM。無料・内容は端末の外に出ない）。
                任意で、利用者自身の Anthropic APIキーによる高品質モードも選べる */
(function () {
  "use strict";
  const WEBLLM = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm";
  const LOCAL_MODELS = {
    std: { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", ctx: 16384, label: "標準（約2.5GB）" },
    high: { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", ctx: 12288, label: "高品質（約5GB・高性能PC向け）" }
  };
  const CLOUD_MODEL = "claude-sonnet-5-5";
  const LS = {
    get: k => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (_) {} }
  };
  const getMode = () => LS.get("endroll_ai") === "cloud" ? "cloud" : "local";
  const getSize = () => LS.get("endroll_model") === "high" ? "high" : "std";

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
      try { fn(s); } catch (e) { return rej(e); }
      t.oncomplete = () => res();
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

  /* ---------- AI: この端末のAI（WebLLM） ---------- */
  let engine = null, engineKey = "", loading = null;
  const ready = () => !!engine && engineKey === getSize();

  async function loadEngine() {
    if (ready()) return engine;
    if (loading) return loading;
    if (!navigator.gpu) throw { code: "no_webgpu" };
    const m = LOCAL_MODELS[getSize()], key = getSize();
    loading = (async () => {
      try {
        setProgress(0, "準備しています");
        const webllm = await import(WEBLLM);
        if (engine) { try { await engine.unload(); } catch (_) {} engine = null; }
        engine = await webllm.CreateMLCEngine(m.id, {
          initProgressCallback: p => setProgress(p.progress, p.text)
        }, { context_window_size: m.ctx });
        engineKey = key;
        setProgress(null);
        return engine;
      } catch (e) { console.error("[endroll] model load", e); engine = null; setProgress(null); throw { code: "model_load" }; }
      finally { loading = null; }
    })();
    return loading;
  }

  async function callLocal(messages, opts, json) {
    if (!ready()) { if (!LS.get("endroll_local_ok")) { openDialog(); throw { code: "not_granted" }; } await loadEngine(); }
    const e = engine, sig = opts.signal;
    if (sig && sig.aborted) throw { code: "cancelled" };
    const stop = () => { try { e.interruptGenerate(); } catch (_) {} };
    if (sig) sig.addEventListener("abort", stop, { once: true });
    let text = "";
    try {
      const it = await e.chat.completions.create({
        messages, stream: true, temperature: 0.2, max_tokens: 4096,
        ...(json ? { response_format: { type: "json_object" } } : {})
      });
      for await (const ch of it) {
        const d = ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
        if (d) { text += d; if (opts.onText) opts.onText({ text }); }
      }
    } catch (err) {
      if (sig && sig.aborted) throw { code: "cancelled" };
      console.error("[endroll] generate", err);
      throw { code: /context|exceed|too (long|large)/i.test(String(err && (err.name + err.message))) ? "prompt_too_large" : "model_load" };
    } finally { if (sig) sig.removeEventListener("abort", stop); }
    if (sig && sig.aborted) throw { code: "cancelled" };
    return { text };
  }

  /* ---------- AI: 利用者自身の Anthropic APIキー（任意） ---------- */
  async function callCloud(messages, opts) {
    const key = LS.get("endroll_apikey");
    if (!key) { openDialog(); throw { code: "not_granted" }; }
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: opts.signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: CLOUD_MODEL, max_tokens: 16000, stream: true, messages })
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

  const call = (messages, opts, json) => getMode() === "cloud" ? callCloud(messages, opts || {}) : callLocal(messages, opts || {}, json);
  const sample = async (messages, opts) => call(messages, opts, false);
  sample.json = async (prompt, opts) => {
    const { text } = await call([{ role: "user", content: prompt }], opts, true);
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    try { return JSON.parse(text.slice(a, b + 1)); } catch (_) { throw { code: "invalid_json" }; }
  };

  /* ---------- 進捗バー ---------- */
  let bar;
  function setProgress(p, text) {
    if (p === null) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      bar = document.createElement("div"); bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:60;max-width:min(420px,calc(100vw - 150px));padding:10px 14px;border-radius:12px;background:var(--card,#fff);color:var(--ink,#222);border:1px solid var(--line,#ddd);box-shadow:0 2px 10px rgba(0,0,0,.15);font:14px/1.5 var(--font-body,sans-serif)";
      bar.innerHTML = '<div id="er-ptext"></div><div style="height:6px;border-radius:3px;background:var(--line,#ddd);margin-top:6px;overflow:hidden"><div id="er-pfill" style="height:100%;width:0;background:var(--brand,#4F5478)"></div></div>';
      document.body.appendChild(bar);
    }
    bar.hidden = false;
    bar.querySelector("#er-pfill").style.width = Math.round((p || 0) * 100) + "%";
    bar.querySelector("#er-ptext").textContent = "AIを準備中（初回のみ。閉じずにお待ちください）" + Math.round((p || 0) * 100) + "%";
  }

  /* ---------- AI設定ダイアログ ---------- */
  let dlg;
  const $d = s => dlg.querySelector(s);
  function openDialog() {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.style.cssText = "max-width:min(580px,94vw);max-height:90vh;overflow:auto;border:1px solid var(--line,#ddd);border-radius:14px;padding:22px;background:var(--card,#fff);color:var(--ink,#222);font:16px/1.7 var(--font-body,sans-serif)";
      const note = "margin:0 0 10px;padding:10px 12px;border-radius:10px;";
      dlg.innerHTML =
        '<h2 style="margin:0 0 8px;font-size:18px">AIの設定</h2>' +
        '<label style="display:block;margin:0 0 10px"><input type="radio" name="er-mode" value="local"> <b>この端末のAI（無料・おすすめ）</b><br><span style="color:var(--ink2,#666);font-size:14px">会議の内容は端末の外に出ません。初回だけ、AIモデルをこの端末にダウンロードします。</span></label>' +
        '<div id="er-local" style="margin:0 0 14px 24px">' +
        '<select id="er-size" style="padding:8px;border:1px solid var(--line,#ccc);border-radius:8px;font-size:16px;background:var(--bg,#fff);color:inherit"></select>' +
        '<p id="er-gpu" style="' + note + 'background:var(--warn-tint,#f1eadb);display:none">このブラウザでは端末内AIを使えません（WebGPU非対応）。最新の Edge / Chrome（PC）でお試しください。</p>' +
        '<p style="margin:8px 0 0;font-size:14px;color:var(--ink2,#666)">高性能なクラウドAIより、長い会議の整理は粗くなります。必ず内容を確認してください。通信は、初回のモデル取得（Hugging Face）にのみ使います。</p>' +
        '<div style="margin-top:8px"><button type="button" id="er-prep" class="btn">ダウンロードして準備する</button> <span id="er-state" style="font-size:14px"></span></div></div>' +
        '<label style="display:block;margin:0 0 6px"><input type="radio" name="er-mode" value="cloud"> <b>Anthropic APIキーを使う（高品質）</b></label>' +
        '<div id="er-cloud" style="margin:0 0 6px 24px">' +
        '<p style="' + note + 'background:var(--warn-tint,#f1eadb)"><b>ご注意：</b>文字起こしと資料の内容が Anthropic 社のサーバー（国外）に送信され、利用料はキーの持ち主の負担です。「庁内限り」「要配慮」の会議は、所属組織のルールを確認してください。共有PCでは使わないでください。</p>' +
        '<input id="er-key" type="password" autocomplete="off" placeholder="sk-ant-..." style="width:100%;padding:10px;border:1px solid var(--line,#ccc);border-radius:8px;font-size:16px;background:var(--bg,#fff);color:inherit"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap"><button type="button" id="er-del" class="btn quiet">キーを削除</button><button type="button" id="er-close" class="btn">保存して閉じる</button></div>';
      document.body.appendChild(dlg);
      $d("#er-size").innerHTML = Object.keys(LOCAL_MODELS).map(k => '<option value="' + k + '">' + LOCAL_MODELS[k].label + "</option>").join("");
      if (!navigator.gpu) $d("#er-gpu").style.display = "block";
      const sync = () => {
        const cloud = dlg.querySelector('input[name="er-mode"]:checked').value === "cloud";
        $d("#er-local").style.opacity = cloud ? ".5" : "1"; $d("#er-cloud").style.opacity = cloud ? "1" : ".5";
        $d("#er-state").textContent = ready() ? "準備できています" : "";
      };
      dlg.querySelectorAll('input[name="er-mode"]').forEach(r => r.onchange = sync);
      $d("#er-size").onchange = () => { LS.set("endroll_model", $d("#er-size").value); sync(); };
      $d("#er-prep").onclick = async () => {
        LS.set("endroll_local_ok", "1"); LS.set("endroll_ai", "local"); LS.set("endroll_model", $d("#er-size").value);
        $d("#er-state").textContent = "ダウンロード中…（画面右下の進捗をご覧ください）";
        try { await loadEngine(); $d("#er-state").textContent = "準備できました。閉じて「議事録を作る」を押してください"; }
        catch (e) { $d("#er-state").textContent = e && e.code === "no_webgpu" ? "この端末では使えません" : "準備に失敗しました。もう一度お試しください"; }
      };
      $d("#er-del").onclick = () => { LS.set("endroll_apikey", ""); $d("#er-key").value = ""; };
      $d("#er-close").onclick = () => {
        const mode = dlg.querySelector('input[name="er-mode"]:checked').value;
        LS.set("endroll_ai", mode); LS.set("endroll_apikey", $d("#er-key").value.trim()); LS.set("endroll_model", $d("#er-size").value);
        dlg.close();
      };
    }
    dlg.querySelector('input[name="er-mode"][value="' + getMode() + '"]').checked = true;
    $d("#er-size").value = getSize(); $d("#er-key").value = LS.get("endroll_apikey");
    dlg.querySelector('input[name="er-mode"]:checked').dispatchEvent(new Event("change"));
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

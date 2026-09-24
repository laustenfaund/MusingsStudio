"use strict";
/* Google Drive sync for Musings Studio.
   Uses the drive.file permission: the app can only see files it created
   and files Molly picks herself. Data goes straight from this browser to her Drive. */
const Drive = (() => {
  const CFG = window.MUSINGS_CONFIG || {};
  const enabled = !!(CFG.GOOGLE_CLIENT_ID && !/^PASTE/.test(CFG.GOOGLE_CLIENT_ID));
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const API = "https://www.googleapis.com/drive/v3/";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  let token = null, tokenExp = 0, tokenClient = null, gisP = null, pickerP = null;
  let meta = null, hooks = {}, status = "off", statusMsg = "";
  let syncing = false, again = false, pushTimer = null, lastFocusSync = 0;
  const listeners = new Set();

  const setStatus = (s, msg = "") => { status = s; statusMsg = msg; listeners.forEach(f => f(s, msg)); };
  const hasToken = () => token && Date.now() < tokenExp;
  const q = s => encodeURIComponent(s);
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src));
      document.head.append(s);
    });
  }
  function ensureGis() {
    if (!gisP) gisP = loadScript("https://accounts.google.com/gsi/client").then(() => {
      tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {} });
    }).catch(e => { gisP = null; throw e; });
    return gisP;
  }
  function ensurePicker() {
    if (!pickerP) pickerP = loadScript("https://apis.google.com/js/api.js")
      .then(() => new Promise(r => gapi.load("picker", { callback: r })))
      .catch(e => { pickerP = null; throw e; });
    return pickerP;
  }
  async function loadMeta() {
    meta = (await DB.get("kv", "drive").catch(() => null)) || {};
    meta = Object.assign({ connected: false, email: "", folderId: null, mediaId: null, decksId: null, dataId: null, notesId: null,
      remoteModified: null, rev: 0, pushedRev: 0, map: {}, deckFolders: {} }, meta);
  }
  const saveMeta = () => DB.put("kv", "drive", meta).catch(() => {});

  /* Token: must be requested from a tap. Runs fn once a token is in hand. */
  function withToken(fn, { consent = false } = {}) {
    if (hasToken()) return fn();
    if (!tokenClient) { hooks.toast("Google sign-in is still loading. Try again in a moment."); ensureGis().catch(() => {}); return; }
    tokenClient.callback = r => {
      if (r.error) { setStatus(meta.connected ? "paused" : "off", meta.connected ? "Tap to reconnect Drive" : ""); return; }
      if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) { hooks.toast("Drive access wasn't allowed, so nothing was connected."); setStatus("off"); return; }
      token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in || 3600) - 90) * 1000;
      fn();
    };
    tokenClient.error_callback = () => setStatus(meta.connected ? "paused" : "off", meta.connected ? "Tap to reconnect Drive" : "");
    tokenClient.requestAccessToken({ prompt: consent ? "consent" : "", hint: meta.email || undefined });
  }

  async function api(url, opts = {}) {
    if (!hasToken()) throw { code: "auth" };
    const r = await fetch(url.startsWith("http") ? url : API + url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
    if (r.status === 401) { token = null; throw { code: "auth" }; }
    if (!r.ok) throw { code: "http", status: r.status, message: await r.text().catch(() => "") };
    return r;
  }
  const json = async (url, opts) => (await api(url, opts)).json();
  async function findOne(query) {
    const j = await json(`files?q=${q(query + " and trashed=false")}&fields=files(id,name,modifiedTime,appProperties)&pageSize=10&spaces=drive`);
    return j.files[0] || null;
  }
  async function listAll(query) {
    let out = [], pt = "";
    do {
      const j = await json(`files?q=${q(query + " and trashed=false")}&fields=nextPageToken,files(id,name,appProperties)&pageSize=1000${pt ? "&pageToken=" + pt : ""}`);
      out = out.concat(j.files); pt = j.nextPageToken;
    } while (pt);
    return out;
  }
  async function createFolder(name, parent, props) {
    const j = await json("files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined, appProperties: props }) });
    return j.id;
  }
  async function alive(id) {
    if (!id) return false;
    try { const j = await json(`files/${id}?fields=id,trashed`); return !j.trashed; }
    catch (e) { if (e.code === "http" && e.status === 404) return false; throw e; }
  }
  const trash = id => api(`files/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }).catch(() => {});
  async function upload({ id, name, mime, parents, appProperties, blob }) {
    const b = "musings" + Math.random().toString(36).slice(2);
    const m = id ? { name, appProperties } : { name, mimeType: mime, parents, appProperties };
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(m)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
    return json(`${UPLOAD}${id ? "/" + id : ""}?uploadType=multipart&fields=id,modifiedTime`, { method: id ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
  }
  const download = async id => (await api(`files/${id}?alt=media`)).blob();
  const extFor = mime => ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" })[mime] || "";

  async function ensureStructure() {
    if (!(await alive(meta.folderId))) {
      const f = await findOne(`appProperties has { key='musings' and value='root' }`);
      meta.folderId = f ? f.id : await createFolder("Musings Studio", null, { musings: "root" });
      Object.assign(meta, { mediaId: null, decksId: null, dataId: null, notesId: null, map: {}, deckFolders: {} });
    }
    const child = async (key, name) => {
      const f = await findOne(`appProperties has { key='musings' and value='${key}' } and '${meta.folderId}' in parents`);
      return f ? f.id : await createFolder(name, meta.folderId, { musings: key });
    };
    if (!meta.mediaId) meta.mediaId = await child("media", "Photos and fonts");
    if (!meta.decksId) meta.decksId = await child("decks", "Decks");
    if (!meta.dataId) { const f = await findOne(`appProperties has { key='musings' and value='data' } and '${meta.folderId}' in parents`); meta.dataId = f ? f.id : null; }
    await saveMeta();
  }

  async function push() {
    const startRev = meta.rev;
    const refs = hooks.blobRefs(hooks.getState());
    for (const id of refs) {
      if (meta.map[id]) continue;
      const blob = await DB.get("blobs", id); if (!blob) continue;
      const mime = blob.type || "application/octet-stream";
      const f = await upload({ name: id + extFor(mime), mime, parents: [meta.mediaId], appProperties: { blob: id }, blob });
      meta.map[id] = f.id; await saveMeta();
    }
    for (const [id, fid] of Object.entries(meta.map)) if (!refs.has(id)) { await trash(fid); delete meta.map[id]; }
    const data = new Blob([JSON.stringify(hooks.getState())], { type: "application/json" });
    const f = await upload({ id: meta.dataId, name: "musings-data.json", mime: "application/json", parents: [meta.folderId], appProperties: { musings: "data" }, blob: data });
    meta.dataId = f.id; meta.remoteModified = f.modifiedTime; meta.pushedRev = startRev; await saveMeta();
    try {
      if (!meta.notesId) { const n = await findOne(`appProperties has { key='musings' and value='notes' } and '${meta.folderId}' in parents`); meta.notesId = n ? n.id : null; }
      const nf = await upload({ id: meta.notesId, name: "Notes.txt", mime: "text/plain", parents: [meta.folderId], appProperties: { musings: "notes" }, blob: new Blob([hooks.notesText()], { type: "text/plain" }) });
      meta.notesId = nf.id; await saveMeta();
    } catch (e) { if (e.code === "auth") throw e; }
  }
  async function pull(remote) {
    const st = JSON.parse(await (await download(meta.dataId)).text());
    if (!st || !Array.isArray(st.notes)) throw { code: "bad-data" };
    const files = await listAll(`'${meta.mediaId}' in parents`);
    const byBlob = {}; files.forEach(f => { const id = f.appProperties && f.appProperties.blob; if (id) byBlob[id] = f.id; });
    const need = hooks.blobRefs(st); meta.map = {};
    for (const id of need) {
      if (!byBlob[id]) continue;
      meta.map[id] = byBlob[id];
      if (!(await DB.get("blobs", id))) await DB.put("blobs", id, await download(byBlob[id]));
    }
    meta.remoteModified = remote.modifiedTime; meta.pushedRev = meta.rev; await saveMeta();
    await hooks.replaceState(st);
  }

  async function sync() {
    if (!enabled || !meta || !meta.connected) return;
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { setStatus("offline", "Offline. Will sync when you're back online."); return; }
    if (!hasToken()) { setStatus("paused", "Tap to reconnect Drive"); return; }
    syncing = true; setStatus("syncing", "Syncing…");
    try {
      await ensureStructure();
      let remote = null;
      if (meta.dataId) { remote = await json(`files/${meta.dataId}?fields=id,modifiedTime,trashed`); if (remote.trashed) { meta.dataId = null; remote = null; } }
      const remoteChanged = remote && remote.modifiedTime !== meta.remoteModified;
      const dirty = meta.rev !== meta.pushedRev;
      if (remoteChanged && dirty) { (await hooks.conflict()) === "drive" ? await pull(remote) : await push(); }
      else if (remoteChanged) await pull(remote);
      else if (dirty || !remote) await push();
      setStatus("synced", "Synced " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    } catch (e) {
      if (e.code === "auth") setStatus("paused", "Tap to reconnect Drive");
      else { console.error(e); setStatus("error", "Couldn't sync. Will try again."); clearTimeout(pushTimer); pushTimer = setTimeout(sync, 30000); }
    } finally {
      syncing = false;
      if (again) { again = false; setTimeout(sync, 400); }
    }
  }

  return {
    enabled,
    get status() { return status; }, get message() { return statusMsg; },
    get email() { return meta ? meta.email : ""; },
    get connected() { return !!(meta && meta.connected); },
    onStatus(f) { listeners.add(f); f(status, statusMsg); },
    async init(h) {
      hooks = h;
      if (!enabled) return;
      await loadMeta();
      ensureGis().catch(() => {});
      if (meta.connected) {
        setStatus("paused", "Tap to reconnect Drive");
        // The first tap anywhere quietly renews access (browsers only allow this from a tap).
        const once = e => { document.removeEventListener("click", once, true); if (e.target.closest && e.target.closest("[data-drive],#syncChip")) return; if (!hasToken() && tokenClient) withToken(() => sync()); };
        document.addEventListener("click", once, true);
      }
      window.addEventListener("online", () => sync());
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && Date.now() - lastFocusSync > 20000) { lastFocusSync = Date.now(); sync(); }
      });
    },
    markDirty() {
      if (!meta) return;
      meta.rev++; saveMeta();
      if (meta.connected) { clearTimeout(pushTimer); pushTimer = setTimeout(sync, 4000); }
    },
    connect() {
      if (!enabled) return;
      setStatus("connecting", "Connecting…");
      withToken(async () => {
        const first = !meta.connected;
        meta.connected = true;
        try { const a = await json("about?fields=user(emailAddress)"); meta.email = a.user.emailAddress; } catch (e) {}
        await saveMeta();
        if (first) {
          try { await ensureStructure(); } catch (e) { setStatus("error", "Couldn't reach Drive."); return; }
          if (meta.dataId && (await hooks.firstConnect()) === "drive") {
            setStatus("syncing", "Syncing…");
            try { await pull(await json(`files/${meta.dataId}?fields=id,modifiedTime`)); setStatus("synced", "Synced"); }
            catch (e) { setStatus("error", "Couldn't sync. Will try again."); }
            return;
          }
          meta.rev++; await saveMeta();
        }
        sync();
      }, { consent: !meta.connected });
    },
    reconnect() { setStatus("connecting", "Connecting…"); withToken(() => sync()); },
    syncNow() { withToken(() => sync()); },
    async disconnect() {
      try { if (token) google.accounts.oauth2.revoke(token, () => {}); } catch (e) {}
      token = null; meta.connected = false; await saveMeta(); setStatus("off", "");
    },
    /* Opens Google's file picker. Resolves to File objects downloaded from her Drive. */
    pick({ images = true, multi = false } = {}) {
      return new Promise(res => {
        withToken(async () => {
          try { await ensurePicker(); } catch (e) { hooks.toast("Google's file picker didn't load. Check your connection."); return res([]); }
          const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
          if (images) view.setMimeTypes("image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif");
          const b = new google.picker.PickerBuilder().addView(view).setOAuthToken(token)
            .setDeveloperKey(CFG.GOOGLE_API_KEY).setAppId(String(CFG.GOOGLE_APP_ID || "")).setOrigin(location.origin)
            .setTitle(images ? "Choose photos" : "Choose a file")
            .setCallback(async d => {
              if (d.action === google.picker.Action.PICKED) {
                hooks.toast("Bringing in from Drive…");
                const out = [];
                for (const doc of d.docs) { try { const blob = await download(doc.id); out.push(new File([blob], doc.name, { type: doc.mimeType || blob.type })); } catch (e) {} }
                res(out);
              } else if (d.action === google.picker.Action.CANCEL) res([]);
            });
          if (multi) b.enableFeature(google.picker.Feature.MULTISELECT_ENABLED);
          if (window.innerWidth < 760) b.setSize(window.innerWidth - 16, window.innerHeight - 32);
          b.build().setVisible(true);
        });
      });
    },
    /* Saves a deck's exported images into Musings Studio/Decks/<deck name>. */
    saveDeck(deck, files) {
      return new Promise(res => {
        withToken(async () => {
          try {
            await ensureStructure();
            let fid = meta.deckFolders[deck.id];
            if (!(await alive(fid))) {
              const f = await findOne(`appProperties has { key='deck' and value='${esc(deck.id)}' } and '${meta.decksId}' in parents`);
              fid = f ? f.id : await createFolder(deck.name, meta.decksId, { deck: deck.id });
              meta.deckFolders[deck.id] = fid; await saveMeta();
            }
            await api(`files/${fid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: deck.name }) });
            const existing = await listAll(`'${fid}' in parents`);
            const byName = {}; existing.forEach(f => byName[f.name] = f.id);
            for (const [name, blob] of files) { await upload({ id: byName[name], name, mime: "image/png", parents: [fid], blob }); delete byName[name]; }
            for (const id of Object.values(byName)) await trash(id);
            res(true);
          } catch (e) { console.error(e); res(false); }
        });
      });
    }
  };
})();
window.Drive = Drive;

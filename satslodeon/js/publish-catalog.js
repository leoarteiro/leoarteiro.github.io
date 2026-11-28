import { npubEncode, verifyEvent } from "../vendor/nostr-tools.min.mjs";
import { sha256Hex, authHeader, upload, hasBlob } from "./blossom.js";
import {
  CATALOG_KIND, CATALOG_D_TAG, CATALOG_RELAYS, catalogPubkey, fetchNostrCatalog,
} from "./nostr-catalog.js";

const $ = (id) => document.getElementById(id);
const projectKey = catalogPubkey();
const short = (npub) => `${npub.slice(0, 14)}…${npub.slice(-6)}`;
const when = (ts) => new Date(ts * 1000).toLocaleString("pt-BR");
let connectedKey = null;
let signer = null; // { signEvent } from the extension or from Amber (NIP-46)
let amberSigner = null;

function line(list, text, cls = "") {
  const li = Object.assign(document.createElement("li"), { textContent: text, className: cls });
  $(list).append(li);
  return li;
}

const catalog = await (await fetch("catalog.json", { cache: "no-cache" })).json();
const content = JSON.stringify(catalog);
$("summary").textContent = `${catalog.works.length} obra(s): ${catalog.works.map((w) => w.title).join(", ")}. `
  + `${(content.length / 1024).toFixed(1)} KB.`;

if (!projectKey) {
  line("compare", "A chave do projeto ainda não está definida (CATALOG_NPUB em js/nostr-catalog.js).", "bad");
} else {
  line("compare", `Chave do projeto: ${short(npubEncode(projectKey))}`);
  fetchNostrCatalog(5000).then(({ catalog: current, event, relays }) => {
    const same = JSON.stringify(current) === content;
    line("compare", `Versão nos relays: ${when(event.created_at)} (${relays.length} relay(s)). `
      + (same ? "Igual a este arquivo: não é preciso publicar." : "Diferente deste arquivo."), same ? "ok" : "");
  }).catch(() => line("compare", "Ainda não há catálogo desta chave nos relays."));
}

async function waitForNostr(ms = 3000) {
  for (let t = 0; !window.nostr && t < ms; t += 200) await new Promise((r) => setTimeout(r, 200));
  return window.nostr;
}

// Shared by both ways of connecting: checks that the key is the project's one.
function connected(pubkey, how) {
  const npub = npubEncode(pubkey);
  connectedKey = pubkey;
  if (!projectKey) {
    $("who").innerHTML = `Conectado (${how}): <code>${npub}</code><br>Esta é a npub que vai em <code>CATALOG_NPUB</code>, se esta for a chave do projeto.`;
  } else if (pubkey !== projectKey) {
    $("who").textContent = `Conectado com outra chave (${short(npub)}). Escolha a chave do projeto e conecte de novo.`;
    connectedKey = null;
  } else {
    $("who").textContent = `Conectado com a chave do projeto (${short(npub)}, ${how}).`;
  }
  $("publish").disabled = $("publishProfile").disabled = !(connectedKey && projectKey);
  updateSiteButton();
}

$("connect").onclick = async () => {
  $("who").textContent = "Conectando…";
  if (!(await waitForNostr())) {
    $("who").textContent = "Extensão Nostr não encontrada. Confira se a nos2x está ativa e recarregue a página (F5).";
    return;
  }
  try {
    const pubkey = await window.nostr.getPublicKey();
    signer = { signEvent: (t) => window.nostr.signEvent(t) };
    connected(pubkey, "extensão");
  } catch (e) {
    $("who").textContent = `A extensão recusou ou falhou: ${e?.message || e}`;
  }
};

// Relays used only to talk to Amber (the same ones PlanetsCitys uses with it).
const CONNECT_RELAYS = ["wss://relay.nsec.app", "wss://nos.lol"];
let cancelAmber = null;

$("connectAmber").onclick = async () => {
  cancelAmber?.();
  const { generateSecretKey, getPublicKey, BunkerSigner, createNostrConnectURI } = await import("../vendor/nostr-connect.min.mjs");
  const sk = generateSecretKey();
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(sk), relays: CONNECT_RELAYS, secret: Math.random().toString(36).slice(2, 12),
    perms: [`sign_event:${CATALOG_KIND}`, "sign_event:0", "sign_event:24242", "sign_event:15128", "sign_event:10002"],
    name: "Satslodeon (publicação)",
  });
  $("amber").hidden = false;
  $("amberQr").replaceChildren();
  new QRCode($("amberQr"), { text: uri, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.L });
  $("amberLink").href = uri;
  $("who").textContent = "Aguardando o Amber…";
  const ctl = new AbortController();
  let active = true;
  cancelAmber = () => { active = false; ctl.abort(); };
  try {
    amberSigner?.close().catch(() => {});
    amberSigner = await BunkerSigner.fromURI(sk, uri, {}, ctl.signal);
    if (!active) return;
    const pubkey = await amberSigner.getPublicKey();
    signer = amberSigner;
    $("amber").hidden = true;
    connected(pubkey, "Amber");
  } catch (e) {
    if (active) $("who").textContent = `Não deu certo: ${e?.message || "conexão recusada"}. Tente de novo.`;
  }
};

// Sends the event to one relay and waits for its OK (accepted or refused, with the reason).
function sendToRelay(url, event, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let ws;
    const end = (ok, msg) => { clearTimeout(timer); try { ws.close(); } catch {} resolve({ ok, msg }); };
    const timer = setTimeout(() => end(false, "sem resposta"), timeoutMs);
    try { ws = new WebSocket(url); } catch (e) { end(false, String(e)); return; }
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
    ws.onerror = () => end(false, "falha na conexão");
    ws.onmessage = (m) => {
      let data;
      try { data = JSON.parse(m.data); } catch { return; }
      if (data[0] === "OK" && data[1] === event.id) end(data[2], data[3] || "");
    };
  });
}

// Signs the template with the connected key and sends it to the relays, logging each answer.
async function signAndSend(template, relays, logId, clear = true) {
  if (clear) $(logId).replaceChildren();
  let event;
  try {
    if (signer === amberSigner) line(logId, "Aprove a assinatura no Amber…");
    event = await signer.signEvent({ ...template, created_at: Math.floor(Date.now() / 1000) });
    if (event.pubkey !== projectKey || !verifyEvent(event)) throw new Error("assinatura inválida ou de outra chave");
  } catch (e) {
    line(logId, `Assinatura recusada: ${e?.message || e}`, "bad");
    return null;
  }
  const results = await Promise.all(relays.map(async (url) => {
    const li = line(logId, `${url}: enviando…`);
    const { ok, msg } = await sendToRelay(url, event);
    li.textContent = `${url}: ${ok ? "aceito" : "recusado"}${msg ? ` (${msg})` : ""}`;
    li.className = ok ? "ok" : "bad";
    return ok;
  }));
  const accepted = results.filter(Boolean).length;
  line(logId, `Publicado em ${accepted} de ${relays.length} relays.`, accepted >= 2 ? "ok" : "bad");
  return event;
}

$("publish").onclick = async () => {
  $("publish").disabled = true;
  const event = await signAndSend({
    kind: CATALOG_KIND, tags: [["d", CATALOG_D_TAG], ["alt", "Catálogo de obras do Satslodeon"]], content,
  }, CATALOG_RELAYS, "log");
  // Read it back the same way the app does.
  if (event) {
    try {
      const { event: got, relays } = await fetchNostrCatalog(5000);
      const fresh = got.id === event.id;
      line("log", fresh ? `Conferido: o app já recebe esta versão (${relays.length} relay(s)).`
        : "Os relays ainda devolvem uma versão anterior; confira de novo em alguns segundos.", fresh ? "ok" : "bad");
    } catch {
      line("log", "Não foi possível ler de volta dos relays.", "bad");
    }
  }
  $("publish").disabled = false;
};

// ---------- Project profile (kind 0) ----------
// purplepag.es only keeps profiles and relay lists; clients use it to find them.
const PROFILE_RELAYS = [...CATALOG_RELAYS, "wss://purplepag.es"];
const profile = await (await fetch("profile.json", { cache: "no-cache" })).json();
const profileContent = JSON.stringify(profile);

function showProfile() {
  const box = $("profilePreview");
  const img = (cls, src) => Object.assign(document.createElement("img"), { className: cls, src, alt: "" });
  const banner = img("banner", profile.banner);
  const avatar = img("avatar", profile.picture);
  const title = Object.assign(document.createElement("h3"), { textContent: profile.display_name, style: "margin:6px 0 2px" });
  const about = Object.assign(document.createElement("p"), { className: "about", textContent: profile.about });
  const extra = Object.assign(document.createElement("p"), { textContent: `⚡ ${profile.lud16} · ${profile.website}` });
  for (const [el, what] of [[banner, "capa"], [avatar, "avatar"]]) {
    el.onerror = () => line("profileCompare", `A imagem de ${what} ainda não está no Blossom (${el.src.slice(0, 60)}…).`, "bad");
  }
  box.replaceChildren(banner, avatar, title, about, extra);
}
showProfile();

// Latest profile of the project key on any of the relays (kind 0 is replaceable: newest wins).
function fetchProfile(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let best = null;
    let pending = PROFILE_RELAYS.length;
    const sockets = [];
    const finish = () => { clearTimeout(timer); sockets.forEach((ws) => { try { ws.close(); } catch {} }); resolve(best); };
    const timer = setTimeout(finish, timeoutMs);
    for (const url of PROFILE_RELAYS) {
      const ws = new WebSocket(url);
      sockets.push(ws);
      let done = false;
      const once = () => { if (!done) { done = true; if (--pending === 0) finish(); } };
      ws.onopen = () => ws.send(JSON.stringify(["REQ", "p", { kinds: [0], authors: [projectKey] }]));
      ws.onerror = ws.onclose = once;
      ws.onmessage = (m) => {
        let d;
        try { d = JSON.parse(m.data); } catch { return; }
        if (d[0] === "EOSE") once();
        else if (d[0] === "EVENT" && d[2]?.pubkey === projectKey && verifyEvent(d[2])
          && (!best || d[2].created_at > best.created_at)) best = d[2];
      };
    }
  });
}

if (projectKey) {
  fetchProfile().then((current) => {
    if (!current) return line("profileCompare", "Ainda não há perfil desta chave nos relays.");
    const same = current.content === profileContent;
    line("profileCompare", `Perfil nos relays: ${when(current.created_at)}. `
      + (same ? "Igual ao arquivo: não é preciso publicar." : "Diferente do arquivo."), same ? "ok" : "");
  });
}

$("publishProfile").onclick = async () => {
  $("publishProfile").disabled = true;
  const event = await signAndSend({ kind: 0, tags: [], content: profileContent }, PROFILE_RELAYS, "profileLog");
  if (event) {
    const got = await fetchProfile();
    line("profileLog", got?.id === event.id ? "Conferido: o perfil novo já aparece nos relays."
      : "Os relays ainda devolvem o perfil anterior; confira de novo em alguns segundos.", got?.id === event.id ? "ok" : "bad");
  }
  $("publishProfile").disabled = false;
};

// ---------- Site as an nsite (NIP-5A) ----------
// Kind 15128 = the key's root site: one ["path", "/file", sha256] tag per file, files stored on Blossom.
// Gateways serve it at https://<npub>.<gateway>/ .
const SITE_KIND = 15128;
const SITE_SERVERS = ["https://nostr.download", "https://blossom.band", "https://cdn.hzrd149.com",
  "https://blossom.f7z.io", "https://blossom.primal.net"];
const GATEWAYS = ["nsite.lol"];
const HASH_BATCH = 25; // hashes per Blossom authorization
const PARALLEL = 3;
let siteFiles = []; // [{ file, path, hash }]

$("siteServers").append(...SITE_SERVERS.map((url) => {
  const label = document.createElement("label");
  label.append(Object.assign(document.createElement("input"), { type: "checkbox", checked: true, value: url }), url);
  return label;
}));

function updateSiteButton() {
  $("publishSite").disabled = !(connectedKey && projectKey && siteFiles.length && siteFiles.every((f) => f.hash));
}

$("siteFolder").onchange = async (e) => {
  // webkitRelativePath = "web/js/app.js": drop the chosen folder's own name.
  siteFiles = [...e.target.files]
    .map((file) => ({ file, path: "/" + file.webkitRelativePath.split("/").slice(1).join("/"), hash: null }))
    .filter((f) => !f.path.startsWith("/dev/") && !f.path.split("/").some((part) => part.startsWith(".")));
  updateSiteButton();
  if (!siteFiles.find((f) => f.path === "/index.html")) {
    $("siteSummary").textContent = "Essa pasta não tem index.html na raiz: escolha a pasta web do projeto.";
    siteFiles = [];
    return;
  }
  const total = siteFiles.reduce((n, f) => n + f.file.size, 0);
  $("siteSummary").textContent = `Calculando o hash de ${siteFiles.length} arquivos…`;
  for (const f of siteFiles) f.hash = await sha256Hex(f.file);
  $("siteSummary").textContent = `${siteFiles.length} arquivos, ${(total / 1048576).toFixed(1)} MB.`;
  updateSiteButton();
};

// Same order-independent hash the NIP defines for a site version.
async function aggregateHash(pathTags) {
  const lines = pathTags.map(([, path, hash]) => `${hash} ${path}\n`).sort().join("");
  return sha256Hex(new Blob([lines]));
}

async function inParallel(items, n, work) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

$("publishSite").onclick = async () => {
  $("publishSite").disabled = true;
  $("siteLog").replaceChildren();
  const servers = [...document.querySelectorAll("#siteServers input:checked")].map((i) => i.value);
  const sign = (t) => signer.signEvent(t);

  // 1. What each server is missing.
  const checking = line("siteLog", "Conferindo o que já está nos servidores…");
  const missing = new Map(); // server -> files
  for (const server of servers) {
    const lacking = [];
    await inParallel(siteFiles, 6, async (f) => { if (!(await hasBlob(server, f.hash))) lacking.push(f); });
    missing.set(server, lacking);
  }
  checking.textContent = servers.map((s) => `${new URL(s).host}: faltam ${missing.get(s).length}`).join(" · ");

  // 2. One authorization per batch of hashes (covers every server).
  const needed = [...new Set([...missing.values()].flat())];
  const auths = new Map(); // hash -> header
  try {
    for (let i = 0; i < needed.length; i += HASH_BATCH) {
      const batch = needed.slice(i, i + HASH_BATCH);
      if (signer === amberSigner) line("siteLog", `Aprove no Amber a autorização de envio ${i / HASH_BATCH + 1} de ${Math.ceil(needed.length / HASH_BATCH)}…`);
      const header = await authHeader("upload", batch.map((f) => f.hash), "Satslodeon: arquivos do site", sign);
      for (const f of batch) auths.set(f.hash, header);
    }
  } catch (e) {
    line("siteLog", `Autorização recusada: ${e?.message || e}`, "bad");
    updateSiteButton();
    return;
  }

  // 3. Upload what is missing, all servers at once. Site files are small: a server that takes
  // 30 s for one, or refuses 3, is left behind (the authorizations expire in 10 minutes).
  const SITE_FILE_TIMEOUT_MS = 30000;
  const MAX_FAILURES = 3;
  const complete = [];
  await Promise.all(servers.map(async (server) => {
    const host = new URL(server).host;
    const lacking = missing.get(server);
    const li = line("siteLog", `${host}: enviando ${lacking.length}…`);
    let failed = 0;
    let sent = 0;
    let reason = "";
    await inParallel(lacking, PARALLEL, async (f) => {
      if (failed >= MAX_FAILURES) return;
      try {
        const res = await upload(server, f.file, auths.get(f.hash), null, SITE_FILE_TIMEOUT_MS);
        if (res?.sha256 && res.sha256 !== f.hash) throw new Error(`o servidor alterou ${f.path}`);
        li.textContent = `${host}: enviados ${++sent} de ${lacking.length}…`;
      } catch (e) {
        failed++;
        reason ||= `${f.path}: ${e?.message || e}`;
      }
    });
    li.textContent = failed ? `${host}: desisti depois de ${failed} recusa(s) (${reason})` : `${host}: site completo`;
    li.className = failed ? "bad" : "ok";
    if (!failed) complete.push(server);
  }));
  if (!complete.length) {
    line("siteLog", "Nenhum servidor ficou com o site completo; a lista não foi publicada.", "bad");
    updateSiteButton();
    return;
  }

  // 4. The signed list of files.
  const pathTags = siteFiles.map((f) => ["path", f.path, f.hash]);
  const event = await signAndSend({
    kind: SITE_KIND,
    tags: [...pathTags, ["x", await aggregateHash(pathTags), "aggregate"], ...complete.map((s) => ["server", s]),
      ["title", "Satslodeon"], ["description", "Cinema e animação independentes, mantidos por quem assiste"]],
    content: "",
  }, PROFILE_RELAYS, "siteLog", false);
  if (event) {
    // Relay list (NIP-65): where gateways and clients should look for this key's events.
    line("siteLog", "Lista de relays da chave do projeto (para os gateways acharem o site):");
    await signAndSend({ kind: 10002, tags: CATALOG_RELAYS.map((r) => ["r", r]), content: "" }, PROFILE_RELAYS, "siteLog", false);
    const npub = npubEncode(projectKey);
    for (const g of GATEWAYS) {
      const url = `https://${npub}.${g}/`;
      const li = line("siteLog", "");
      li.append("Endereço: ", Object.assign(document.createElement("a"), { href: url, textContent: url, target: "_blank" }));
    }
  }
  updateSiteButton();
};

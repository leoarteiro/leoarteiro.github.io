import { npubEncode, verifyEvent } from "../vendor/nostr-tools.min.mjs";
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
  $("publish").disabled = !(connectedKey && projectKey);
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
    perms: [`sign_event:${CATALOG_KIND}`], name: "Satslodeon (catálogo)",
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

$("publish").onclick = async () => {
  $("publish").disabled = true;
  $("log").replaceChildren();
  let event;
  try {
    if (signer === amberSigner) line("log", "Aprove a assinatura no Amber…");
    event = await signer.signEvent({
      kind: CATALOG_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", CATALOG_D_TAG], ["alt", "Catálogo de obras do Satslodeon"]],
      content,
    });
    if (event.pubkey !== projectKey || !verifyEvent(event)) throw new Error("assinatura inválida ou de outra chave");
  } catch (e) {
    line("log", `Assinatura recusada: ${e?.message || e}`, "bad");
    $("publish").disabled = false;
    return;
  }
  const results = await Promise.all(CATALOG_RELAYS.map(async (url) => {
    const li = line("log", `${url}: enviando…`);
    const { ok, msg } = await sendToRelay(url, event);
    li.textContent = `${url}: ${ok ? "aceito" : "recusado"}${msg ? ` (${msg})` : ""}`;
    li.className = ok ? "ok" : "bad";
    return ok;
  }));
  const accepted = results.filter(Boolean).length;
  line("log", `Publicado em ${accepted} de ${CATALOG_RELAYS.length} relays.`, accepted >= 2 ? "ok" : "bad");
  // Read it back the same way the app does.
  try {
    const { event: got, relays } = await fetchNostrCatalog(5000);
    const fresh = got.id === event.id;
    line("log", fresh ? `Conferido: o app já recebe esta versão (${relays.length} relay(s)).`
      : "Os relays ainda devolvem uma versão anterior; confira de novo em alguns segundos.", fresh ? "ok" : "bad");
  } catch {
    line("log", "Não foi possível ler de volta dos relays.", "bad");
  }
  $("publish").disabled = false;
};

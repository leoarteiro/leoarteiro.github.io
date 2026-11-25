import { T } from "./texts.js";
import { resolveSources } from "./blossom.js";
import { requestInvoice, hasWebLN, payWithWebLN } from "./lightning.js";

const app = document.getElementById("app");
const dialog = document.getElementById("donate");
let catalog;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};

function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

// Loads the first working source into <img>/<video>, moving on to the next one on error.
function attachSources(media, blob, onSource) {
  resolveSources(blob, catalog.blossomServers).then((sources) => {
    let i = 0;
    const tryNext = () => {
      if (i >= sources.length) return media.dispatchEvent(new Event("allfailed"));
      const url = sources[i++];
      media.src = url;
      onSource?.(new URL(url).host);
    };
    media.addEventListener("error", tryNext);
    tryNext();
  });
}

// ---------- Home ----------

function renderHome() {
  document.title = T.appName;
  const cards = catalog.works.map((work, index) => {
    const img = el("img", { alt: work.title, loading: "lazy" });
    attachSources(img, work.poster);
    return el("button", { className: "card", onclick: () => (location.hash = `#/assistir/${index}`) },
      el("div", { className: "poster" }, img, el("span", { className: "play", ariaHidden: "true" }, "▶")),
      el("div", { className: "info" }, el("b", {}, work.title), el("small", {}, work.description)));
  });

  const { raisedSats, targetSats, label } = catalog.goal;
  const pct = Math.min(100, (raisedSats / targetSats) * 100);
  const bar = el("div", { className: "bar", role: "progressbar", ariaValueNow: String(raisedSats), ariaValueMax: String(targetSats) });
  bar.append(el("i", { style: `width:${pct}%` }));

  app.replaceChildren(el("div", { className: "home" },
    el("header", { className: "header" },
      el("h1", {}, "Sats", el("span", {}, "lodeon")), el("p", {}, T.tagline)),
    el("div", { className: "notice" }, T.testNotice, el("small", {}, T.testNoticeDetail)),
    el("h2", { className: "section-title" }, T.productions),
    el("div", { className: "carousel" }, ...cards),
    el("a", { className: "footer-link", href: "upload.html" }, T.uploadLink),
    el("div", { className: "goal" }, el("div", { className: "goal-inner" },
      el("p", {}, label), bar,
      el("div", { className: "row" },
        el("small", {}, T.raised(raisedSats, targetSats)),
        el("button", { className: "btn", onclick: openDonate }, T.support))))));
}

// ---------- Feed ----------

function renderFeed(startIndex) {
  const slides = catalog.works.map((work) => {
    const video = el("video", { controls: true, playsInline: true, preload: "none" });
    const src = el("div", { className: "src" });
    const slide = el("section", { className: "slide" }, video,
      el("div", { className: "overlay" },
        el("h2", {}, work.title), el("p", {}, work.description),
        el("button", { className: "btn", onclick: openDonate }, T.support), src));
    video.addEventListener("allfailed", () => slide.append(el("div", { className: "err" }, T.errorVideo)));
    slide.load = () => {
      if (slide.loaded) return;
      slide.loaded = true;
      attachSources(video, work.video, (host) => (src.textContent = T.source(host)));
      video.preload = "metadata";
    };
    slide.video = video;
    return slide;
  });

  const feed = el("div", { className: "feed" }, ...slides);
  const back = el("button", { className: "back", onclick: () => (location.hash = "#/") }, "← " + T.back);
  app.replaceChildren(feed, back);

  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) { target.video.pause(); continue; }
      target.load();
      const i = slides.indexOf(target);
      slides[i + 1]?.load(); // prefetch next work's metadata
      playWithSoundFallback(target);
    }
  }, { root: feed, threshold: 0.6 });
  // Jump to the chosen work only after layout, then start observing; otherwise the first
  // slide is seen as visible and starts playing (happened in the Android WebView).
  requestAnimationFrame(() => {
    feed.scrollTop = slides[startIndex]?.offsetTop ?? 0;
    slides.forEach((s) => observer.observe(s));
  });
  document.title = `${catalog.works[startIndex]?.title ?? ""} · ${T.appName}`;
}

// Browsers block autoplay with sound outside a user gesture; fall back to muted.
async function playWithSoundFallback(slide) {
  const video = slide.video;
  try {
    await video.play();
  } catch {
    video.muted = true;
    try { await video.play(); } catch { return; }
    if (slide.querySelector(".unmute")) return;
    const unmute = el("button", { className: "unmute", onclick: () => { video.muted = false; unmute.remove(); } }, T.tapForSound);
    slide.append(unmute);
  }
}

// ---------- Donate ----------

const PRESETS = [100, 1000, 5000, 21000];

function openDonate() {
  let sats = 1000;
  const chips = PRESETS.map((v) => el("button", {
    type: "button", ariaPressed: String(v === sats),
    onclick: () => { sats = v; custom.value = ""; chips.forEach((c) => (c.ariaPressed = String(c === chipFor(v)))); },
  }, v.toLocaleString("pt-BR")));
  const chipFor = (v) => chips[PRESETS.indexOf(v)];
  const custom = el("input", { type: "number", min: "1", step: "1", inputMode: "numeric", placeholder: "ex.: 2100",
    oninput: () => { sats = parseInt(custom.value, 10) || 0; chips.forEach((c) => (c.ariaPressed = "false")); } });
  const name = el("input", { maxLength: 40, autocomplete: "nickname" });
  const message = el("input", { maxLength: 100 });
  const error = el("div", { className: "error", role: "alert" });
  const generate = el("button", { className: "btn", type: "button" }, T.generate);

  generate.onclick = async () => {
    error.textContent = "";
    generate.disabled = true;
    generate.textContent = T.generating;
    const comment = [name.value.trim(), message.value.trim()].filter(Boolean).join(": ");
    try {
      showInvoice(await requestInvoice(catalog.lightningAddress, sats, comment));
    } catch (e) {
      console.error(e);
      error.textContent = e instanceof RangeError ? e.message : T.errorInvoice;
      generate.disabled = false;
      generate.textContent = T.generate;
    }
  };

  dialog.replaceChildren(
    el("h2", {}, T.donateTitle), el("p", {}, T.donateIntro),
    el("div", { className: "chips" }, ...chips),
    el("label", {}, T.amount), custom,
    el("label", {}, T.name), name,
    el("label", {}, T.message), message,
    error,
    el("div", { className: "actions" },
      el("button", { className: "btn ghost", type: "button", onclick: () => dialog.close() }, T.close), generate));
  dialog.showModal();
}

function showInvoice(invoice) {
  const link = "lightning:" + invoice;
  const qr = el("a", { className: "qr", href: link, ariaLabel: T.openWallet });
  new QRCode(qr, { text: link.toUpperCase(), width: 520, height: 520, correctLevel: QRCode.CorrectLevel.L });
  const status = el("div", { role: "status" });

  const actions = [
    hasWebLN() && el("button", { className: "btn", type: "button", onclick: async () => {
      try { await payWithWebLN(invoice); status.className = "success"; status.textContent = T.paid; }
      catch (e) { status.className = "error"; status.textContent = e.message; }
    } }, T.payWebLN),
    el("a", { className: "btn ghost", href: link, style: "text-align:center;text-decoration:none" }, T.openWallet),
    el("button", { className: "btn ghost", type: "button", onclick: async () => {
      await navigator.clipboard.writeText(invoice); toast(T.copied);
    } }, T.copy),
    el("button", { className: "btn ghost", type: "button", onclick: openDonate }, T.newAmount),
    el("button", { className: "btn ghost", type: "button", onclick: () => dialog.close() }, T.close),
  ].filter(Boolean);

  dialog.replaceChildren(el("h2", {}, T.donateTitle), el("p", {}, T.scanOrTap), qr, status,
    el("div", { className: "actions" }, ...actions));
}

// ---------- Router ----------

function route() {
  const match = location.hash.match(/^#\/assistir\/(\d+)/);
  if (match) renderFeed(Number(match[1]));
  else renderHome();
}

// The app ships a copy of the catalog, but prefers the published one so that new works
// and Blossom hashes reach phones without a new APK.
const REMOTE_CATALOG_URL = "https://leoarteiro.github.io/satslodeon/catalog.json";
const REMOTE_TIMEOUT_MS = 5000;

async function fetchCatalog(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = timeoutMs && setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-cache", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.works)) throw new Error("invalid catalog");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Relative fallback URLs (e.g. "posters/x.webp") must point to where the catalog came from.
function absolutizeFallbacks(data, baseUrl) {
  for (const work of data.works) {
    for (const blob of [work.video, work.poster]) {
      if (blob?.fallback) blob.fallback = blob.fallback.map((u) => new URL(u, baseUrl).href);
    }
  }
  return data;
}

async function loadCatalog(isNativeApp) {
  if (isNativeApp) {
    try {
      return absolutizeFallbacks(await fetchCatalog(REMOTE_CATALOG_URL, REMOTE_TIMEOUT_MS), REMOTE_CATALOG_URL);
    } catch (e) {
      console.warn("Remote catalog unavailable, using the bundled one:", e);
    }
  }
  return fetchCatalog("catalog.json");
}

async function start() {
  const isNativeApp = window.Capacitor?.isNativePlatform?.() ?? false;
  catalog = await loadCatalog(isNativeApp);
  window.addEventListener("hashchange", route);
  route();
  // Inside the Capacitor app the files are already local; the service worker is only for the website.
  if ("serviceWorker" in navigator && !isNativeApp) navigator.serviceWorker.register("sw.js").catch(() => {});
}

start();

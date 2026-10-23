// The room page: a join gate, the prebuilt <rtk-meeting>, and the book pane.
// One HTML string, no bundler. The kit's host is `position:fixed; inset:0`
// by default; `mode="fill"` makes it `position:relative` at 100% of its
// container, so it lives in #stage and nothing overrides its host style.

const RTK_CORE = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.4/dist/browser.js";
const RTK_UI = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit-ui@2.0.3/loader/index.es2017.js";
const MARKED = "https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js";

export type RoomInput = { meetingId: string; title: string; accessEmail: string | null };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** JSON safe to drop inside a <script>. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderRoom(input: RoomInput): string {
  const boot = scriptJson({ id: input.meetingId, title: input.title, email: input.accessEmail });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)} · acta</title>
<style>
  :root { color-scheme: dark; --bg:#0b0b0c; --fg:#e8e6e3; --mute:#8b8a88; --line:#26262a; --accent:#f38020; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  #app { display: flex; height: 100vh; height: 100dvh; }
  #stage { position: relative; flex: 1 1 auto; min-width: 0; height: 100%; }
  #side { flex: 0 0 380px; display: flex; flex-direction: column; border-left: 1px solid var(--line); min-width: 0; height: 100%; }
  #app.collapsed #side { display: none; }
  #side header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  #side header h1 { font-size: 14px; margin: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #conn { width: 8px; height: 8px; border-radius: 50%; background: var(--mute); }
  #conn.on { background: #3fb950; }
  #book { flex: 1 1 auto; overflow: auto; padding: 4px 16px 16px; }
  #book h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--mute); margin: 18px 0 6px; }
  #book p, #book li { margin: 4px 0; }
  #book details summary { cursor: pointer; color: var(--mute); margin-top: 18px; }
  #book .empty { color: var(--mute); font-style: italic; }
  #strip { flex: 0 0 auto; max-height: 30%; overflow: auto; border-top: 1px solid var(--line); padding: 8px 14px; font-size: 13px; }
  #strip .p { margin: 6px 0; }
  #strip .who { color: var(--accent); font-weight: 600; margin-right: 6px; }
  #strip .when { color: var(--mute); font-size: 11px; margin-left: 4px; }
  #toggle { position: fixed; right: 10px; bottom: 10px; z-index: 10; background: #1b1b1e; color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  #gate { position: absolute; inset: 0; display: grid; place-items: center; }
  #gate form { display: grid; gap: 10px; width: min(320px, 90vw); }
  #gate h2 { margin: 0 0 6px; font-size: 18px; }
  #gate input, #gate button { font: inherit; padding: 9px 12px; border-radius: 6px; border: 1px solid var(--line); background: #141416; color: var(--fg); }
  #gate button { background: var(--accent); border-color: var(--accent); color: #111; font-weight: 600; cursor: pointer; }
  #gate button:disabled { opacity: .6; cursor: default; }
  #err { color: #ff7b72; min-height: 1.5em; font-size: 13px; }
  #ended { display: none; padding: 8px 14px; background: #2d1f12; color: #f0b072; font-size: 13px; }
  @media (max-width: 760px) { #side { position: fixed; inset: 0; z-index: 5; background: var(--bg); flex-basis: auto; } #app:not(.open) #side { display: none; } }
</style>
<script src="${RTK_CORE}"></script>
<script src="${MARKED}"></script>
</head>
<body>
<div id="app">
  <div id="stage">
    <div id="gate">
      <form id="joinForm">
        <h2 id="gateTitle"></h2>
        <input id="name" name="name" autocomplete="name" placeholder="Your name" maxlength="80" required>
        <button id="joinBtn" type="submit">Join</button>
        <div id="err" role="alert"></div>
      </form>
    </div>
  </div>
  <aside id="side">
    <header><span id="conn" title="book connection"></span><h1 id="bookTitle"></h1></header>
    <div id="ended">The meeting has ended. The book stays here.</div>
    <div id="book"><p class="empty">The book fills in as the meeting goes.</p></div>
    <div id="strip"></div>
  </aside>
</div>
<button id="toggle" type="button">Book</button>
<script type="module">
import { defineCustomElements } from "${RTK_UI}";
defineCustomElements();

const BOOT = ${boot};
const params = new URLSearchParams(location.search);
const KEY = params.get("k") || "";
const headers = { "Content-Type": "application/json", "X-Acta-Key": KEY };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

document.title = BOOT.title + " · acta";
$("gateTitle").textContent = BOOT.title;
$("bookTitle").textContent = BOOT.title;

// Raw HTML in the book is shown as text: the book is Markdown, not markup.
marked.use({ renderer: { html(token) { return esc(token.text || token.raw || ""); } } });

let stored = "";
try { stored = localStorage.getItem("acta.name") || ""; } catch {}
$("name").value = BOOT.email ? BOOT.email.split("@")[0] : stored;

// --- layout -----------------------------------------------------------------
$("toggle").addEventListener("click", () => {
  const app = $("app");
  if (matchMedia("(max-width: 760px)").matches) app.classList.toggle("open");
  else app.classList.toggle("collapsed");
});

// --- join -------------------------------------------------------------------
$("joinForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("name").value.trim();
  if (!name) return;
  $("joinBtn").disabled = true;
  $("err").textContent = "";
  try {
    // Ask for the mic before the kit does: the kit races the permission prompt.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      throw new Error("Microphone permission is needed to join (" + (e && e.name || e) + ").");
    }
    try { localStorage.setItem("acta.name", name); } catch {}
    const r = await fetch("/m/" + encodeURIComponent(BOOT.id) + "/join", { method: "POST", headers, body: JSON.stringify({ name }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ("join failed: " + r.status));
    const meeting = await RealtimeKitClient.init({ authToken: body.token, defaults: { audio: true, video: false } });
    meeting.self.on("roomJoined", () => {
      fetch("/m/" + encodeURIComponent(BOOT.id) + "/joined", { method: "POST", headers, body: JSON.stringify({ peerId: meeting.self.id }) })
        .catch((e) => console.warn("joined", e));
    });
    const el = document.createElement("rtk-meeting");
    el.setAttribute("mode", "fill");
    el.meeting = meeting;
    $("gate").remove();
    $("stage").appendChild(el);
  } catch (e) {
    $("err").textContent = (e && e.message) || String(e);
    $("joinBtn").disabled = false;
  }
});

// --- book socket --------------------------------------------------------------
const ORDER = ["summary", "decisions", "actions", "notes"];
const LABEL = { summary: "Summary", decisions: "Decisions", actions: "Actions", notes: "Notes", transcript: "Transcript" };
let transcriptOpen = false;

function renderBook(frame) {
  const s = frame.sections || {};
  let html = "";
  for (const k of ORDER) {
    const md = (s[k] || "").trim();
    if (md) html += "<h2>" + LABEL[k] + "</h2>" + marked.parse(md);
  }
  if (!html) html = '<p class="empty">The book fills in as the meeting goes.</p>';
  const t = (s.transcript || "").trim();
  if (t) html += "<details id=\\"tx\\"" + (transcriptOpen ? " open" : "") + "><summary>Transcript</summary>" + marked.parse(t) + "</details>";
  $("book").innerHTML = html;
  const tx = $("tx");
  if (tx) tx.addEventListener("toggle", () => { transcriptOpen = tx.open; });
}

function hhmm(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

function addParagraph(p) {
  const div = document.createElement("div");
  div.className = "p";
  div.innerHTML = '<span class="who">' + esc(p.speaker) + "</span>" + esc(p.text) + '<span class="when">' + hhmm(p.t0) + "</span>";
  const strip = $("strip");
  strip.appendChild(div);
  while (strip.children.length > 12) strip.firstElementChild.remove();
  strip.scrollTop = strip.scrollHeight;
}

let backoff = 1000;
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(proto + "//" + location.host + "/m/" + encodeURIComponent(BOOT.id) + "/ws?k=" + encodeURIComponent(KEY));
  let ping = null;
  ws.onopen = () => {
    backoff = 1000;
    $("conn").classList.add("on");
    ping = setInterval(() => { try { ws.send("ping"); } catch {} }, 30000);
  };
  ws.onmessage = (ev) => {
    if (ev.data === "pong") return;
    let f;
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.type === "book") renderBook(f);
    else if (f.type === "paragraph") addParagraph(f.paragraph);
    else if (f.type === "ended") $("ended").style.display = "block";
  };
  ws.onclose = () => {
    $("conn").classList.remove("on");
    if (ping) clearInterval(ping);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
connect();
</script>
</body>
</html>`;
}

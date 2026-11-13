import { Room, RoomEvent, Track } from "livekit-client";

const TOKEN_URL = import.meta.env.VITE_TOKEN_URL;
const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle("hidden", !on);

const params = new URLSearchParams(location.search);
const invite = params.get("i");
let hostKey = params.get("host");
try {
  if (hostKey) localStorage.setItem("cc_host", hostKey);
  else if (!invite) hostKey = localStorage.getItem("cc_host");
} catch { /* storage may be unavailable */ }

const isHost = !invite && !!hostKey;
const isGuest = !!invite;

let room = null;
let shareUrl = "";
let muted = false;
let wakeLock = null;
let timerId = null;
let callStart = 0;

const T = isHost
  ? {
      lead: "לחיצה אחת פותחת שיחה. שולחים את הקישור, והצד השני רק לוחץ עליו.",
      start: "שיחה חדשה",
      waiting: "ממתינה שיצטרפו",
      waitingHint: "שלחי את הקישור. השיחה תתחיל ברגע שילחצו עליו.",
      inCall: "בשיחה",
      left: "הצד השני יצא מהשיחה",
    }
  : {
      lead: "שני מזמינה אתכם לשיחה. לוחצים על הכפתור ומאשרים שימוש במיקרופון.",
      start: "כניסה לשיחה",
      waiting: "ממתינים לשני",
      waitingHint: "השיחה תתחיל ברגע ששני תצטרף. אפשר להשאיר את הדף פתוח.",
      inCall: "בשיחה עם שני",
      left: "שני יצאה מהשיחה",
    };

function init() {
  if (!isHost && !isGuest) {
    $("lead").textContent = "הקישור הזה לא שלם. בקשו משני קישור חדש.";
    return;
  }
  $("lead").textContent = T.lead;
  $("startBtn").textContent = T.start;
  show($("startBtn"));
  $("startBtn").onclick = start;
  $("endBtn").onclick = () => end(true);
  $("muteBtn").onclick = toggleMute;
  $("shareBtn").onclick = share;
}

function fail(msg) {
  $("error").textContent = msg;
  $("startBtn").disabled = false;
}

async function getToken() {
  const body = isHost ? { role: "host", hostKey } : { role: "guest", invite };
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || "token");
    e.code = data.error;
    throw e;
  }
  return data;
}

async function start() {
  $("error").textContent = "";
  $("startBtn").disabled = true;
  let data;
  try {
    data = await getToken();
  } catch (e) {
    if (e.code === "expired") return fail("הקישור הזה כבר לא בתוקף. בקשו משני קישור חדש.");
    if (e.code === "bad_invite") return fail("הקישור לא תקין. בקשו משני קישור חדש.");
    if (e.code === "forbidden") return fail("המפתח האישי לא תקין.");
    return fail("אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.");
  }

  room = new Room({
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    adaptiveStream: false,
    dynacast: false,
  });
  room
    .on(RoomEvent.TrackSubscribed, onTrack)
    .on(RoomEvent.ParticipantConnected, render)
    .on(RoomEvent.ParticipantDisconnected, onPeerLeft)
    .on(RoomEvent.ParticipantAttributesChanged, render)
    .on(RoomEvent.Disconnected, () => end(false));

  try {
    await room.connect(data.url, data.token);
    // Must run inside the tap handler chain so iOS allows sound.
    room.startAudio().catch(() => {});
    await room.localParticipant.setMicrophoneEnabled(true);
  } catch (e) {
    try { await room.disconnect(); } catch { /* ignore */ }
    room = null;
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
      return fail("צריך לאשר גישה למיקרופון כדי לדבר. אשרו ונסו שוב.");
    }
    return fail("החיבור לשיחה נכשל. נסו שוב.");
  }

  if (isHost) shareUrl = location.origin + location.pathname + "?i=" + encodeURIComponent(data.invite);

  show($("startBtn"), false);
  show($("lead"), false);
  show($("callCard"));
  show($("controls"));
  show($("shareBtn"), isHost);
  keepAwake();
  render();

  const mode = await enableVoiceFilter();
  try { await room.localParticipant.setAttributes({ filter: mode }); } catch { /* ignore */ }
  render();
}

// Krisp filter with background-voice cancellation: runs on this device, on this microphone.
async function enableVoiceFilter() {
  try {
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import("@livekit/krisp-noise-filter");
    if (!isKrispNoiseFilterSupported()) return "basic";
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!pub || !pub.track) return "basic";
    const processor = KrispNoiseFilter({ useBVC: true });
    await pub.track.setProcessor(processor);
    await processor.setEnabled(true);
    return processor.isEnabled() ? "bvc" : "basic";
  } catch (e) {
    console.warn("voice filter unavailable", e);
    return "basic";
  }
}

function onTrack(track) {
  if (track.kind !== Track.Kind.Audio) return;
  const el = track.attach();
  el.setAttribute("playsinline", "");
  $("audio").appendChild(el);
  room.startAudio().catch(() => {});
}

function peer() {
  if (!room) return null;
  return [...room.remoteParticipants.values()][0] || null;
}

function render() {
  if (!room) return;
  const p = peer();
  if (!p) {
    $("status").textContent = T.waiting;
    $("hint").textContent = T.waitingHint;
    show($("filter"), false);
    stopTimer();
    return;
  }
  $("status").textContent = T.inCall;
  startTimer();
  // Each side cleans its own microphone, so the label shows what the OTHER side's device reported.
  const f = p.attributes && p.attributes.filter;
  const pill = $("filter");
  if (isHost) {
    if (f === "bvc") {
      pill.textContent = "ניקוי מלא פעיל, כולל קולות רקע";
      pill.className = "pill ok";
      $("hint").textContent = "";
    } else if (f === "basic") {
      pill.textContent = "ניקוי בסיסי בלבד";
      pill.className = "pill mid";
      $("hint").textContent = "המכשיר של הצד השני לא תומך בניקוי המלא. רעשים קבועים ינוקו, קולות של אנשים אחרים פחות.";
    } else {
      pill.textContent = "מפעיל ניקוי רעש";
      pill.className = "pill mid";
      $("hint").textContent = "";
    }
    show(pill);
  } else {
    show(pill, false);
    $("hint").textContent = "השאירו את הדף פתוח והמסך דלוק עד סוף השיחה.";
  }
}

function onPeerLeft() {
  render();
  if (!peer()) $("hint").textContent = T.left;
}

async function toggleMute() {
  if (!room) return;
  muted = !muted;
  await room.localParticipant.setMicrophoneEnabled(!muted);
  $("muteBtn").textContent = muted ? "ביטול השתקה" : "השתקה";
}

async function share() {
  const text = "אפשר לדבר איתי כאן, פשוט לוחצים על הקישור:";
  if (navigator.share) {
    try { await navigator.share({ text, url: shareUrl }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(text + " " + shareUrl);
    $("shareBtn").textContent = "הקישור הועתק";
    setTimeout(() => ($("shareBtn").textContent = "שליחת הקישור"), 2500);
  } catch {
    prompt("העתיקי את הקישור:", shareUrl);
  }
}

async function end(byUser) {
  const r = room;
  room = null;
  stopTimer();
  if (wakeLock) { try { await wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }
  if (r) { try { await r.disconnect(); } catch { /* ignore */ } }
  $("audio").innerHTML = "";
  muted = false;
  $("muteBtn").textContent = "השתקה";
  show($("callCard"), false);
  show($("controls"), false);
  show($("shareBtn"), false);
  show($("lead"));
  $("lead").textContent = byUser ? "השיחה הסתיימה." : "השיחה נותקה.";
  $("startBtn").disabled = false;
  $("startBtn").textContent = isHost ? "שיחה חדשה" : "חזרה לשיחה";
  show($("startBtn"));
}

function startTimer() {
  if (timerId) return;
  callStart = Date.now();
  show($("timer"));
  const tick = () => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  };
  tick();
  timerId = setInterval(tick, 1000);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  show($("timer"), false);
}

async function keepAwake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch { /* ignore */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && room) keepAwake();
});

init();

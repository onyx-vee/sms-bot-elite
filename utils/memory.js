const fs = require("fs");
const path = require("path");

const SESSION_FILE = path.join(__dirname, "../.sessions.json");

// Load existing sessions from disk on startup
let sessions = {};
try {
  if (fs.existsSync(SESSION_FILE)) {
    sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    console.log(`📂 Loaded ${Object.keys(sessions).length} sessions from disk`);
  }
} catch (e) {
  console.log("⚠️ Could not load sessions file, starting fresh");
  sessions = {};
}

// Save sessions to disk (debounced — write at most every 5 seconds)
let saveTimer = null;
function persistSessions() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
    } catch (e) {
      console.log("⚠️ Could not persist sessions:", e.message);
    }
    saveTimer = null;
  }, 5000);
}

function getSession(id) {
  if (!sessions[id]) {
    sessions[id] = {
      messages: [],
      stage: "discovery",
      clientName: null,
      activeDeal: null,
      lastShownDeals: null,
      leadSaved: false,
      escalated: false,
      createdAt: new Date().toISOString()
    };
  }
  // Wrap in a Proxy so any mutation automatically queues a disk write
  return new Proxy(sessions[id], {
    set(target, key, value) {
      target[key] = value;
      persistSessions();
      return true;
    }
  });
}

module.exports = { getSession };
const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 TIME
function getTimeContext() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

// 🧠 FORMAT DEAL (FORCED CLEAN)
function formatDeal(d) {
  return [
    `${d.make} ${d.model}`,
    `$${d.monthly}/mo`,
    `${d.term} mo / ${d.miles}`,
    `${d.due} due`
  ].join("\n");
}

// 🧠 PICK BEST
function pickBest(deals) {
  return [...deals].sort((a, b) => a.monthly - b.monthly).slice(0, 2);
}

// 🧠 FIND DEAL
function findDeal(msg, deals) {
  if (!deals) return null;

  msg = msg.toLowerCase();

  return deals.find(d =>
    msg.includes(d.model.toLowerCase()) ||
    msg.includes(`${d.make} ${d.model}`.toLowerCase())
  );
}

// 🧠 BUDGET
function extractBudgetRange(msg) {
  const rangeMatch = msg.match(/(\d{3,4})\s?[-to]+\s?(\d{3,4})/);

  if (rangeMatch) {
    return {
      min: Number(rangeMatch[1]),
      max: Number(rangeMatch[2])
    };
  }

  const singleMatch = msg.match(/\d{3,4}/);

  if (singleMatch) {
    return {
      min: 0,
      max: Number(singleMatch[0])
    };
  }

  return null;
}

// 🧠 TYPE DETECTION
function detectType(msg) {
  if (/suv|crossover/.test(msg)) return "suv";
  if (/truck|pickup/.test(msg)) return "truck";
  if (/sedan|car/.test(msg)) return "sedan";
  return null;
}

// ✅ REAL SUV CLASSIFIER (FIXED)
function isSUV(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();

  const suvKeywords = [
    "cx", "rav4", "crv", "pilot", "tiguan",
    "x1", "x3", "x5", "x7",
    "glc", "gle", "rx", "nx", "qx",
    "ux", "mdx", "rdx", "highlander",
    "explorer", "escape", "blazer", "equinox"
  ];

  return suvKeywords.some(k => str.includes(k));
}

// ✅ TRUCK CLASSIFIER
function isTruck(d) {
  const str = `${d.make} ${d.model}`.toLowerCase();

  return [
    "tacoma", "tundra", "frontier",
    "silverado", "ram", "f150"
  ].some(k => str.includes(k));
}

// 🧠 MEMORY
function updateConversationMemory(session, userMsg, botMsg) {
  if (!session.history) session.history = [];

  session.history.push({ user: userMsg, bot: botMsg });

  if (session.history.length > 3) {
    session.history.shift();
  }
}

// 🧠 AI (CONTROLLED)
async function aiReply({ message, deal, context, history }) {

  const convoHistory = history?.length
    ? history.map(h => `User: ${h.user}\nAssistant: ${h.bot}`).join("\n\n")
    : "";

  const prompt = `
You are a high-end car broker texting.

Rules:
- no emojis
- no fluff
- 1–2 lines max
- NEVER say "You:" or "Assistant:"
- do NOT repeat deals
- guide conversation naturally

${convoHistory}

Context: ${context}

User: ${message}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return response.choices[0].message.content.trim();
}

router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number;
  const msg = (req.body.content || "").toLowerCase().trim();

  const session = getSession(from);

  try {

    // 🔥 RESET
    if (/start over|reset/.test(msg)) {
      Object.keys(session).forEach(k => delete session[k]);

      await sendHumanMessage(from, "let’s reset what are you thinking about?");
      return;
    }

    // 🔥 GREETING
    if (/^hi|hello|hey$/.test(msg)) {

      const ai = await aiReply({
        message: msg,
        context: `time: ${getTimeContext()}, returning: ${session.started ? "yes" : "no"}`,
        history: session.history
      });

      session.started = true;

      await sendHumanMessage(from, ai);
      updateConversationMemory(session, msg, ai);
      return;
    }

    // 🧠 BUDGET
    const range = extractBudgetRange(msg);
    if (range) {
      session.minBudget = range.min;
      session.maxBudget = range.max;
    }

    // 🧠 TYPE
    const type = detectType(msg);
    if (type) session.type = type;

    // 🧠 DEALS
    const deals = await getDeals(session);
    session.lastDeals = deals;

    let filtered = deals;

    if (session.maxBudget) {
      filtered = filtered.filter(d =>
        d.monthly <= session.maxBudget
      );
    }

    // ✅ TYPE FILTER FIXED
    if (session.type === "suv") {
      filtered = filtered.filter(isSUV);
    }

    if (session.type === "truck") {
      filtered = filtered.filter(isTruck);
    }

    // 🧠 BMW FILTER
    if (/bmw/.test(msg)) {
      let bmwDeals = deals.filter(d =>
        d.make.toLowerCase().includes("bmw")
      );

      if (/suv/.test(msg)) {
        bmwDeals = bmwDeals.filter(isSUV);
      }

      const best = pickBest(bmwDeals);
      const list = best.map(formatDeal).join("\n\n\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 CONTINUATION
    if (/anything else|more|other/.test(msg)) {
      const more = filtered.slice(2, 5);
      const list = more.map(formatDeal).join("\n\n\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 DEAL SEARCH
    if (/deal|options|suv|truck|budget/.test(msg) || range) {

      const best = pickBest(filtered);
      const list = best.map(formatDeal).join("\n\n\n");

      const ai = await aiReply({
        message: msg,
        context: "recommend best option",
        history: session.history
      });

      const reply = list + "\n\n" + ai;

      await sendHumanMessage(from, reply);
      updateConversationMemory(session, msg, reply);
      return;
    }

    // 🧠 DEFAULT
    const ai = await aiReply({
      message: msg,
      context: "general response",
      history: session.history
    });

    await sendHumanMessage(from, ai);
    updateConversationMemory(session, msg, ai);

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

module.exports = router;
const express = require("express");
const router = express.Router();

const OpenAI = require("openai");

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 TIME CONTEXT
function getTimeContext() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

// 🧠 FORMAT DEAL (FORCES CLEAN LINES)
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

// 🧠 BUDGET RANGE
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

// 🧠 VEHICLE TYPE
function detectType(msg) {
  if (/suv|crossover/.test(msg)) return "suv";
  if (/truck|pickup/.test(msg)) return "truck";
  if (/sedan|car/.test(msg)) return "sedan";
  return null;
}

// 🧠 MEMORY
function updateConversationMemory(session, userMsg, botMsg) {
  if (!session.history) session.history = [];

  session.history.push({ user: userMsg, bot: botMsg });

  if (session.history.length > 3) {
    session.history.shift();
  }
}

// 🧠 AI RESPONSE (CONTROLLED)
async function aiReply({ message, deal, context, history }) {
  const convoHistory = history?.length
    ? history.map(h => `User: ${h.user}\nAssistant: ${h.bot}`).join("\n\n")
    : "None";

  const dealContext = deal
    ? `Deal: ${deal.make} ${deal.model} at $${deal.monthly}/mo`
    : "";

  const prompt = `
You are a high-end car broker texting a client.

IMPORTANT:
- NEVER say "You:" or "Assistant:"
- NEVER narrate
- ONLY reply as a text message

Tone:
- confident
- smooth
- short (1–2 lines max)

Conversation:
${convoHistory}

${dealContext}

Context:
${context}

Customer:
${message}

Respond naturally like a real broker.
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
  const raw = req.body.content || "";
  const msg = raw.split("\n").pop().trim().toLowerCase();

  const session = getSession(from);

  try {
    // 🔥 RESET
    if (/start over|reset/.test(msg)) {
      Object.keys(session).forEach(k => delete session[k]);

      const reply = "let’s reset — what are you thinking about?";
      await sendHumanMessage(from, reply);
      return;
    }

    // 🔥 GREETING (AI)
    if (/^hi|hello|hey$/.test(msg)) {

      const ai = await aiReply({
        message: msg,
        context: `Time: ${getTimeContext()}, returning: ${session.started ? "yes" : "no"}`,
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

    // 🧠 GET DEALS
    const deals = await getDeals(session);
    if (deals.length) session.lastDeals = deals;

    let filtered = deals;

    // budget filter
    if (session.maxBudget) {
      filtered = filtered.filter(d =>
        d.monthly >= (session.minBudget || 0) &&
        d.monthly <= session.maxBudget
      );
    }

    // 🚨 TYPE FILTER
    if (session.type === "suv") {
      filtered = filtered.filter(d =>
        /cx|rav4|crv|pilot|tiguan|x|glc|rx|qx|ux/i.test(d.model)
      );
    }

    if (session.type === "truck") {
      filtered = filtered.filter(d =>
        /tacoma|tundra|frontier|silverado|ram|f150/i.test(d.model)
      );
    }

    // 🧠 BMW HANDLER
    if (/bmw/.test(msg)) {

      let brandDeals = deals.filter(d =>
        d.make.toLowerCase().includes("bmw")
      );

      if (/suv/.test(msg)) {
        brandDeals = brandDeals.filter(d =>
          /x1|x3|x5|x7/i.test(d.model)
        );
      }

      const best = pickBest(brandDeals);
      const list = best.map(formatDeal).join("\n\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 CONTINUATION
    if (/anything else|more|other/.test(msg)) {
      const moreDeals = session.lastDeals?.slice(2, 5) || [];

      const list = moreDeals.map(formatDeal).join("\n\n");

      await sendHumanMessage(from, list);
      return;
    }

    // 🧠 INFO / SPECS
    if (/tell me more|spec|details|features/.test(msg)) {

      const deal = findDeal(msg, session.lastDeals) || session.activeDeal;

      const ai = await aiReply({
        message: msg,
        deal,
        context: "Explain vehicle and guide decision",
        history: session.history
      });

      await sendHumanMessage(from, ai);
      updateConversationMemory(session, msg, ai);
      return;
    }

    // 🧠 SELECT DEAL
    const selected = findDeal(msg, session.lastDeals);

    if (selected) {
      session.activeDeal = selected;
      session.lastCar = `${selected.make} ${selected.model}`;

      const ai = await aiReply({
        message: msg,
        deal: selected,
        context: "User focusing on this car",
        history: session.history
      });

      await sendHumanMessage(from, ai);
      updateConversationMemory(session, msg, ai);
      return;
    }

    // 🧠 DEAL SEARCH
    if (range || /deal|options|suv|truck|budget/.test(msg)) {

      const best = pickBest(filtered);
      const list = best.map(formatDeal).join("\n\n");

      const ai = await aiReply({
        message: msg,
        deal: best[0],
        context: "Recommend best option briefly",
        history: session.history
      });

      const reply = `${list}\n\n${ai}`;

      await sendHumanMessage(from, reply);
      updateConversationMemory(session, msg, reply);
      return;
    }

    // 🧠 DEFAULT
    const ai = await aiReply({
      message: msg,
      context: "User unclear",
      history: session.history
    });

    await sendHumanMessage(from, ai);
    updateConversationMemory(session, msg, ai);

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

module.exports = router;
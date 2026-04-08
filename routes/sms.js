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

// 🧠 FORMAT DEAL
function formatDeal(d) {
  return `${d.make} ${d.model}
$${d.monthly}/mo
${d.term} mo / ${d.miles}
${d.due} due`;
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

// 🧠 MEMORY (LAST 3)
function updateConversationMemory(session, userMsg, botMsg) {
  if (!session.history) session.history = [];

  session.history.push({ user: userMsg, bot: botMsg });

  if (session.history.length > 3) {
    session.history.shift();
  }
}

// 🧠 AI RESPONSE
async function aiReply({ message, deal, context, history }) {

  const convoHistory = history?.length
    ? history.map(h => `User: ${h.user}\nYou: ${h.bot}`).join("\n\n")
    : "None";

  const dealContext = deal
    ? `
Current Deal:
${deal.make} ${deal.model}
$${deal.monthly}/mo
${deal.term} months
${deal.due} due
`
    : "";

  const prompt = `
You are a high-end car broker texting a client.

Tone:
- confident
- smooth
- natural
- short (1–3 lines max)

Conversation history:
${convoHistory}

${dealContext}

Context:
${context}

Customer message:
${message}

Rules:
- no emojis
- no fluff
- don't repeat yourself
- guide toward a decision subtly
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return response.choices[0].message.content;
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

    // 🔥 AI GREETING (TIME + MEMORY)
    if (/^hi|hello|hey$/.test(msg)) {

      const ai = await aiReply({
        message: msg,
        context: `
Time: ${getTimeContext()}
Returning: ${session.started ? "yes" : "no"}
Last car: ${session.lastCar || "none"}

Greet naturally and guide the convo.
        `,
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

    // 🧠 GET DEALS
    const deals = await getDeals(session);
    if (deals.length) session.lastDeals = deals;

    // 🧠 FILTER
    let filtered = deals;

    if (session.maxBudget) {
      filtered = deals.filter(d =>
        d.monthly >= (session.minBudget || 0) &&
        d.monthly <= session.maxBudget
      );
    }

    // 🧠 INFO / SPECS (AI + SELLING)
    if (/tell me more|spec|details|features|engine|hp/.test(msg)) {

      const deal = findDeal(msg, session.lastDeals) || session.activeDeal;

      const ai = await aiReply({
        message: msg,
        deal,
        context: "User wants details on a vehicle",
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
        context: "User is focusing on this car",
        history: session.history
      });

      await sendHumanMessage(from, ai);
      updateConversationMemory(session, msg, ai);
      return;
    }

    // 🧠 DEAL SEARCH
    if (range || /under|budget|month|deal|options/.test(msg)) {

      if (!filtered.length) {
        const ai = await aiReply({
          message: msg,
          context: "No deals found in range",
          history: session.history
        });

        await sendHumanMessage(from, ai);
        updateConversationMemory(session, msg, ai);
        return;
      }

      const best = pickBest(filtered);

      const list = best.map(formatDeal).join("\n\n");

      const ai = await aiReply({
        message: msg,
        deal: best[0],
        context: `Present these deals:\n${list}`,
        history: session.history
      });

      const finalReply = `${list}\n\n${ai}`;

      await sendHumanMessage(from, finalReply);
      updateConversationMemory(session, msg, finalReply);
      return;
    }

    // 🧠 FOLLOW UPS
    if (/term|miles|due|down/.test(msg)) {

      if (!session.activeDeal) {
        const ai = await aiReply({
          message: msg,
          context: "User asked about terms without selecting car",
          history: session.history
        });

        await sendHumanMessage(from, ai);
        updateConversationMemory(session, msg, ai);
        return;
      }

      const d = session.activeDeal;

      const reply = `${d.make} ${d.model}
${d.term} months
${d.miles} miles/year
${d.due} due at signing`;

      await sendHumanMessage(from, reply);
      updateConversationMemory(session, msg, reply);
      return;
    }

    // 🧠 DEFAULT → AI (SMART FALLBACK)
    const ai = await aiReply({
      message: msg,
      context: JSON.stringify(session),
      history: session.history
    });

    await sendHumanMessage(from, ai);
    updateConversationMemory(session, msg, ai);

  } catch (err) {
    console.error("❌ ERROR:", err);
  }
});

module.exports = router;
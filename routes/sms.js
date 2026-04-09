const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { getSession } = require("../utils/memory");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
   BASIC FILTER
========================= */
function basicFilter(deals, msg) {
  msg = msg.toLowerCase();

  if (msg.includes("bmw")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("bmw"));
  }

  if (msg.includes("mercedes")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("mercedes"));
  }

  if (msg.includes("audi")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("audi"));
  }

  if (msg.includes("lexus")) {
    deals = deals.filter(d => d.make.toLowerCase().includes("lexus"));
  }

  if (msg.includes("suv")) {
    deals = deals.filter(d =>
      /x1|x3|x5|x7|gla|glb|glc|gle|rx|nx|qx|cx|rav4|crv|tiguan|highlander/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  if (msg.includes("ev") || msg.includes("electric")) {
    deals = deals.filter(d =>
      /ev|electric|ioniq|tesla|bolt|leaf/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  const nums = msg.match(/\d{3,4}/);
  if (nums) {
    const budget = parseInt(nums[0]);
    deals = deals.filter(d => d.monthly <= budget);
  }

  return deals;
}

/* =========================
   SMART SELECTION ENGINE
========================= */
function resolveSelection(msg, deals, activeDeal) {
  if (!deals || !deals.length) return null;

  const text = msg.toLowerCase();

  // number
  const numMatch = text.match(/\b\d+\b/);
  if (numMatch) {
    const index = parseInt(numMatch[0]) - 1;
    return deals[index] || null;
  }

  // position
  if (text.includes("first")) return deals[0];
  if (text.includes("second")) return deals[1];
  if (text.includes("third")) return deals[2];
  if (text.includes("last")) return deals[deals.length - 1];

  // cheapest / most expensive
  if (text.includes("cheapest") || text.includes("lowest")) {
    return [...deals].sort((a, b) => a.monthly - b.monthly)[0];
  }

  if (text.includes("expensive") || text.includes("highest")) {
    return [...deals].sort((a, b) => b.monthly - a.monthly)[0];
  }

  // "that one"
  if (text.includes("that") || text.includes("this one")) {
    return activeDeal || deals[0];
  }

  // model match
  const match = deals.find(d =>
    text.includes(d.model.toLowerCase())
  );

  if (match) return match;

  return null;
}

/* =========================
   ROUTE
========================= */
router.post("/", async (req, res) => {
  res.sendStatus(200);

  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || "").trim();

  const session = getSession(from);

  try {
    const allDeals = await getDeals();

    /* =========================
       RESET
    ========================= */
    if (msg.toLowerCase().includes("start over")) {
      session.activeDeal = null;
      session.lastShownDeals = null;

      await sendHumanMessage(from, "starting fresh — what are you looking for?");
      return;
    }

    /* =========================
       FILTER + STORE LIST
    ========================= */
    const filteredDeals = basicFilter(allDeals, msg);
    session.lastShownDeals = filteredDeals.slice(0, 12);

    /* =========================
       SMART SELECTION (CRITICAL)
    ========================= */
    const selected = resolveSelection(
      msg,
      session.lastShownDeals,
      session.activeDeal
    );

    if (selected) {
      session.activeDeal = selected;

      await sendHumanMessage(
        from,
`${selected.make} ${selected.model}

$${selected.monthly}/mo
${selected.term} mo / ${selected.miles}
$${selected.due} due

want me to adjust the numbers or lock it in?`
      );

      return;
    }

    /* =========================
       AI RESPONSE
    ========================= */
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a high-end auto broker texting clients.

RULES:

- Never say "I can't" or "I'll check"
- You ALWAYS have access to all deals
- If a car exists, use it

- If active deal exists → prioritize it
- Do NOT switch cars randomly

- Recommend 1-2 options max
- Keep responses clean and short

- Do NOT reset conversation

NEGOTIATION:

36 mo → $28 per $1000  
39 mo → $26 per $1000  

ACTIVE DEAL:
${JSON.stringify(session.activeDeal || null)}

DEALS:
${JSON.stringify(filteredDeals.slice(0, 12), null, 2)}
`
        },
        {
          role: "user",
          content: msg
        }
      ]
    });

    const reply = ai.choices[0].message.content;

    await sendHumanMessage(from, reply);

  } catch (err) {
    console.log("SMS ERROR:", err);
  }
});

module.exports = router;
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
   DETECT DEAL FROM MESSAGE
========================= */
function detectDealFromMessage(msg, deals) {
  msg = msg.toLowerCase();

  return deals.find(d => {
    const full = `${d.make} ${d.model}`.toLowerCase();
    return msg.includes(d.model.toLowerCase()) || msg.includes(full);
  });
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

      await sendHumanMessage(from, "starting fresh — what are you looking for?");
      return;
    }

    /* =========================
       UPDATE ACTIVE DEAL
    ========================= */
    const detected = detectDealFromMessage(msg, allDeals);
    if (detected) {
      session.activeDeal = detected;
    }

    /* =========================
       FILTERED (for suggestions)
    ========================= */
    const filteredDeals = basicFilter(allDeals, msg);

    /* =========================
       ALWAYS PASS FULL DATASET
    ========================= */
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a high-end auto broker texting clients.

------------------------
CRITICAL RULES
------------------------

- You ALWAYS have access to ALL deals
- NEVER say:
  "I can't send"
  "I don't have"
  "I'll check"

- If a car exists in ALL DEALS → you HAVE it

- FILTERED DEALS = suggestions
- ALL DEALS = full inventory

------------------------
CONVERSATION
------------------------

- Never reset conversation unless user says start over
- If active deal exists → prioritize it
- If user asks about a specific car → answer using ALL DEALS

------------------------
ACTIVE DEAL
------------------------
${JSON.stringify(session.activeDeal || null)}

------------------------
FILTERED DEALS (suggestions)
------------------------
${JSON.stringify(filteredDeals.slice(0, 10), null, 2)}

------------------------
ALL DEALS (full inventory)
------------------------
${JSON.stringify(allDeals.slice(0, 50), null, 2)}

------------------------
GOAL
------------------------

Give accurate answers.
Stay consistent.
Never contradict available data.
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
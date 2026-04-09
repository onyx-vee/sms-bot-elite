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

  return deals.slice(0, 12);
}

/* =========================
   FIND DEAL FROM USER TEXT
========================= */
function detectDealFromMessage(msg, deals) {
  msg = msg.toLowerCase();

  return deals.find(d => {
    const full = `${d.make} ${d.model}`.toLowerCase();
    return (
      msg.includes(d.model.toLowerCase()) ||
      msg.includes(full)
    );
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
    const filteredDeals = basicFilter(allDeals, msg);

    /* =========================
       UPDATE ACTIVE DEAL (FROM USER)
    ========================= */
    const detected = detectDealFromMessage(msg, allDeals);
    if (detected) {
      session.activeDeal = detected;
    }

    /* =========================
       FALLBACK IF NO DEALS
    ========================= */
    if (!filteredDeals.length) {
      await sendHumanMessage(
        from,
        "nothing clean in that exact setup — i can source something better for you. what direction are you thinking?"
      );
      return;
    }

    /* =========================
       AI
    ========================= */
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a high-end auto broker texting clients.

You are NOT a chatbot. You are a real closer.

------------------------
CORE RULES
------------------------

1. NEVER reset conversation

2. ACTIVE DEAL IS PRIORITY
- If active deal exists → ALWAYS refer to it
- If user asks about pricing, down payment, etc → use that deal

3. NEVER INVENT DATA
- Only use provided deals
- If not found → say you'll source it

4. ANSWER DIRECTLY
- If asked price with 0 down → calculate immediately

5. DO NOT IGNORE CONTEXT
- If user says "that one", "the x7", etc → refer to active deal

6. DO NOT SPAM LISTS
- Recommend 1–2 deals max
- If asked for all → summarize, not dump everything

7. CLOSING
- If user says "lock it in":
→ "perfect — fill this out and I’ll lock it in"
→ https://onyxautocollection.com/1745-2/

8. TONE
- Short
- Confident
- Natural
- No corporate talk

------------------------
NEGOTIATION LOGIC
------------------------

13 mo → $77 per $1000  
18 mo → $56  
24 mo → $42  
36 mo → $28  
39 mo → $26  
48 mo → $21  

------------------------
ACTIVE DEAL
------------------------
${JSON.stringify(session.activeDeal || null)}

------------------------
AVAILABLE DEALS
------------------------
${JSON.stringify(filteredDeals, null, 2)}

------------------------
GOAL
------------------------

Guide the deal forward naturally.
Never lose context.
Close when ready.
`
        },
        {
          role: "user",
          content: msg
        }
      ]
    });

    const reply = ai.choices[0].message.content;

    /* =========================
       SAVE DEAL (AI RESPONSE FALLBACK)
    ========================= */
    const match = filteredDeals.find(d =>
      reply.toLowerCase().includes(d.model.toLowerCase())
    );

    if (match) {
      session.activeDeal = match;
    }

    await sendHumanMessage(from, reply);

  } catch (err) {
    console.log("SMS ERROR:", err);
  }
});

module.exports = router;
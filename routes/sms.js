const express = require("express");
const router = express.Router();

const { sendHumanMessage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { saveLead } = require("../services/sheets");
const { getSession } = require("../utils/memory");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { APP_LINK, OWNER_PHONE } = require("../config/constants");

/* =========================
   SYSTEM PROMPT BUILDER
   Called fresh each request so the AI always sees current deals + session state
========================= */
function buildSystemPrompt(session, deals) {
  const activeDeal = session.activeDeal
    ? `${session.activeDeal.make} ${session.activeDeal.model} @ $${session.activeDeal.monthly}/mo`
    : "None set yet";

  const dealList = deals.length
    ? deals
        .map(
          (d, i) =>
            `${i + 1}. ${d.year || ""} ${d.make} ${d.model} — $${d.monthly}/mo | $${d.due} due | ${d.term}mo / ${d.miles}`
        )
        .join("\n")
    : "No deals match the current filters.";

  return `You are an elite auto broker texting real clients for Onyx Auto Collection, a luxury pre-owned and lease dealership in Los Angeles.

Your name is never mentioned — you're just "the team." You text like a real human: concise, confident, no fluff.

## YOUR PERSONALITY
- Direct, warm, and knowledgeable — like a trusted friend in the car business
- You never say "I can't," "let me check," or "I'm an AI"
- You never use emojis unless the client does first
- You never send walls of text — keep replies under 4 lines unless listing cars
- You match the client's energy: if they're casual, be casual; if they're serious, be sharp

## YOUR GOALS (IN ORDER)
1. Understand what the client wants (make, model, budget, timeline)
2. Match them to the best deal from the inventory list below
3. Lock in ONE specific car — get them excited about it
4. Push toward next step: appointment, application, or deposit

## CONVERSATION RULES
- Only recommend 1–2 cars at a time — never dump the whole list
- Once a car is selected (active deal), stay focused on it unless they ask to switch
- If they ask about a car not in inventory, say you can source it and ask for their timeline
- If they mention a budget, stick to it — don't show anything over their number
- If they say "yes," "let's do it," or similar → send them the app link: ${APP_LINK}
- If they're ready to move → collect: full name, email, zip code

## NEGOTIATION KNOWLEDGE
- 36 month lease: ~$28 per $1,000 cap cost reduction
- 39 month lease: ~$26 per $1,000 cap cost reduction
- You can adjust due-at-signing in exchange for higher monthly — always frame it as a benefit to them
- Money factor, residual, and incentives vary — don't promise exact numbers without checking

## LEAD SAVE TRIGGER
When you've collected name + phone (already have it) + vehicle interest, include this exact tag at the END of your response on its own line:
[SAVE_LEAD]

## ESCALATION TRIGGER  
If the client is angry, asks for a manager, or the conversation stalls after 3+ exchanges with no progress, include this tag:
[ESCALATE]

## CURRENT SESSION STATE
Active deal: ${activeDeal}
Stage: ${session.stage || "discovery"}
Client name: ${session.clientName || "unknown"}

## LIVE INVENTORY (filtered to their search)
${dealList}

Respond ONLY with your text message reply. No labels, no quotes, no extra formatting.`;
}

/* =========================
   BASIC FILTER
   Only runs when there's an actual search intent — not on follow-up messages
========================= */
function basicFilter(deals, msg) {
  msg = msg.toLowerCase();
  let filtered = [...deals];

  const makes = ["bmw", "mercedes", "audi", "lexus", "toyota", "honda", "porsche", "cadillac"];
  for (const make of makes) {
    if (msg.includes(make)) {
      filtered = filtered.filter(d => d.make.toLowerCase().includes(make));
    }
  }

  if (msg.includes("suv") || msg.includes("crossover")) {
    filtered = filtered.filter(d =>
      /x1|x3|x5|x7|gla|glb|glc|gle|gls|rx|nx|ux|qx|cx|rav4|cr-v|tiguan|highlander|macan|cayenne|escalade/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  if (msg.includes("sedan")) {
    filtered = filtered.filter(d =>
      /3 series|5 series|c-class|e-class|a4|a6|es|is|camry|accord|panamera|ct5/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  if (msg.includes("ev") || msg.includes("electric")) {
    filtered = filtered.filter(d =>
      /ev|electric|ioniq|tesla|bolt|leaf|i4|i5|eq|e-tron/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  // budget filter — numbers 3-4 digits are treated as monthly budget
  const budgetMatch = msg.match(/\$?(\d{3,4})\s*(\/mo|a month|per month|monthly)?/);
  if (budgetMatch) {
    const budget = parseInt(budgetMatch[1]);
    filtered = filtered.filter(d => d.monthly <= budget);
  }

  // if filters eliminated everything, return full list (better than no results)
  return filtered.length > 0 ? filtered : deals;
}

/* =========================
   SMART SELECTION ENGINE
   Detects when client is pointing at a specific car
========================= */
function resolveSelection(msg, deals) {
  if (!deals || !deals.length) return null;

  const text = msg.toLowerCase();

  // number reference — "the first one," "#2," "option 3"
  const numMatch = text.match(/\b(#\s*)?(\d+)(st|nd|rd|th)?\b/);
  if (numMatch) {
    const index = parseInt(numMatch[2]) - 1;
    if (index >= 0 && index < deals.length) return deals[index];
  }

  // ordinal words
  const ordinals = ["first", "second", "third", "fourth", "fifth"];
  for (let i = 0; i < ordinals.length; i++) {
    if (text.includes(ordinals[i]) && deals[i]) return deals[i];
  }

  if (text.includes("last")) return deals[deals.length - 1];
  if (text.includes("cheapest") || text.includes("lowest") || text.includes("most affordable")) {
    return [...deals].sort((a, b) => a.monthly - b.monthly)[0];
  }
  if (text.includes("nicest") || text.includes("best") || text.includes("top")) {
    return [...deals].sort((a, b) => b.monthly - a.monthly)[0];
  }

  // model name match
  const modelMatch = deals.find(d =>
    text.includes(d.model.toLowerCase()) ||
    (d.make && text.includes(d.make.toLowerCase()) && text.includes(d.model.toLowerCase()))
  );
  if (modelMatch) return modelMatch;

  return null;
}

/* =========================
   DETECT SEARCH INTENT
   Prevents re-filtering on follow-up messages like "tell me more"
========================= */
function hasSearchIntent(msg) {
  return /under|budget|payment|looking for|want|need|show me|what do you have|options|available|lease|buy|finance|suv|sedan|ev|electric|\$\d{3}/i.test(msg);
}

/* =========================
   DETECT CLIENT NAME
========================= */
function extractName(msg) {
  // "I'm [Name]" or "my name is [Name]" or "this is [Name]"
  const m = msg.match(/(?:i'm|i am|my name is|this is|it's|its)\s+([A-Z][a-z]+)/i);
  return m ? m[1] : null;
}

/* =========================
   MAIN ROUTE
========================= */
router.post("/", async (req, res) => {
  // Respond to Sendblue immediately — they retry if no fast 200
  res.sendStatus(200);

  // Sendblue webhook fields
  const from = req.body.number || req.body.from;
  const msg = (req.body.content || req.body.text || req.body.message || "").trim();

  if (!from || !msg) return;

  const session = getSession(from);

  // Initialize message history if new session
  if (!session.messages) session.messages = [];
  if (!session.stage) session.stage = "discovery";

  try {
    const allDeals = await getDeals();

    /* ─── RESET ─────────────────────────────────────── */
    if (/start over|reset|restart|new search/i.test(msg)) {
      const phone = from;
      Object.keys(session).forEach(k => delete session[k]);
      session.messages = [];
      session.stage = "discovery";
      await sendHumanMessage(phone, "Fresh start — what are you looking for?");
      return;
    }

    /* ─── EXTRACT NAME if mentioned ─────────────────── */
    const detectedName = extractName(msg);
    if (detectedName && !session.clientName) {
      session.clientName = detectedName;
    }

    /* ─── FILTER DEALS (only on search intent) ──────── */
    if (hasSearchIntent(msg) || !session.lastShownDeals) {
      const filtered = basicFilter(allDeals, msg);
      session.lastShownDeals = filtered.slice(0, 12);
    }

    const currentDeals = session.lastShownDeals || allDeals.slice(0, 12);

    /* ─── SMART SELECTION ───────────────────────────── */
    const selected = resolveSelection(msg, currentDeals);
    if (selected) {
      session.activeDeal = selected;
      session.stage = "presenting";
    }

    /* ─── BUILD CONVERSATION HISTORY FOR GPT ────────── */
    // Add the client's latest message to history
    session.messages.push({ role: "user", content: msg });

    // Keep last 20 messages to stay within token limits (10 exchanges)
    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    /* ─── CALL GPT-4o-mini ──────────────────────────── */
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(session, currentDeals)
        },
        ...session.messages
      ],
      temperature: 0.7,
      max_tokens: 300
    });

    let reply = aiResponse.choices[0].message.content.trim();

    /* ─── HANDLE SPECIAL TAGS ───────────────────────── */
    const shouldSaveLead = reply.includes("[SAVE_LEAD]");
    const shouldEscalate = reply.includes("[ESCALATE]");

    // Strip tags from reply before sending
    reply = reply.replace(/\[SAVE_LEAD\]/g, "").replace(/\[ESCALATE\]/g, "").trim();

    /* ─── SAVE LEAD TO GOOGLE SHEETS ────────────────── */
    if (shouldSaveLead && !session.leadSaved) {
      try {
        await saveLead(
          {
            requestedCar: session.activeDeal
              ? `${session.activeDeal.make} ${session.activeDeal.model}`
              : session.lastShownDeals?.[0]
              ? `${session.lastShownDeals[0].make} ${session.lastShownDeals[0].model}`
              : "Unknown",
            trim: session.trim || "",
            color: session.color || "",
            budget: session.budget || ""
          },
          from
        );
        session.leadSaved = true;
        console.log(`✅ Lead saved for ${from}`);
      } catch (e) {
        console.log("⚠️ Lead save failed:", e.message);
      }
    }

    /* ─── ESCALATE TO HUMAN ─────────────────────────── */
    if (shouldEscalate && !session.escalated) {
      session.escalated = true;
      try {
        await sendHumanMessage(
          `+1${OWNER_PHONE}`,
          `🚨 Escalation needed\nClient: ${from}\nLast message: "${msg}"\nActive deal: ${
            session.activeDeal
              ? `${session.activeDeal.make} ${session.activeDeal.model}`
              : "none"
          }`
        );
      } catch (e) {
        console.log("⚠️ Escalation notify failed:", e.message);
      }
    }

    /* ─── UPDATE STAGE BASED ON CONTENT ─────────────── */
    if (/yes|let's do it|i'm in|ready|sounds good|lock it/i.test(msg)) {
      session.stage = "closing";
    }

    /* ─── SEND REPLY & STORE IN HISTORY ─────────────── */
    await sendHumanMessage(from, reply);
    session.messages.push({ role: "assistant", content: reply });

  } catch (err) {
    console.error("❌ SMS ERROR:", err.message || err);
  }
});

module.exports = router;
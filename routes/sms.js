const express = require("express");
const router = express.Router();

const { sendHumanMessage, forwardImage } = require("../services/messaging");
const { getDeals } = require("../services/deals");
const { saveLead } = require("../services/pipedrive");
const { getSession } = require("../utils/memory");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { APP_LINK, OWNER_PHONE } = require("../config/constants");

/* =========================
   PAYMENT CALCULATOR
   Adjusts monthly based on how much more/less the client puts down vs the listed due amount.
   Formula: new_monthly = base_monthly - (extra_down / term)
   Positive extra_down  → lower monthly
   Negative extra_down  → higher monthly (less down)
========================= */
function calculatePayment(deal, targetDown) {
  if (!deal || !deal.monthly || !deal.term) return null;

  const baseDue     = parseFloat(String(deal.due).replace(/[^0-9.]/g, "")) || 0;
  const baseMonthly = parseFloat(String(deal.monthly).replace(/[^0-9.]/g, "")) || 0;
  const term        = parseInt(deal.term) || 36;

  const extraDown   = targetDown - baseDue;           // positive = more down, negative = less down
  const adjustment  = extraDown / term;               // per-month impact
  const newMonthly  = Math.max(0, baseMonthly - adjustment); // can't go negative

  return {
    newMonthly:  Math.round(newMonthly),
    newDue:      Math.round(targetDown),
    adjustment:  Math.round(Math.abs(adjustment)),
    direction:   adjustment >= 0 ? "decrease" : "increase"
  };
}

/* =========================
   DETECT PAYMENT QUERY
   Catches "what's the payment on the X5?" or "how much is the BMW?"
   Returns the deal being asked about, or null if not a payment question
========================= */
function detectPaymentQuery(msg, deals, activeDeal) {
  const text = msg.toLowerCase();

  // Must look like a payment question
  const isPaymentQuestion = /payment|how much|what.*cost|monthly|per month|lease.*on|price.*on|how much.*on|what.*on/i.test(text);
  if (!isPaymentQuestion) return null;

  // Try to find a specific deal mentioned in the message
  if (deals && deals.length) {
    const mentioned = deals.find(d =>
      d.model && text.includes(d.model.toLowerCase())
    );
    if (mentioned) return mentioned;

    const mentionedMake = deals.find(d =>
      d.make && text.includes(d.make.toLowerCase())
    );
    if (mentionedMake) return mentionedMake;
  }

  // Fall back to active deal if no specific car mentioned
  if (activeDeal) return activeDeal;

  return null;
}

/* =========================
   DETECT PAYMENT ADJUSTMENT REQUEST
   Returns target down payment if client is asking to adjust, otherwise null
========================= */
function detectPaymentAdjustment(msg, deal) {
  if (!deal) return null;

  const text = msg.toLowerCase();

  // "bring it down to $348" / "can you do $400 a month" / "I want $500/mo"
  const targetMonthlyMatch = msg.match(/\$?(\d{3,4})\s*(\/mo|\/month|a month|per month|monthly)/i);
  if (targetMonthlyMatch) {
    const targetMonthly = parseInt(targetMonthlyMatch[1]);
    const baseMonthly   = parseFloat(String(deal.monthly).replace(/[^0-9.]/g, "")) || 0;
    const baseDue       = parseFloat(String(deal.due).replace(/[^0-9.]/g, "")) || 0;
    const term          = parseInt(deal.term) || 36;

    // Work backwards: how much extra down to hit that monthly?
    const monthlyDiff = baseMonthly - targetMonthly;  // how much we need to drop
    const extraDown   = monthlyDiff * term;
    const targetDown  = Math.max(0, baseDue + extraDown);

    return { type: "target_monthly", targetMonthly, targetDown: Math.round(targetDown) };
  }

  // "put $5000 down" / "I can do $3000 down" / "if I put 2000 down"
  const targetDownMatch = msg.match(/\$?(\d{1,5})\s*(down|upfront|at signing|due)/i);
  if (targetDownMatch) {
    const targetDown = parseInt(targetDownMatch[1]);
    return { type: "target_down", targetDown };
  }

  // "lower the payment" / "can you come down" / "adjust the monthly"
  const isVagueAdjust = /lower|reduce|come down|adjust|bring.*down|less.*month|cheaper/i.test(text);
  if (isVagueAdjust) {
    return { type: "vague" };
  }

  return null;
}

/* =========================
   LANGUAGE DETECTION
   Armenian Unicode block: U+0530–U+058F
   Russian/Cyrillic Unicode block: U+0400–U+04FF
========================= */
function detectLanguage(msg, session) {
  const hasArmenian = /[԰-֏ﬓ-ﬗ]/.test(msg);
  const hasRussian  = /[Ѐ-ӿ]/.test(msg);
  const hasFarsi    = /[کگی۰-۹چژ]/.test(msg);
  const hasArabic   = /[؀-ۿ]/.test(msg);

  if (hasArmenian)         session.language = "armenian";
  else if (hasRussian)     session.language = "russian";
  else if (hasFarsi)       session.language = "farsi";
  else if (hasArabic)      session.language = "arabic";
  else if (!session.language) session.language = "english";

  return session.language;
}

/* =========================
   SYSTEM PROMPT BUILDER
   Called fresh each request so the AI always sees current deals + session state
========================= */
function buildSystemPrompt(session, deals, paymentScenario = null, language = "english") {
  const activeDeal = session.activeDeal
    ? `${session.activeDeal.make} ${session.activeDeal.model} @ $${session.activeDeal.monthly}/mo`
    : "None set yet";

  const dealList = deals.length
    ? deals
        .map((d, i) => {
          const monthly = d.monthly ? `$${d.monthly}/mo` : "pricing on request";
          const due     = d.due     ? `$${d.due} due`    : "";
          const term    = d.term    ? `${d.term}mo`      : "";
          const miles   = d.miles   ? `${d.miles}`       : "";
          const details = [monthly, due, term, miles].filter(Boolean).join(" | ");
          return `${i + 1}. ${d.make} ${d.model}${details ? " — " + details : ""}`;
        })
        .join("\n")
    : "⚠️ NO INVENTORY LOADED — the sheet returned 0 rows. Do NOT invent cars. Tell the client: \"We\'re updating our inventory list — let me grab the latest options for you and get back to you shortly.\"";

  return `You are an elite auto broker texting real clients for Onyx Auto Collection, a luxury pre-owned and lease dealership in Los Angeles.

Your name is never mentioned — you're just "the team." You text like a real human: concise, confident, no fluff.

## LANGUAGE
${language === "armenian"
  ? "The client is texting in Armenian. You MUST respond entirely in Armenian for every message. All deal details (prices, terms, models) stay in their original format but all your words must be in Armenian."
  : language === "russian"
  ? "The client is texting in Russian. You MUST respond entirely in Russian for every message. All deal details (prices, terms, models) stay in their original format but all your words must be in Russian."
  : language === "farsi"
  ? "The client is texting in Farsi (Persian). You MUST respond entirely in Farsi for every message. Use right-to-left Farsi script. All deal details (prices, terms, models) stay in their original format but all your words must be in Farsi."
  : language === "arabic"
  ? "The client is texting in Arabic. You MUST respond entirely in Arabic for every message. Use right-to-left Arabic script. All deal details (prices, terms, models) stay in their original format but all your words must be in Arabic."
  : "Respond in English."}

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
- If client asks to see ALL options, a range, or says "show me everything/what do you have" → list EVERY car in the inventory below, numbered, one per line. Do not truncate.
- If client asks about a specific car → show just that one with full details
- If client is browsing without a specific request → suggest 2–3 best matches
- Once a car is selected (active deal), stay focused on it unless they ask to switch
- If they mention a budget, stick to it — don't show anything over their number
- If they say "yes," "let's do it," or similar → send them the app link: ${APP_LINK}
- If they're ready to move → collect: full name, email, zip code

## HANDLING OUT-OF-INVENTORY REQUESTS (CRITICAL)
If a client asks for a specific vehicle NOT in the inventory list:
1. Acknowledge their request directly — "Got it, let me check on a QX60 for you"
2. Tell them you'll have someone reach out shortly with availability
3. Do NOT suggest alternatives unless they explicitly ask — respect their choice
4. Do NOT pretend you can find it yourself — our team handles sourcing
5. Include [SOURCE_REQUEST] tag so the team gets notified immediately
6. Only mention alternatives AFTER confirming you're working on their request, and only if they seem open to it

NEVER repeatedly push alternatives when a client has clearly said what they want. That kills deals.

## NEGOTIATION KNOWLEDGE
- 36 month lease: ~$28 per $1,000 cap cost reduction
- 39 month lease: ~$26 per $1,000 cap cost reduction
- The key lever is due-at-signing: more down = lower monthly, less down = higher monthly
- Formula: every $1,000 more down reduces monthly by ~$1,000 ÷ term (e.g. $1,000 extra over 36mo = ~$28/mo less)
- ALWAYS use the pre-calculated numbers below when available — do not guess or approximate

## PRICING DISCLAIMER (REQUIRED)
Whenever you quote a final monthly payment, you MUST include this disclaimer on its own line:
"*Payments are plus tax, based on Tier 1 credit approval."
This is required every time — no exceptions. Keep it at the end of the message, never mid-sentence.

## CALCULATED PAYMENT SCENARIO
${paymentScenario ? `
Vehicle: ${paymentScenario.deal ? paymentScenario.deal.make + " " + paymentScenario.deal.model : "active deal"}
Client requested: ${paymentScenario.request}
RESULT → $${paymentScenario.newMonthly}/mo | $${paymentScenario.newDue} due at signing | ${paymentScenario.deal ? paymentScenario.deal.term : ""}mo / ${paymentScenario.deal ? paymentScenario.deal.miles : ""}
${paymentScenario.adjustment > 0 ? `(monthly ${paymentScenario.direction}s by $${paymentScenario.adjustment}/mo vs base)` : ""}
Quote ONLY these exact numbers. Do not use the inventory list numbers if a scenario is present.
If a target monthly is unrealistically low (requires more than $10k down), say so and offer a realistic middle ground with actual calculated numbers.
` : "No payment scenario — quote numbers directly from inventory list."}

## COLLECTING CLIENT INFO
As the conversation progresses, extract and remember:
- Their name → stored automatically when detected
- Their budget (monthly payment they mention) → tag: [BUDGET:###] for single value or [BUDGET:###-###] for a range
- Their zip code → tag: [ZIP:#####]

When you learn their budget or zip, include the tag at the end of your reply.

## LEAD SAVE TRIGGER
Once you have name + vehicle interest (and ideally budget), include this tag at the END of your response on its own line:
[SAVE_LEAD]

## ESCALATION TRIGGER  
If the client is angry, asks for a manager, or the conversation stalls after 3+ exchanges with no progress, include this tag:
[ESCALATE]

## CURRENT SESSION STATE
Active deal: ${activeDeal}
Stage: ${session.stage || "discovery"}
Client name: ${session.clientName || "unknown"}

## STAGE REFERENCE
- discovery       → learning what they want
- presenting      → showing specific options
- closing         → they're interested, push for app
- app_sent        → application link was sent, waiting for confirmation (DO NOT send link again)
- awaiting_license   → waiting for DL photo (DO NOT ask for it — already asked)
- awaiting_insurance → waiting for insurance photo (DO NOT ask for it — already asked)
- docs_complete   → all done, handoff to team

## CRITICAL RULES FOR app_sent STAGE
When stage is app_sent:
- NEVER say you are submitting, processing, or have submitted the application — you cannot do that
- NEVER say "your application is submitted" or "we're all set" — the client submits it themselves
- ONLY ask if they've completed the application yet
- If they say anything ambiguous, ask them to confirm they've hit submit on the form

## WHEN TO SET app_sent STAGE
When you send the application link (${APP_LINK}), include this tag on its own line at the end:
[APP_SENT]

## LIVE INVENTORY (filtered to their search)
Total matching: ${deals.length} vehicle${deals.length !== 1 ? "s" : ""}
The list is already filtered and sorted. If client asked to see all options, list ALL of them below — do not summarize or truncate.
CRITICAL: Only use data from this list. NEVER invent or guess years, colors, mileage, prices, or any other details not shown here. If a field is blank, do not make one up.
\${dealList}

Respond ONLY with your text message reply. No labels, no quotes, no extra formatting.`;
}

/* =========================
   BASIC FILTER
   Only runs when there's an actual search intent — not on follow-up messages
========================= */
function basicFilter(deals, msg) {
  msg = msg.toLowerCase();
  let filtered = [...deals];

  // ── Brand filter ───────────────────────────────────────────────
  const makes = [
    "bmw", "mercedes", "audi", "lexus", "toyota", "honda",
    "porsche", "cadillac", "infiniti", "acura", "volvo",
    "genesis", "lincoln", "land rover", "jaguar", "maserati"
  ];
  for (const make of makes) {
    if (msg.includes(make)) {
      filtered = filtered.filter(d => d.make.toLowerCase().includes(make));
    }
  }

  // ── Direct model name match (most important) ───────────────────
  // Check every deal to see if its model name appears in the message.
  // Also tokenizes model names so "530i" matches "BMW 530i Base" and vice versa.
  const msgTokens = msg.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

  const modelMatched = filtered.filter(d => {
    if (!d.model) return false;
    const modelLower = d.model.toLowerCase();
    // Full model string in message
    if (msg.includes(modelLower)) return true;
    // Every token of the model appears somewhere in the message
    const modelTokens = modelLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    // Match if any single meaningful token (3+ chars) from the model appears in msg tokens
    return modelTokens.some(t => t.length >= 3 && msgTokens.includes(t));
  });

  // Only short-circuit on model match if message isn't a broader search
  // e.g. "show me sedans between 500-700" should NOT match on token "sed" from a model name
  const isBroaderSearch = /sedan|suv|crossover|coupe|truck|ev|electric|between|under|options|show me|all/i.test(msg);
  if (modelMatched.length > 0 && !isBroaderSearch) {
    return modelMatched; // specific model request — return immediately
  }

  // ── Body style filter ──────────────────────────────────────────
  if (msg.includes("suv") || msg.includes("crossover")) {
    filtered = filtered.filter(d =>
      d.type ? d.type.toLowerCase() === "suv" : /suv|crossover/i.test(`${d.make} ${d.model}`)
    );
  }

  if (msg.includes("sedan")) {
    filtered = filtered.filter(d =>
      d.type ? d.type.toLowerCase() === "sedan" : !/suv|truck|van|crossover|convertible|minivan/i.test(`${d.make} ${d.model}`)
    );
  }


  if (/\bcoupe\b/i.test(msg)) {
    filtered = filtered.filter(d => d.type ? d.type.toLowerCase() === "coupe" : /coupe/i.test(`${d.make} ${d.model}`));
  }

  if (/\btruck\b|\bpickup\b/i.test(msg)) {
    filtered = filtered.filter(d => d.type ? d.type.toLowerCase() === "truck" : /truck|pickup|1500|frontier|tacoma|tundra/i.test(`${d.make} ${d.model}`));
  }

  if (/\bconvertible\b/i.test(msg)) {
    filtered = filtered.filter(d => d.type ? d.type.toLowerCase() === "convertible" : /convertible/i.test(`${d.make} ${d.model}`));
  }

  if (/\bminivan\b|\bvan\b/i.test(msg)) {
    filtered = filtered.filter(d => d.type ? d.type.toLowerCase() === "minivan" : /sienna|carnival|pacifica|odyssey|minivan/i.test(`${d.make} ${d.model}`));
  }

  if (msg.includes("ev") || msg.includes("electric")) {
    filtered = filtered.filter(d =>
      /ev|electric|ioniq|tesla|bolt|leaf|i4|i5|eq|e-tron|lyriq|rivian/i.test(
        `${d.make} ${d.model}`
      )
    );
  }

  // ── Budget filter ──────────────────────────────────────────────
  // Range: "between 500 and 700" / "500-700" / "500 to 700"
  const rangeMatch = msg.match(/\$?(\d{3,4})\s*(?:to|and|-|–)\s*\$?(\d{3,4})/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]);
    const hi = parseInt(rangeMatch[2]);
    filtered = filtered.filter(d => d.monthly >= lo && d.monthly <= hi);
  } else {
    // Single budget: "under 700" / "700/mo" / "700 a month"
    const budgetMatch = msg.match(/\$?(\d{3,4})\s*(\/mo|a month|per month|monthly)/);
    if (budgetMatch) {
      const budget = parseInt(budgetMatch[1]);
      filtered = filtered.filter(d => d.monthly <= budget);
    }
  }

  // if filters eliminated everything, return full unfiltered list
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
  const intentKeywords = /under|budget|payment|looking for|want|need|show me|what do you have|options|available|lease|buy|finance|suv|sedan|coupe|ev|electric|\$\d{3}/i;
  if (intentKeywords.test(msg)) return true;

  // Also treat it as a search if the message looks like a car name:
  // short (1-2 words), no question words, no conversational filler
  const words = msg.trim().split(/\s+/);
  const isShortAndClean = words.length <= 3 && !/\?|how|what|when|where|why|tell|more|that|this|just|okay|yes|no|thanks|done|got/.test(msg);
  if (isShortAndClean) return true;

  return false;
}

/* =========================
   DETECT CLIENT NAME
========================= */
function extractName(msg) {
  // "I'm [Name]" or "my name is [Name]" or "this is [Name]"
  const explicit = msg.match(/(?:i\'m|i am|my name is|this is|it\'s|its)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (explicit) return explicit[1];

  // Bare first+last name reply e.g. "John Smith" — two capitalized words, short message
  const bare = msg.trim().match(/^([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})$/);
  if (bare && msg.length < 40 && !msg.includes("?")) return `${bare[1]} ${bare[2]}`;

  return null;
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

  // Allow image-only messages through even if content/text is empty
  const inboundMedia = req.body.media_url || req.body.mediaUrl || null;
  if (!from || (!msg && !inboundMedia)) return;

  const session = getSession(from);

  // Initialize message history if new session
  if (!session.messages) session.messages = [];
  if (!session.stage) session.stage = "discovery";

  try {
    const allDeals = await getDeals();
    console.log(`📦 Deals loaded: ${allDeals.length} rows from sheet`);
    if (allDeals.length === 0) {
      console.error("❌ No deals loaded — sheet may be empty, wrong ID, or API key has no access");
    }

    /* ─── EASTER EGG ────────────────────────────────── */
    if (/(your\s+)?(mo+ther|mom).{0,20}wh?ore/i.test(msg)) {
      await sendHumanMessage(from, "my mother is actually a very nice lady 🙂");
      return;
    }

    /* ─── RESET ─────────────────────────────────────── */

    /* ─── FIRST MESSAGE GREETING ─────────────────────── */
    if (!session.greeted) {
      session.greeted = true;
      await sendHumanMessage(
        from,
        "Hey! Welcome to Onyx Auto Collection 👋\n\nWe speak English, Armenian (Հայերեն), Russian (Русский), Farsi (فارسی), and Arabic (العربية) — just text in your language and we'll match it.\n\nWhat are you looking for?"
      );
      // Store their first message in history then return —
      // the greeting IS the response for this turn
      session.messages.push({ role: "user", content: msg });
      return;
    }

    if (/start over|reset|restart|new search/i.test(msg)) {
      const phone = from;
      Object.keys(session).forEach(k => delete session[k]);
      session.messages = [];
      session.stage = "discovery";
      await sendHumanMessage(phone, "Fresh start — what are you looking for?");
      return;
    }

    /* ─── POST-APPLICATION: IMAGE HANDLING ──────────── */
    const inboundMediaUrl = inboundMedia; // resolved above in early-return guard

    if (inboundMediaUrl) {
      // Accept images based on what's still missing, not just exact stage
      // Sendblue can send image webhooks with empty text — don't block on stage
      const needsLicense   = !session.licenseReceived;
      const needsInsurance = session.licenseReceived && !session.insuranceReceived;

      if (needsLicense) {
        session.licenseReceived = true;
        session.licenseUrl = inboundMediaUrl;
        console.log(`📎 DL received from ${from}: ${inboundMediaUrl}`);

        const dealLabel = session.activeDeal
          ? `${session.activeDeal.make} ${session.activeDeal.model}`
          : "unknown deal";

        await forwardImage(
          `+1${OWNER_PHONE}`,
          inboundMediaUrl,
          `🪪 Driver's license from ${from} (${session.clientName || "unknown"}) — ${dealLabel}`
        );

        session.stage = "awaiting_insurance";
        await sendHumanMessage(
          from,
          "Got it, thank you! Last thing — go ahead and send a photo of your current auto insurance card."
        );
        return;
      }

      if (needsInsurance) {
        session.insuranceReceived = true;
        session.insuranceUrl = inboundMediaUrl;
        console.log(`📎 Insurance received from ${from}: ${inboundMediaUrl}`);

        const dealLabel = session.activeDeal
          ? `${session.activeDeal.make} ${session.activeDeal.model}`
          : "unknown deal";

        await forwardImage(
          `+1${OWNER_PHONE}`,
          inboundMediaUrl,
          `🛡️ Insurance card from ${from} (${session.clientName || "unknown"}) — ${dealLabel}`
        );

        await sendHumanMessage(
          `+1${OWNER_PHONE}`,
          `✅ All docs in from ${from} (${session.clientName || "unknown"}).\nDeal: ${dealLabel}\nDL: ${session.licenseUrl}\nInsurance: ${inboundMediaUrl}`
        );

        session.stage = "docs_complete";
        await sendHumanMessage(
          from,
          "Perfect, that's everything we need. Our team will review your application and reach out shortly — usually within a few hours. We're excited to get you into that car!"
        );
        return;
      }

      // Image arrived outside of expected doc flow — log and continue
      console.log(`📎 Unexpected image from ${from}: ${inboundMediaUrl}`);
    }

    /* ─── POST-APPLICATION: CONFIRMATION CHECK ───────── */
    if (session.stage === "app_sent") {
      // Strip punctuation and check loosely — catches "done*", "done!", "doneee", typos
      const cleaned = msg.trim().toLowerCase().replace(/[^a-z\s]/g, "").trim();
      const confirmed = /^(done|submitted|filled|complete|finished|sent|yes|yeah|yep|yup|did it|i did|i submitted|just submitted|just filled|i filled it|all done|just done|its done|it's done)$/.test(cleaned)
        || /^done/.test(cleaned)   // starts with "done"
        || /^yes/.test(cleaned)    // starts with "yes"
        || /submitted/.test(cleaned);

      if (confirmed) {
        session.stage = "awaiting_license";
        await sendHumanMessage(
          from,
          "Amazing! To keep things moving, go ahead and send a photo of your driver's license."
        );
        return;
      }

      // Anything else — changed mind, questions, negotiating, venting — goes to AI
      // Drop back to closing so the AI has full context and can respond naturally
      session.stage = "closing";
      // fall through to AI below
    }

    /* ─── EXTRACT NAME if mentioned ─────────────────── */
    const detectedName = extractName(msg);
    if (detectedName && !session.clientName) {
      session.clientName = detectedName;
    }

    /* ─── DETECT LANGUAGE ───────────────────────────── */
    const language = detectLanguage(msg, session);

    /* ─── FILTER DEALS (only on search intent) ──────── */
    if (hasSearchIntent(msg) || !session.lastShownDeals) {
      let filtered = basicFilter(allDeals, msg);

      // Sort by price if client asked for cheapest/most expensive
      const msgLower = msg.toLowerCase();
      if (/cheapest|lowest|most affordable|least expensive|budget|best deal|best price/i.test(msgLower)) {
        filtered = filtered.sort((a, b) => a.monthly - b.monthly);
      } else if (/most expensive|highest|nicest|best|top of the line|luxury/i.test(msgLower)) {
        filtered = filtered.sort((a, b) => b.monthly - a.monthly);
      }

      session.lastShownDeals = filtered.slice(0, 12);
    }

    // Always filter on first message too — don't fall back to raw unfiltered slice
    if (!session.lastShownDeals) {
      session.lastShownDeals = basicFilter(allDeals, msg).slice(0, 12);
    }
    const currentDeals = session.lastShownDeals;

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

    /* ─── PAYMENT QUERY + ADJUSTMENT DETECTION ─────── */
    let paymentScenario = null;

    // Step 1 — figure out which deal we're calculating for
    // Could be a simple "what's the payment?" or an adjustment request
    const queriedDeal = detectPaymentQuery(msg, currentDeals, session.activeDeal);
    const dealForCalc = queriedDeal || session.activeDeal;

    // Step 2 — check if they also want to adjust the numbers
    const adjustment = detectPaymentAdjustment(msg, dealForCalc);

    if (dealForCalc) {
      const baseDue     = parseFloat(String(dealForCalc.due).replace(/[^0-9.]/g, "")) || 0;
      const baseMonthly = parseFloat(String(dealForCalc.monthly).replace(/[^0-9.]/g, "")) || 0;
      const term        = parseInt(dealForCalc.term) || 36;

      if (adjustment) {
        // Client wants to adjust — calculate the new numbers
        if (adjustment.type === "target_monthly") {
          const calc = calculatePayment(dealForCalc, adjustment.targetDown);
          if (calc) {
            paymentScenario = {
              deal:    dealForCalc,
              request: `$${adjustment.targetMonthly}/mo target`,
              ...calc
            };
          }
        } else if (adjustment.type === "target_down") {
          const calc = calculatePayment(dealForCalc, adjustment.targetDown);
          if (calc) {
            paymentScenario = {
              deal:    dealForCalc,
              request: `$${adjustment.targetDown} down`,
              ...calc
            };
          }
        } else if (adjustment.type === "vague") {
          // Show what $1,000 extra down does as a concrete example
          const calc = calculatePayment(dealForCalc, baseDue + 1000);
          if (calc) {
            paymentScenario = {
              deal:    dealForCalc,
              request: "lower monthly (example: $1,000 more down)",
              ...calc
            };
          }
        }
      } else if (queriedDeal) {
        // Simple payment question — return base numbers from the sheet
        paymentScenario = {
          deal:       dealForCalc,
          request:    "payment quote",
          newMonthly: Math.round(baseMonthly),
          newDue:     Math.round(baseDue),
          adjustment: 0,
          direction:  "none"
        };
        // Lock this as the active deal since they asked about it specifically
        if (!session.activeDeal || session.activeDeal.model !== dealForCalc.model) {
          session.activeDeal = dealForCalc;
          session.stage = "presenting";
        }
      }
    }

    /* ─── CALL GPT-4o-mini ──────────────────────────── */
    const pricedDeals = currentDeals.filter(d => d.monthly);
    console.log("🤖 Sending to GPT. Priced:", pricedDeals.length, "of", currentDeals.length);
    console.log("🤖 Inventory passed:\n" + pricedDeals.map((d,i) => `${i+1}. ${d.make} ${d.model} $${d.monthly}/mo`).join("\n"));
    const systemPrompt = buildSystemPrompt(session, pricedDeals.length ? pricedDeals : currentDeals, paymentScenario, language);
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...session.messages
      ],
      temperature: 0.7,
      max_tokens: 300
    });

    let reply = aiResponse.choices[0].message.content.trim();

    /* ─── HANDLE SPECIAL TAGS ───────────────────────── */
    const shouldSaveLead    = reply.includes("[SAVE_LEAD]");
    const shouldEscalate    = reply.includes("[ESCALATE]");
    const shouldSetAppSent  = reply.includes("[APP_SENT]");
    const shouldSourceVehicle = reply.includes("[SOURCE_REQUEST]");

    // Extract budget tag — handles single [BUDGET:650] or range [BUDGET:500-700]
    const budgetMatch = reply.match(/\[BUDGET:([\d]+-?[\d]*)\]/);
    if (budgetMatch && !session.budget) {
      session.budget = budgetMatch[1].includes("-")
        ? `$${budgetMatch[1]}/mo`
        : `$${budgetMatch[1]}/mo`;
    }

    // Extract zip tag e.g. [ZIP:90210]
    const zipMatch = reply.match(/\[ZIP:(\d{5})\]/);
    if (zipMatch && !session.zip) {
      session.zip = zipMatch[1];
    }

    // Strip all tags from reply before sending
    reply = reply
      .replace(/\[SAVE_LEAD\]/g, "")
      .replace(/\[ESCALATE\]/g, "")
      .replace(/\[APP_SENT\]/g, "")
      .replace(/\[SOURCE_REQUEST\]/g, "")
      .replace(/\[BUDGET:[\d-]+\]/g, "")
      .replace(/\[ZIP:\d{5}\]/g, "")
      .trim();

    /* ─── SAVE LEAD TO PIPEDRIVE ────────────────────── */
    // Save if GPT emitted [SAVE_LEAD], OR as a fallback after 5 exchanges
    const exchangeCount = Math.floor(session.messages.length / 2);
    const autoSave = exchangeCount >= 5 && session.activeDeal && !session.leadSaved;

    if ((shouldSaveLead || autoSave) && !session.leadSaved) {
      try {
        await saveLead(session, from);
        session.leadSaved = true;
        console.log(`✅ Lead saved to Pipedrive for ${from} (trigger: ${shouldSaveLead ? "[SAVE_LEAD] tag" : "auto after 5 exchanges"})`);
      } catch (e) {
        console.log("⚠️ Lead save failed:", e.message);
      }
    }

    /* ─── SOURCE REQUEST ALERT ──────────────────────── */
    if (shouldSourceVehicle && !session.sourceAlerted) {
      session.sourceAlerted = true;
      const clientLabel = session.clientName || from;
      const budget = session.budget ? ` | Budget: ${session.budget}` : "";
      const zip    = session.zip    ? ` | Zip: ${session.zip}`       : "";
      try {
        await sendHumanMessage(
          `+1${OWNER_PHONE}`,
          `🔍 Source request\nClient: ${clientLabel} (${from})\nVehicle: ${msg}${budget}${zip}\nNeeds follow-up on availability.`
        );
      } catch (e) {
        console.log("⚠️ Source alert failed:", e.message);
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

    if (shouldSetAppSent && session.stage !== "app_sent") {
      session.stage = "app_sent";
      console.log(`📋 App link sent to ${from} — awaiting confirmation`);

      // Auto-save lead to Pipedrive the moment app link goes out
      if (!session.leadSaved) {
        try {
          await saveLead(session, from);
          session.leadSaved = true;
          console.log(`✅ Lead auto-saved to Pipedrive for ${from}`);
        } catch (e) {
          console.error(`❌ Pipedrive auto-save failed for ${from}:`, e.message);
        }
      }

      // Follow-up nudge 2 minutes after sending the link
      setTimeout(async () => {
        try {
          // Only send if they haven't already confirmed or moved forward
          const current = getSession(from);
          if (current.stage === "app_sent") {
            await sendHumanMessage(
              from,
              "Hey just checking in — were you able to get the application submitted? Let me know if you need any help with it!"
            );
          }
        } catch (e) {
          console.log("⚠️ Follow-up nudge failed:", e.message);
        }
      }, 2 * 60 * 1000); // 2 minutes
    }

    /* ─── SEND REPLY & STORE IN HISTORY ─────────────── */
    await sendHumanMessage(from, reply);
    session.messages.push({ role: "assistant", content: reply });

  } catch (err) {
    console.error("❌ SMS ERROR:", err.message || err);
  }
});

module.exports = router;
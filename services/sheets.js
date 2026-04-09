const { google } = require("googleapis");
const { PRICING_SHEET, LEADS_SHEET } = require("../config/constants");

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

async function getPricingRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: PRICING_SHEET,
    range: "Sheet1!A2:F"
  });
  return res.data.values || [];
}

/* ─── saveLead ───────────────────────────────────────────────────
   Sheet headers: Name | Phone | Vehicle | Budget | Zip | Time Stamp
   Call as: saveLead(session, phone)
   session should have: clientName, activeDeal, budget, zip
──────────────────────────────────────────────────────────────── */
async function saveLead(session, phone) {
  const name    = session.clientName || "";
  const vehicle = session.activeDeal
    ? `${session.activeDeal.year ? session.activeDeal.year + " " : ""}${session.activeDeal.make} ${session.activeDeal.model} — $${session.activeDeal.monthly}/mo`
    : "";
  const budget    = session.budget || "";
  const zip       = session.zip || "";
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });

  await sheets.spreadsheets.values.append({
    spreadsheetId: LEADS_SHEET,
    range: "Sheet1!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        name,       // A — Name
        phone,      // B — Phone
        vehicle,    // C — Vehicle
        budget,     // D — Budget
        zip,        // E — Zip
        timestamp   // F — Time Stamp
      ]]
    }
  });

  console.log(`📋 Lead saved — ${name || "unknown"} | ${phone} | ${vehicle || "no vehicle"}`);
}

module.exports = { getPricingRows, saveLead };
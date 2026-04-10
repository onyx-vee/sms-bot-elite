const { google } = require("googleapis");
const { PRICING_SHEET, LEADS_SHEET } = require("../config/constants");

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

async function getPricingRows() {
  try {
    console.log(`📊 Fetching pricing sheet: ${PRICING_SHEET}`);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: PRICING_SHEET,
      range: "Sheet1!A2:G"
    });
    const rows = res.data.values || [];
    console.log(`📊 Sheet loaded: ${rows.length} rows`);
    if (rows.length > 0) console.log("📊 First row:", JSON.stringify(rows[0]));
    return rows;
  } catch (err) {
    console.error("❌ getPricingRows failed:", err.message);
    return [];
  }
}

async function saveLead(session, phone) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: LEADS_SHEET,
    range: "Sheet1!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        phone,
        session.requestedCar || "",
        session.trim || "",
        session.color || "",
        session.budget || "",
        new Date().toISOString()
      ]]
    }
  });
}

module.exports = { getPricingRows, saveLead };
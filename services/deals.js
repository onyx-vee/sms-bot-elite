const { getPricingRows } = require("./sheets");

function cleanNumber(val) {
  if (!val) return null;
  return Number(val.toString().replace(/[^0-9.]/g, ""));
}

async function getDeals() {
  const rows = await getPricingRows();

  return rows.map(row => ({
    make:    row[0],
    model:   row[1],
    type:    row[2] || "",      // NEW — body type column (Sedan, SUV, Truck, etc.)
    monthly: cleanNumber(row[3]),
    due:     row[4],
    term:    row[5],
    miles:   row[6]
  })).filter(d => d.make && d.model);  // keep all rows, even ones without pricing
}

module.exports = { getDeals };
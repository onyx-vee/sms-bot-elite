
const { getPricingRows } = require("./sheets");

function cleanNumber(val) {
  if (!val) return null;
  return Number(val.toString().replace(/[^0-9.]/g, ""));
}

async function getDeals(filters) {
  const rows = await getPricingRows();
  let deals = [];

  for (let row of rows) {
    const make = row[0]?.toLowerCase();
    const monthly = cleanNumber(row[2]);

    if (!monthly) continue;
    if (filters.budget && monthly > filters.budget) continue;
    if (filters.brand && !make.includes(filters.brand)) continue;

    deals.push({
      make: row[0],
      model: row[1],
      monthly,
      due: row[3],
      term: row[4],
      miles: row[5]
    });
  }

  deals.sort((a, b) => a.monthly - b.monthly);
  return deals;
}

module.exports = { getDeals };

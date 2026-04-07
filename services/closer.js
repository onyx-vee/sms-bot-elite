
function buildEliteResponse(deals) {
  const top = deals.slice(0,3);
  const best = top[0];

  return `this is what actually makes sense right now

${top.map(d=>`${d.make} ${d.model} - $${d.monthly}/mo`).join("\n")}

if it were me, i’d go with the ${best.make} ${best.model}
it’s just the cleanest deal for the money right now

does that feel like the right direction or do you want something different?`;
}

module.exports = { buildEliteResponse };

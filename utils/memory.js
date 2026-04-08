const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = {};
  return sessions[id];
}

module.exports = { getSession };
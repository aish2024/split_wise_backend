/**
 * Zero-dependency Expense Sharing Backend (Splitwise-lite)
 * - No npm install required
 * - Run: node server.js
 *
 * Features (from assignment):
 * - Create groups, add shared expenses, track balances (who owes whom), settle dues
 * - Split types: equal, exact, percentage
 * - Balances are simplified (netted) per group
 */
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;

const db = {
  users: new Map(),      // id -> {id, name, createdAt}
  groups: new Map(),     // id -> {id, name, members:[userId], createdAt}
  expenses: [],          // {id, groupId, paidBy, amountCents, description, participants:[userId], sharesCentsByUser:{[id]:cents}, createdAt}
  settlements: []        // {id, groupId, fromUserId, toUserId, amountCents, note, createdAt}
};

// ---------- helpers ----------
function id(prefix) {
  // Node 18+ supports randomUUID
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function send(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, { error: "Not Found" });
}

function bad(res, message, details) {
  const payload = { error: message };
  if (details !== undefined) payload.details = details;
  send(res, 400, payload);
}

function ok(res, obj) {
  send(res, 200, obj);
}

function toCents(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  // round to 2dp then to int cents
  return Math.round(amount * 100);
}

function centsToNumber(cents) {
  return Math.round(cents) / 100;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1_000_000) { // 1MB
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function ensureUserExists(userId) {
  return db.users.has(userId);
}

function ensureGroupExists(groupId) {
  return db.groups.has(groupId);
}

function ensureMember(group, userId) {
  return group.members.includes(userId);
}

function splitEqual(totalCents, participants) {
  const n = participants.length;
  if (n <= 0) return null;
  const base = Math.floor(totalCents / n);
  let rem = totalCents - base * n;
  const shares = {};
  for (const u of participants) {
    shares[u] = base;
  }
  // distribute remaining cents
  for (let i = 0; i < participants.length && rem > 0; i++) {
    shares[participants[i]] += 1;
    rem -= 1;
  }
  return shares;
}

function splitExact(totalCents, exactItems) {
  // exactItems: [{userId, amount}]
  const shares = {};
  let sum = 0;
  for (const it of exactItems) {
    const cents = toCents(it.amount);
    if (cents === null || cents < 0) return null;
    shares[it.userId] = (shares[it.userId] || 0) + cents;
    sum += cents;
  }
  if (sum !== totalCents) return null;
  return shares;
}

function splitPercentage(totalCents, pctItems) {
  // pctItems: [{userId, percentage}]
  const shares = {};
  let pctSum = 0;
  for (const it of pctItems) {
    if (typeof it.percentage !== "number" || !Number.isFinite(it.percentage) || it.percentage < 0) return null;
    pctSum += it.percentage;
  }
  // allow tiny floating error
  if (Math.abs(pctSum - 100) > 1e-6) return null;

  // first pass: floor shares, track remainder in cents
  let assigned = 0;
  const remainders = [];
  for (const it of pctItems) {
    const raw = totalCents * (it.percentage / 100);
    const floored = Math.floor(raw);
    const frac = raw - floored;
    shares[it.userId] = (shares[it.userId] || 0) + floored;
    assigned += floored;
    remainders.push({ userId: it.userId, frac });
  }
  let rem = totalCents - assigned;
  // distribute remaining cents to biggest fractional parts
  remainders.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remainders.length && rem > 0; i++) {
    shares[remainders[i].userId] += 1;
    rem -= 1;
  }
  return shares;
}

function computeNetBalancesForGroup(groupId) {
  const group = db.groups.get(groupId);
  const net = {};
  for (const u of group.members) net[u] = 0;

  // expenses: payer +total, participants -share
  for (const e of db.expenses) {
    if (e.groupId !== groupId) continue;
    if (!(e.paidBy in net)) net[e.paidBy] = 0;
    net[e.paidBy] += e.amountCents;
    for (const [u, share] of Object.entries(e.sharesCentsByUser)) {
      if (!(u in net)) net[u] = 0;
      net[u] -= share;
    }
  }

  // settlements: from pays to -> from gains, to loses
  for (const s of db.settlements) {
    if (s.groupId !== groupId) continue;
    if (!(s.fromUserId in net)) net[s.fromUserId] = 0;
    if (!(s.toUserId in net)) net[s.toUserId] = 0;
    net[s.fromUserId] += s.amountCents;
    net[s.toUserId] -= s.amountCents;
  }

  // Clean tiny zeros
  for (const k of Object.keys(net)) {
    if (Math.abs(net[k]) === 0) net[k] = 0;
  }
  return net;
}

function simplifyOwes(net) {
  const debtors = [];
  const creditors = [];
  for (const [u, cents] of Object.entries(net)) {
    if (cents < 0) debtors.push({ userId: u, amount: -cents });
    else if (cents > 0) creditors.push({ userId: u, amount: cents });
  }
  // stable order
  debtors.sort((a, b) => a.userId.localeCompare(b.userId));
  creditors.sort((a, b) => a.userId.localeCompare(b.userId));

  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const x = Math.min(d.amount, c.amount);
    if (x > 0) {
      transfers.push({ fromUserId: d.userId, toUserId: c.userId, amount: centsToNumber(x) });
      d.amount -= x;
      c.amount -= x;
    }
    if (d.amount === 0) i++;
    if (c.amount === 0) j++;
  }
  return transfers;
}

// ---------- router ----------
function match(pathname, pattern) {
  // pattern like /users/:id
  const p1 = pathname.split("/").filter(Boolean);
  const p2 = pattern.split("/").filter(Boolean);
  if (p1.length !== p2.length) return null;
  const params = {};
  for (let i = 0; i < p2.length; i++) {
    if (p2[i].startsWith(":")) params[p2[i].slice(1)] = p1[i];
    else if (p2[i] !== p1[i]) return null;
  }
  return params;
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // health
    if (req.method === "GET" && pathname === "/health") {
      return ok(res, { status: "ok", time: nowISO(), version: "zerodeps-1.0" });
    }

    // docs (very simple)
    if (req.method === "GET" && pathname === "/") {
      return ok(res, {
        name: "Expense Sharing Backend (Zero Dependencies)",
        endpoints: {
          "POST /users": { body: { name: "Alice" } },
          "GET /users": {},
          "POST /groups": { body: { name: "Trip", members: ["usr_...","usr_..."] } },
          "GET /groups/:id": {},
          "POST /expenses": {
            body: {
              groupId: "grp_...",
              paidBy: "usr_...",
              amount: 1200.50,
              description: "Dinner",
              participants: ["usr_...","usr_..."], // optional, defaults to group members
              split: {
                type: "equal" | "exact" | "percentage",
                values: [
                  // for exact: { userId, amount }
                  // for percentage: { userId, percentage }
                ]
              }
            }
          },
          "GET /groups/:id/balances": {},
          "GET /users/:id/summary?groupId=grp_...": {},
          "POST /settlements": { body: { groupId:"grp_...", fromUserId:"usr_...", toUserId:"usr_...", amount: 100 } },
          "POST /admin/reset": {}
        }
      });
    }

    // reset
    if (req.method === "POST" && pathname === "/admin/reset") {
      db.users.clear();
      db.groups.clear();
      db.expenses.length = 0;
      db.settlements.length = 0;
      return ok(res, { ok: true });
    }

    // users
    if (req.method === "POST" && pathname === "/users") {
      const body = await parseBody(req);
      const name = String(body.name || "").trim();
      if (!name) return bad(res, "name is required");
      const user = { id: id("usr"), name, createdAt: nowISO() };
      db.users.set(user.id, user);
      return send(res, 201, user);
    }

    if (req.method === "GET" && pathname === "/users") {
      return ok(res, { users: Array.from(db.users.values()) });
    }

    // groups
    if (req.method === "POST" && pathname === "/groups") {
      const body = await parseBody(req);
      const name = String(body.name || "").trim();
      const members = Array.isArray(body.members) ? body.members.map(String) : [];
      if (!name) return bad(res, "name is required");
      if (members.length < 2) return bad(res, "members must have at least 2 userIds");
      for (const u of members) {
        if (!ensureUserExists(u)) return bad(res, "member userId not found", { userId: u });
      }
      const uniq = Array.from(new Set(members));
      const group = { id: id("grp"), name, members: uniq, createdAt: nowISO() };
      db.groups.set(group.id, group);
      return send(res, 201, group);
    }

    {
      const params = match(pathname, "/groups/:id");
      if (req.method === "GET" && params) {
        const group = db.groups.get(params.id);
        if (!group) return notFound(res);
        return ok(res, group);
      }
    }

    // add expense
    if (req.method === "POST" && pathname === "/expenses") {
      const body = await parseBody(req);
      const groupId = String(body.groupId || "");
      const paidBy = String(body.paidBy || "");
      const amountCents = toCents(body.amount);

      if (!groupId) return bad(res, "groupId is required");
      if (!ensureGroupExists(groupId)) return bad(res, "group not found", { groupId });
      const group = db.groups.get(groupId);

      if (!paidBy) return bad(res, "paidBy is required");
      if (!ensureUserExists(paidBy)) return bad(res, "paidBy user not found", { paidBy });
      if (!ensureMember(group, paidBy)) return bad(res, "paidBy must be a member of the group", { paidBy });

      if (amountCents === null || amountCents <= 0) return bad(res, "amount must be a positive number");

      const description = String(body.description || "").trim();

      const participants = Array.isArray(body.participants) && body.participants.length > 0
        ? body.participants.map(String)
        : group.members.slice();

      // validate participants: must exist & be members
      if (participants.length < 1) return bad(res, "participants must have at least 1 userId");
      for (const u of participants) {
        if (!ensureUserExists(u)) return bad(res, "participant userId not found", { userId: u });
        if (!ensureMember(group, u)) return bad(res, "participant must be a group member", { userId: u });
      }
      const uniqParticipants = Array.from(new Set(participants));

      const split = body.split || {};
      const type = String(split.type || "").toLowerCase();

      let sharesCentsByUser = null;

      if (type === "equal") {
        sharesCentsByUser = splitEqual(amountCents, uniqParticipants);
        if (!sharesCentsByUser) return bad(res, "equal split failed");
      } else if (type === "exact") {
        const values = Array.isArray(split.values) ? split.values : [];
        if (values.length < 1) return bad(res, "split.values required for exact split");
        // validate all userIds are participants
        for (const it of values) {
          const u = String(it.userId || "");
          if (!u) return bad(res, "split.values.userId required");
          if (!uniqParticipants.includes(u)) return bad(res, "exact split userId must be a participant", { userId: u });
        }
        sharesCentsByUser = splitExact(amountCents, values.map(v => ({ userId: String(v.userId), amount: v.amount })));
        if (!sharesCentsByUser) return bad(res, "exact split invalid (sum must equal total amount)");
      } else if (type === "percentage") {
        const values = Array.isArray(split.values) ? split.values : [];
        if (values.length < 1) return bad(res, "split.values required for percentage split");
        for (const it of values) {
          const u = String(it.userId || "");
          if (!u) return bad(res, "split.values.userId required");
          if (!uniqParticipants.includes(u)) return bad(res, "percentage split userId must be a participant", { userId: u });
        }
        sharesCentsByUser = splitPercentage(amountCents, values.map(v => ({ userId: String(v.userId), percentage: v.percentage })));
        if (!sharesCentsByUser) return bad(res, "percentage split invalid (percentages must sum to 100)");
      } else {
        return bad(res, "split.type must be one of: equal, exact, percentage");
      }

      const expense = {
        id: id("exp"),
        groupId,
        paidBy,
        amountCents,
        amount: centsToNumber(amountCents),
        description,
        participants: uniqParticipants,
        sharesCentsByUser,
        createdAt: nowISO()
      };
      db.expenses.push(expense);
      return send(res, 201, expense);
    }

    // group balances (simplified)
    {
      const params = match(pathname, "/groups/:id/balances");
      if (req.method === "GET" && params) {
        const groupId = params.id;
        if (!ensureGroupExists(groupId)) return notFound(res);
        const group = db.groups.get(groupId);
        const net = computeNetBalancesForGroup(groupId);
        const simplified = simplifyOwes(net);

        return ok(res, {
          groupId,
          groupName: group.name,
          net: Object.fromEntries(Object.entries(net).map(([u, c]) => [u, centsToNumber(c)])),
          simplified // [{fromUserId,toUserId,amount}]
        });
      }
    }

    // user summary within a group
    {
      const params = match(pathname, "/users/:id/summary");
      if (req.method === "GET" && params) {
        const userId = params.id;
        if (!ensureUserExists(userId)) return notFound(res);
        const groupId = String(url.searchParams.get("groupId") || "");
        if (!groupId) return bad(res, "groupId query param is required");
        if (!ensureGroupExists(groupId)) return bad(res, "group not found", { groupId });
        const group = db.groups.get(groupId);
        if (!ensureMember(group, userId)) return bad(res, "user is not a member of the group", { userId, groupId });

        const net = computeNetBalancesForGroup(groupId);
        const simplified = simplifyOwes(net);

        const owes = simplified.filter(t => t.fromUserId === userId)
          .map(t => ({ toUserId: t.toUserId, amount: t.amount }));
        const owedBy = simplified.filter(t => t.toUserId === userId)
          .map(t => ({ fromUserId: t.fromUserId, amount: t.amount }));

        const totalOwes = owes.reduce((s, x) => s + x.amount, 0);
        const totalOwedBy = owedBy.reduce((s, x) => s + x.amount, 0);

        return ok(res, {
          userId,
          userName: db.users.get(userId).name,
          groupId,
          groupName: group.name,
          owes,
          owedBy,
          totals: {
            owes: Math.round(totalOwes * 100) / 100,
            owedBy: Math.round(totalOwedBy * 100) / 100
          }
        });
      }
    }

    // settlements
    if (req.method === "POST" && pathname === "/settlements") {
      const body = await parseBody(req);
      const groupId = String(body.groupId || "");
      const fromUserId = String(body.fromUserId || "");
      const toUserId = String(body.toUserId || "");
      const amountCents = toCents(body.amount);

      if (!groupId) return bad(res, "groupId is required");
      if (!ensureGroupExists(groupId)) return bad(res, "group not found", { groupId });
      const group = db.groups.get(groupId);

      if (!fromUserId || !toUserId) return bad(res, "fromUserId and toUserId are required");
      if (!ensureUserExists(fromUserId)) return bad(res, "fromUserId user not found", { fromUserId });
      if (!ensureUserExists(toUserId)) return bad(res, "toUserId user not found", { toUserId });
      if (!ensureMember(group, fromUserId) || !ensureMember(group, toUserId)) {
        return bad(res, "both users must be members of the group");
      }
      if (fromUserId === toUserId) return bad(res, "fromUserId and toUserId cannot be the same");
      if (amountCents === null || amountCents <= 0) return bad(res, "amount must be a positive number");

      // Optional: validate they actually owe (based on current simplified balances)
      const net = computeNetBalancesForGroup(groupId);
      const simplified = simplifyOwes(net);
      const edge = simplified.find(t => t.fromUserId === fromUserId && t.toUserId === toUserId);
      if (!edge) {
        return bad(res, "no outstanding due from fromUserId to toUserId in simplified balances (or already settled)");
      }
      const maxCents = toCents(edge.amount);
      if (amountCents > maxCents) {
        return bad(res, "settlement amount exceeds outstanding due", { outstanding: edge.amount });
      }

      const settlement = {
        id: id("set"),
        groupId,
        fromUserId,
        toUserId,
        amountCents,
        amount: centsToNumber(amountCents),
        note: String(body.note || "").trim(),
        createdAt: nowISO()
      };
      db.settlements.push(settlement);
      return send(res, 201, settlement);
    }

    return notFound(res);
  } catch (e) {
    if (String(e.message).includes("Invalid JSON")) return bad(res, "Invalid JSON body");
    if (String(e.message).includes("Body too large")) return bad(res, "Body too large");
    console.error(e);
    send(res, 500, { error: "Internal Server Error" });
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Docs:   http://localhost:${PORT}/`);
});

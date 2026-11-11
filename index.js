import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
dotenv.config();

let admins = process.env.ADMINS || "U08EMT46G3V";
admins = admins.split(";");

let banned = [];

const app = express();
app.set("trust proxy", "loopback");
app.use(express.json());
app.use(cors({
    origin: [
        "https://symmetrical-doodle-69qgr7v97j76f59j7-5173.app.github.dev",
        "https://jumbotron.hackclub.com",
        ...(process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(";") : [])
    ],
    methods: [
        "POST", "GET"
    ],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

let clientID = "e86d4d7eec9c546e6c4700388d4fea7f";

// tokens[code] = { name, slack, password, cityName?, bridge?, sources? }
//   `bridge` is the single source of truth for merges: a bridged event points at its root.
//   `sources` (root only) is a derived list of member Slack IDs, kept for the admin JSON export.
let tokens = {};
let packets = {};
let sessions = {};               // participant SSE streams, keyed by the code they connected with
let mergeRequests = new Map();   // requesterCode -> { from, to, createdAt }
let orgStreams = new Map();      // organizer code -> Set<res> (the /orgStream SSE feeds)

function codeGen(token) {
    let code = randomGen();
    tokens[code] = token;
    packets[code] = null;
    return code;
}

function randomGen() {
    let code = "";
    for (let i = 0; i <= 3; i++) {
        code += Math.floor(Math.random() * 9) + 1;
    }
    if (tokens[code]) {
        return randomGen();
    }
    return code;
}

function tokenLog(slack, name) {
    return slack + "~" + name;
}

function logAs(code, ...msg) {
    const t = tokens[code];
    console.log(t ? tokenLog(t.slack, t.name) : `[${code}]`, ...msg);
}

function isBanned(slack) {
    return banned.indexOf(slack) != -1;
}

// Looks up an event by a caller-supplied code. Only own keys count: a bare `tokens[code]`
// would resolve "constructor" / "__proto__" to Object.prototype members.
function getToken(code) {
    code = String(code ?? "");
    return code && Object.hasOwn(tokens, code) ? tokens[code] : undefined;
}

function safeEqual(a, b) {
    if (typeof a !== "string" || !a) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Checks an events object (admin import or seed file) before it replaces the live one.
// Returns an error string, or null when every entry is usable.
function validateEvents(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return "Events must be a JSON object keyed by event code";
    }
    for (const [code, t] of Object.entries(obj)) {
        if (!t || typeof t !== "object" || Array.isArray(t)) {
            return `Event ${code} must be an object`;
        }
        for (const field of ["name", "slack", "password"]) {
            if (typeof t[field] !== "string" || !t[field]) {
                return `Event ${code} is missing a "${field}" string`;
            }
        }
        if (t.bridge != null && typeof t.bridge !== "string") {
            return `Event ${code} has a non-string "bridge"`;
        }
        if (t.cityName != null && typeof t.cityName !== "string") {
            return `Event ${code} has a non-string "cityName"`;
        }
    }
    return null;
}

// Validates code/password from the query (GET) or body (POST).
// Sends the error response itself and returns null on failure, otherwise returns the code.
function authOrganizer(req, res) {
    const src = (req.method === "GET" ? req.query : req.body) || {};
    const code = src.code != null ? String(src.code) : "";
    const password = src.password;
    if (!code || !password) {
        res.status(400).json({ error: "Missing credentials" });
        return null;
    }
    const token = getToken(code);
    if (!token || !safeEqual(token.password, password)) {
        res.status(401).json({ error: "Invalid event code or password" });
        return null;
    }
    if (isBanned(token.slack)) {
        res.status(401).json({ error: "Banned user" });
        return null;
    }
    return code;
}

function authAdmin(req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return null;
    if (admins.indexOf(tokens[code].slack) == -1) {
        res.status(401).json({ error: "Admin permissions not present" });
        return null;
    }
    return code;
}

// --- SSE plumbing ---

function openSSE(res) {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    res.write("retry: 5000\n\n");
}

function sseWrite(res, payload) {
    try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {}
}

function sseEnd(res, payload) {
    if (payload) sseWrite(res, payload);
    try {
        res.end();
    } catch (e) {}
}

// Reverse proxies drop idle connections (~60-100s); a comment line keeps every stream alive.
setInterval(() => {
    for (const list of Object.values(sessions)) {
        for (const res of list) {
            try { res.write(": ping\n\n"); } catch (e) {}
        }
    }
    for (const set of orgStreams.values()) {
        for (const res of set) {
            try { res.write(": ping\n\n"); } catch (e) {}
        }
    }
}, 25000).unref();

// --- Merge model ---

function getRootCode(code) {
    const t = getToken(code);
    const bridge = t && t.bridge;
    return bridge && getToken(bridge) ? bridge : code;
}

function getMembers(root) {
    return Object.keys(tokens).filter(c => tokens[c].bridge === root);
}

function groupCodes(root) {
    return [root, ...getMembers(root)];
}

function syncSources(root) {
    if (!tokens[root]) return;
    tokens[root].sources = getMembers(root).map(c => tokens[c].slack);
}

// Repairs a tokens object (e.g. after an admin import) so every bridge points at a live root
// and merges are exactly one level deep: dangling bridges are dropped, chains are flattened to
// their ultimate root, and cycles are broken.
function normalizeMerges() {
    for (const [code, t] of Object.entries(tokens)) {
        if (t.bridge && (!getToken(t.bridge) || t.bridge === code)) delete t.bridge;
    }
    for (const t of Object.values(tokens)) {
        if (!t.bridge) continue;
        const seen = new Set();
        let root = t.bridge;
        while (tokens[root].bridge && !seen.has(root)) {
            seen.add(root);
            root = tokens[root].bridge;
        }
        if (tokens[root].bridge) delete t.bridge; // cycle
        else t.bridge = root;
    }
    for (const [code, t] of Object.entries(tokens)) {
        if (t.bridge) delete t.sources;
        else syncSources(code);
    }
}

function publicEvent(code) {
    const t = tokens[code];
    if (!t) return null;
    return { code, name: t.name, slack: t.slack, cityName: t.cityName || null };
}

// Everything an organizer's merge UI needs, from that organizer's point of view.
function mergeState(code) {
    const root = getRootCode(code);
    const bridged = root !== code;
    const outgoing = mergeRequests.get(code);
    return {
        code,
        role: bridged ? "bridged" : "root",
        root: publicEvent(root),
        members: getMembers(root).map(publicEvent),
        incoming: bridged ? [] : [...mergeRequests.values()]
            .filter(r => r.to === code)
            .map(r => ({ ...publicEvent(r.from), createdAt: r.createdAt })),
        outgoing: outgoing ? { ...publicEvent(outgoing.to), createdAt: outgoing.createdAt } : null
    };
}

function notifyOrg(code, reason) {
    const set = orgStreams.get(code);
    if (!set || !tokens[code]) return;
    const payload = { type: "state", reason, state: mergeState(code) };
    for (const res of set) sseWrite(res, payload);
}

function notifyGroup(root, reason) {
    for (const c of groupCodes(root)) notifyOrg(c, reason);
}

function closeOrgStreams(code, payload) {
    const set = orgStreams.get(code);
    if (!set) return;
    for (const res of set) sseEnd(res, payload);
    orgStreams.delete(code);
}

function participantPayload(code) {
    const root = getRootCode(code);
    return {
        data: packets[root] ?? null,
        cityName: (tokens[root] && tokens[root].cityName) || (tokens[code] && tokens[code].cityName) || null
    };
}

function pushToParticipants(codes) {
    let count = 0;
    for (const c of codes) {
        const list = sessions[c];
        if (!list || list.length == 0) continue;
        const payload = participantPayload(c);
        for (const res of list) sseWrite(res, payload);
        count += list.length;
    }
    return count;
}

function dropRequest(from, reason) {
    const r = mergeRequests.get(from);
    if (!r) return;
    mergeRequests.delete(from);
    notifyOrg(r.from, reason);
    notifyOrg(r.to, reason);
}

function dropRequestsInvolving(code, reason) {
    for (const r of [...mergeRequests.values()]) {
        if (r.from === code || r.to === code) dropRequest(r.from, reason);
    }
}

function mergeInto(root, member) {
    mergeRequests.delete(member);
    tokens[member].bridge = root;
    delete tokens[member].sources;

    syncSources(root);
    pushToParticipants([member]);

    // A bridged event can't host, and a root that now has members can't merge out.
    // Only the requesting side is told about requests to `member`: the member itself must see
    // just "merged", not a "your target merged elsewhere" notice about its own merge.
    // Delete-then-notify one request at a time so each push carries exactly one change;
    // clients ignore pushes identical to the state they already hold.
    for (const r of [...mergeRequests.values()]) {
        if (r.to !== member) continue;
        mergeRequests.delete(r.from);
        if (r.from !== root) notifyOrg(r.from, "target_merged_elsewhere");
    }
    const rootOutgoing = mergeRequests.get(root);
    if (rootOutgoing) {
        mergeRequests.delete(root);
        notifyOrg(rootOutgoing.to, "request_cancelled");
        notifyOrg(root, "outgoing_cancelled");
    }
    notifyGroup(root, "merged");
}

function unmerge(member, reason) {
    const root = tokens[member] && tokens[member].bridge;
    if (!root) return;
    delete tokens[member].bridge;
    // Give the departing event the shared screen's last state so its participants don't
    // jump back to whatever it showed before merging.
    packets[member] = packets[root] ?? packets[member] ?? null;
    syncSources(root);
    syncSources(member);
    pushToParticipants([member]);
    notifyGroup(root, reason);
    notifyOrg(member, reason);
}

// Removes an event entirely (bans). Its members become standalone roots.
function purgeEvent(code, endPayload) {
    dropRequestsInvolving(code, "target_unavailable");
    for (const m of getMembers(code)) unmerge(m, "host_removed");
    // From the host's side a banned member simply leaves.
    if (tokens[code].bridge) unmerge(code, "member_left");

    for (const res of sessions[code] || []) sseEnd(res, endPayload);
    closeOrgStreams(code, { type: "revoked", reason: "banned" });
    delete sessions[code];
    delete tokens[code];
    delete packets[code];
}

if (process.env.SEED_FILE) {
    const seeded = JSON.parse(fs.readFileSync(process.env.SEED_FILE, "utf8"));
    const problem = validateEvents(seeded);
    if (problem) {
        console.error(`Refusing SEED_FILE ${process.env.SEED_FILE}: ${problem}`);
        process.exit(1);
    }
    tokens = seeded;
    for (const code of Object.keys(tokens)) {
        sessions[code] = [];
        packets[code] = null;
    }
    normalizeMerges();
    console.log(`Seeded ${Object.keys(tokens).length} events from ${process.env.SEED_FILE}`);
}

// --- Express Routes ---

app.post("/genToken", async function(req, res) {
    const { code } = req.body || {};
    if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Missing code" });
    }

    let reqBody = {
        "client_id": clientID,
        "client_secret": process.env.CLIENT_SECRET,
        "redirect_uri": process.env.REDIRECT,
        "code": code,
        "grant_type": "authorization_code"
    };
    let scopes;
    try {
        const response = await fetch("https://auth.hackclub.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqBody)
        });
        if (!response.ok) {
            return res.status(401).json({ error: "Initial auth request failed" });
        }
        const data = await response.json();

        const response2 = await fetch("https://auth.hackclub.com/api/v1/me", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${data.access_token}`,
                "Content-Type": "application/json"
            }
        });
        if (!response2.ok) {
            return res.status(401).json({ error: "Information request failed" });
        }
        const prescopes = await response2.json();
        scopes = prescopes && prescopes.identity;
    } catch (e) {
        console.error("Auth provider request failed:", e);
        return res.status(502).json({ error: "Could not reach Hack Club Auth, try again soon" });
    }
    if (!scopes || typeof scopes.slack_id !== "string" || !scopes.slack_id) {
        return res.status(401).json({ error: "Auth response missing identity" });
    }
    if (!scopes.ysws_eligible || scopes.verification_status != "verified") {
        return res.status(401).json({ error: "User is not eligible" });
    }

    if (isBanned(scopes.slack_id)) {
        return res.status(401).json({ error: "Banned user" });
    }

    let existing = Object.entries(tokens).find(([c, t]) => t.slack == scopes.slack_id);
    if (existing) {
        let [existingCode, userToken] = existing;
        return res.status(200).json({
            credentials: [existingCode, scopes.slack_id, scopes.first_name, userToken.password],
            sources: userToken.sources || []
        });
    }

    const randarray = new Uint8Array(16);
    crypto.getRandomValues(randarray);
    let cryptoCode = "";
    for (let i = 0; i < randarray.length; i++) {
        cryptoCode += "" + randarray[i];
    }

    let newToken = {};
    newToken.name = scopes.first_name;
    newToken.slack = scopes.slack_id;
    newToken.password = cryptoCode;
    newToken.sources = [];
    const jumbotronCode = codeGen(newToken);
    sessions[jumbotronCode] = [];
    console.log(tokenLog(newToken.slack, newToken.name), `Generated new code ${jumbotronCode}`);

    return res.status(200).json({
        credentials: [jumbotronCode, newToken.slack, newToken.name, newToken.password],
        sources: newToken.sources
    });
});

app.post("/initEvent", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const { cityName } = req.body;
    if (!cityName || typeof cityName !== "string") {
        return res.status(400).json({ error: "Missing parameter(s)" });
    }

    if (tokens[code].bridge) {
        return res.status(400).json({ error: "Bridged events cannot initialize events; only root events can set location." });
    }

    tokens[code].cityName = cityName.trim();
    const count = pushToParticipants(groupCodes(code));
    notifyGroup(code, "city_changed");
    logAs(code, `Set ${cityName} as location visible${count ? ` and broadcast to ${count} users` : ""}`);

    return res.status(200).json({ message: `Set ${cityName} as location visible to participants` });
});

app.post("/sendPacket", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const { packet } = req.body;
    if (!packet) {
        return res.status(400).json({ error: "Missing parameter(s)" });
    }

    // Bridged organizers co-host: their updates drive the root's shared screen.
    const rootCode = getRootCode(code);
    packets[rootCode] = packet;

    const count = pushToParticipants(groupCodes(rootCode));
    logAs(code, `Updated information based on ${packet}${count ? ` and broadcasted to ${count} users` : ""}`);
    return res.status(200).json({ message: `Updated information${count ? ` and broadcasted to ${count} users` : ""}` });
});

app.get("/getPacket", async function (req, res) {
    const code = req.query.code != null ? String(req.query.code) : "";
    if (!code) {
        return res.status(400).json({ error: "Missing event code" });
    }
    if (!getToken(code)) {
        return res.status(400).json({ error: "No event found" });
    }
    if (isBanned(tokens[code].slack)) {
        return res.status(401).json({ error: "Banned user" });
    }

    return res.status(200).json(participantPayload(code));
});

app.get("/getSession", async function(req, res) {
    const code = req.query.code != null ? String(req.query.code) : "";
    if (!code) {
        return res.status(400).json({ error: "No event code provided" });
    }
    if (!getToken(code)) {
        return res.status(400).json({ error: "No event found based on provided code" });
    }
    if (isBanned(tokens[code].slack)) {
        return res.status(401).json({ error: "Banned user" });
    }

    openSSE(res);
    (sessions[code] ??= []).push(res);
    sseWrite(res, participantPayload(code));

    res.on("close", () => {
        if (sessions[code]) sessions[code] = sessions[code].filter(x => x != res);
    });
});

// --- Organizer stream & merges ---
//
// One authenticated SSE feed per organizer tab. Every message is either
//   { type: "state", reason, state }   -> replace the client's merge state wholesale
//   { type: "reset" }                  -> admin replaced the database; re-check credentials
//   { type: "revoked", reason }        -> credentials are no longer valid; sign out
// All merge actions are plain POSTs; their effects arrive back over this feed.

app.get("/orgStream", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;

    openSSE(res);
    if (!orgStreams.has(code)) orgStreams.set(code, new Set());
    orgStreams.get(code).add(res);
    sseWrite(res, { type: "state", reason: "connected", state: mergeState(code) });

    res.on("close", () => {
        const set = orgStreams.get(code);
        if (!set) return;
        set.delete(res);
        if (set.size == 0) orgStreams.delete(code);
    });
});

app.get("/mergeState", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    return res.status(200).json(mergeState(code));
});

app.post("/mergeRequest", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const destination = req.body.destination != null ? String(req.body.destination).trim() : "";

    if (!destination) {
        return res.status(400).json({ error: "Missing destination code" });
    }
    if (destination === code) {
        return res.status(400).json({ error: "You can't merge an event into itself" });
    }
    if (!getToken(destination) || isBanned(tokens[destination].slack)) {
        return res.status(404).json({ error: "No event found with that code" });
    }
    if (tokens[code].bridge) {
        return res.status(409).json({ error: "Your event is already merged into another event. Leave that merge first." });
    }
    if (getMembers(code).length > 0) {
        return res.status(409).json({ error: "Other events are merged into yours. Remove them before merging into another event." });
    }
    if (tokens[destination].bridge) {
        return res.status(409).json({ error: "That event is itself merged into another event. Request to merge into its host event instead." });
    }

    const existing = mergeRequests.get(code);
    if (existing) {
        if (existing.to === destination) {
            return res.status(200).json(mergeState(code));
        }
        return res.status(409).json({ error: "You already have a pending merge request. Cancel it first." });
    }

    mergeRequests.set(code, { from: code, to: destination, createdAt: Date.now() });
    notifyOrg(code, "request_sent");
    notifyOrg(destination, "request_received");
    logAs(code, `Requesting merge into ${destination}`);
    return res.status(200).json(mergeState(code));
});

app.post("/cancelMergeRequest", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    if (!mergeRequests.has(code)) {
        return res.status(404).json({ error: "No pending merge request" });
    }
    dropRequest(code, "request_cancelled");
    logAs(code, "Cancelled outgoing merge request");
    return res.status(200).json(mergeState(code));
});

app.post("/respondMergeRequest", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const requester = req.body.requester != null ? String(req.body.requester) : "";
    const { accept } = req.body;
    if (!requester || typeof accept !== "boolean") {
        return res.status(400).json({ error: "Missing requester or accept flag" });
    }

    const request = mergeRequests.get(requester);
    if (!request || request.to !== code) {
        return res.status(404).json({ error: "This request no longer exists. It may have been cancelled." });
    }

    if (!accept) {
        dropRequest(requester, "request_rejected");
        logAs(code, `Rejected merge request from ${requester}`);
        return res.status(200).json(mergeState(code));
    }

    // Invariants should already guarantee these; re-check rather than create a chain.
    if (tokens[code].bridge || tokens[requester].bridge || getMembers(requester).length > 0) {
        dropRequest(requester, "target_unavailable");
        return res.status(409).json({ error: "This merge is no longer possible. The request has been removed." });
    }

    mergeInto(code, requester);
    logAs(code, `Accepted merge of ${requester}`);
    return res.status(200).json(mergeState(code));
});

app.post("/unmerge", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;

    if (tokens[code].bridge) {
        // A bridged event can only remove itself.
        const root = tokens[code].bridge;
        unmerge(code, "member_left");
        logAs(code, `Left merge with ${root}`);
        return res.status(200).json(mergeState(code));
    }

    const target = req.body.target != null ? String(req.body.target) : "";
    if (!target || !getToken(target) || tokens[target].bridge !== code) {
        return res.status(404).json({ error: "That event isn't merged into yours" });
    }
    unmerge(target, "member_removed");
    logAs(code, `Removed ${target} from merge`);
    return res.status(200).json(mergeState(code));
});

// --- Admin ---

app.get("/allEvents", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;

    let items = JSON.stringify(tokens);
    logAs(code, "Requested all events through admin");
    return res.status(200).json({ list: items });
});

app.post("/setEvents", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;
    const { items } = req.body;
    if (!items) {
        return res.status(400).json({ error: "Missing list" });
    }

    let parsed;
    try {
        parsed = JSON.parse(items);
    } catch (e) {
        return res.status(400).json({ error: "Invalid JSON format for items" });
    }
    // Validate before touching live state: a bad import would otherwise 500 every endpoint.
    const problem = validateEvents(parsed);
    if (problem) {
        return res.status(400).json({ error: problem });
    }
    logAs(code, "Replaced all events through admin");

    for (let clientResList of Object.values(sessions)) {
        for (let clientRes of clientResList) {
            sseEnd(clientRes, { error: "Events database replaced by administrator" });
        }
    }
    for (const c of [...orgStreams.keys()]) {
        closeOrgStreams(c, { type: "reset", message: "Events database replaced by administrator" });
    }

    tokens = parsed;
    normalizeMerges();
    mergeRequests.clear();
    packets = {};
    sessions = {};
    for (let jumbotronCode of Object.keys(tokens)) {
        sessions[jumbotronCode] = [];
    }

    return res.status(200).json({ message: "Updated events, closed all active sessions, and reset packets successfully." });
});

app.post("/banEvent", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;
    let { banSlack, banList } = req.body;
    if (!banSlack && !banList) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const banUserBySlack = (targetSlack) => {
        for (let [jumbotronCode, tokenObj] of Object.entries(tokens)) {
            if (tokenObj.slack === targetSlack) {
                purgeEvent(jumbotronCode, { error: "User banned by administrator" });
            }
        }
        if (!banned.includes(targetSlack)) {
            banned.push(targetSlack);
        }
    };

    if (banSlack) {
        let targetSlack = String(banSlack).trim();
        logAs(code, `Banned and purged Slack ID ${targetSlack}`);
        banUserBySlack(targetSlack);
        return res.status(200).json({ message: `Slack ID ${targetSlack} has been banned and terminated.` });
    }
    if (!Array.isArray(banList)) {
        return res.status(400).json({ error: "banList must be an array" });
    }
    banned = [];
    for (let targetSlack of banList) {
        banUserBySlack(targetSlack);
    }
    logAs(code, `Set ban list and purged active events`);
    return res.status(200).json({ message: `Ban list updated and active sessions terminated.` });
});

app.post("/unbanEvent", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;
    let { unbanSlack } = req.body;
    if (!unbanSlack) {
        return res.status(400).json({ error: "Missing Slack ID" });
    }

    banned = banned.filter(x => x != unbanSlack);
    logAs(code, `Unbanned ${unbanSlack}`);
    return res.status(200).json({ message: "Unbanned user" });
});

app.get("/getBans", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;

    logAs(code, "Requested list of banned users");
    return res.status(200).json({ list: JSON.stringify(banned) });
});

app.get("/getAdmins", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;

    return res.status(200).json({admins: admins});
});

app.use(function (req, res) {
    res.status(404).json({ error: "Not found" });
});

// JSON errors only: Express's default handler answers with HTML and, outside
// NODE_ENV=production, the stack trace.
app.use(function (err, req, res, next) {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? "Internal server error" : (err.expose && err.message) || "Bad request" });
});

const port = process.env.PORT || 3000;

app.listen(port, function() {
    console.log(`Jumbotron running on port ${port}`);
});

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
dotenv.config();

let admins = process.env.ADMINS || "U08EMT46G3V";
admins = admins.split(";");

let banned = [];
let bridgeRequests = [];
let bridgeConnections = {}; // Track active SSE response streams separately

const app = express();
app.use(express.json());
app.use(cors({
    origin: [
        "https://symmetrical-doodle-69qgr7v97j76f59j7-5173.app.github.dev",
        "https://jumbotron.hackclub.com"
    ],
    methods: [
        "POST", "GET"
    ],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

let clientID = "e86d4d7eec9c546e6c4700388d4fea7f";

let tokens = {};
let packets = {};
let sessions = {};

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

// --- Helper Functions for Merged Events ---

function getRootCode(code) {
    if (tokens[code] && tokens[code].bridge) {
        return tokens[code].bridge;
    }
    return code;
}

function getGroupSessions(code) {
    const rootCode = getRootCode(code);
    let activeSessions = [...(sessions[rootCode] || [])];
    
    // Include sessions from all events bridged to this root
    for (let [c, t] of Object.entries(tokens)) {
        if (t.bridge === rootCode && sessions[c]) {
            activeSessions.push(...sessions[c]);
        }
    }
    return activeSessions;
}

// --- Express Routes ---

app.post("/genToken", async function(req, res) {
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ error: "Missing code" });
    }

    let reqBody = {
        "client_id": clientID,
        "client_secret": process.env.CLIENT_SECRET,
        "redirect_uri": process.env.REDIRECT,
        "code": code,
        "grant_type": "authorization_code"
    };
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
    const scopes = prescopes.identity;
    if (!scopes.ysws_eligible || scopes.verification_status != "verified") {
        return res.status(401).json({ error: "User is not eligible" });
    }
    
    if (banned.indexOf(scopes.slack_id) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    let expanded = Object.values(tokens);
    let index = expanded.findIndex((e) => e.slack == scopes.slack_id);
    if (index != -1) {
        let expanded2 = Object.entries(tokens);
        let existingCode = expanded2[index][0];
        let userToken = tokens[existingCode];
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
    const { code, password, cityName } = req.body;
    if (!code || !password || !cityName) {
        return res.status(400).json({ error: "Missing parameter(s)" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Invalid Jumbotron token aspect" }); 
    }

    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    // Block bridged events from initializing/setting event location
    if (tokens[code].bridge) {
        return res.status(400).json({ error: "Bridged events cannot initialize events; only root events can set location." });
    }

    tokens[code].cityName = cityName.trim();
    const rootCode = getRootCode(code);
    const groupSessions = getGroupSessions(code);

    if (groupSessions.length != 0) {
        let payload = JSON.stringify({ data: packets[rootCode], cityName: tokens[code].cityName });
        for (let clientRes of groupSessions) {
            try {
                clientRes.write(`data: ${payload}\n\n`);
            } catch (e) {}
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ${cityName} as location visible and broadcast to ${groupSessions.length} users`);
    } else {
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ${cityName} as location visible`);
    }

    return res.status(200).json({ message: `Set ${cityName} as location visible to participants` });
});

app.post("/sendPacket", async function (req, res) {
    const { code, password, packet } = req.body;
    if (!code || !password || !packet) {
        return res.status(400).json({ error: "Missing parameter(s)" });
    }

    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Invalid Jumbotron token aspect" }); 
    }

    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    const rootCode = getRootCode(code);
    packets[rootCode] = packet;

    const groupSessions = getGroupSessions(code);
    const cityName = tokens[code].cityName || tokens[rootCode].cityName;

    if (groupSessions.length != 0) {
        let payload = JSON.stringify({ data: packet, cityName: cityName });
        for (let clientRes of groupSessions) {
            try {
                clientRes.write(`data: ${payload}\n\n`);
            } catch (e) {}
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Updated information based on ${packet} and broadcasted to ${groupSessions.length} users`);
        return res.status(200).json({ message: `Updated information based on ${packet} and broadcasted to ${groupSessions.length} users` });
    } else {
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Updated information based on ${packet}`);
    }

    return res.status(200).json({ message: `Updated information based on ${packet}` });
});

app.get("/getPacket", async function (req, res) {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ error: "Missing event code" });
    }

    if (!tokens[code]) {
        return res.status(400).json({ error: "No event found" });
    }
    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    const rootCode = getRootCode(code);
    let packet = packets[rootCode] || null;
    let cityName = tokens[code].cityName || tokens[rootCode].cityName;

    return res.status(200).json({ data: packet, cityName: cityName });
});

app.get("/getSession", async function(req, res) {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ error: "No event code provided" });
    }
    if (!tokens[code]) {
        return res.status(400).json({ error: "No event found based on provided code" });
    }
    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.flushHeaders();

    sessions[code].push(res);
    
    const rootCode = getRootCode(code);
    let packet = packets[rootCode] || null;
    let cityName = tokens[code].cityName || tokens[rootCode].cityName;

    let payload = JSON.stringify({ data: packet, cityName: cityName });
    res.write(`data: ${payload}\n\n`);

    res.on("close", () => {
        sessions[code] = sessions[code].filter(x => x != res);
    });
});

app.get("/mergeRequest", async function (req, res) {
    const { code, password, destination } = req.query;
    if (!code || !password || !destination) {
        return res.status(401).json({ error: "Missing parameters" });
    }
    if (!tokens[code] || !tokens[destination]) {
        return res.status(400).json({ error: "Requesting event or recipient not found" });
    }
    if (tokens[code].password != password) {
        return res.status(401).json({ error: "Invalid authentication" });
    }
    
    if (banned.indexOf(tokens[code].slack) != -1 || banned.indexOf(tokens[destination].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    if (tokens[code].bridge || tokens[destination].bridge) {
        return res.status(400).json({ error: "Either this event or the target event is not a root and already has a merge source" });
    }

    let existingOutgoing = bridgeRequests.some(x => x.code == code);
    if (existingOutgoing) {
        return res.status(400).json({ error: "You already have an active outgoing merge request. Cancel or complete it first." });
    }

    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.flushHeaders();

    bridgeConnections[code] = res;

    let body = {
        slack: tokens[code].slack,
        name: tokens[code].name,
        code: code,
        recipient: destination
    };

    bridgeRequests.push(body);

    res.write("data: request pending\n\n");
    console.log(tokenLog(tokens[code].slack, tokens[code].name), `Requesting merge into ${destination}`);

    res.on("close", () => {
        delete bridgeConnections[code];
        bridgeRequests = bridgeRequests.filter(x => x.code != code);
    });
});

app.get("/getMergeRequests", async function (req, res) {
    const { code, password } = req.query;
    if (!code || !password) {
        return res.status(401).json({ error: "No credentials" });
    } 
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(400).json({ error: "Invalid event or incorrect password" });
    }

    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    let outgoingRequests = bridgeRequests.filter(x => x.code == code);
    if (tokens[code].bridge || outgoingRequests.length != 0) {
        return res.status(400).json({ error: "This event can't accept requests as it's not a root event, or this event has outgoing merge requests" });
    }

    let requests = bridgeRequests.filter(x => x.recipient == code);
    return res.status(200).json({ requests: requests });
});

app.post("/ackMergeRequest", async function (req, res) {
    const { code, password, recipient, accept } = req.body;
    if (!code || !password || !recipient || accept == null) {
        return res.status(400).json({ error: "Missing param(s)" });
    }

    if (!tokens[code] || tokens[code].password != password) {
        return res.status(400).json({ error: "Invalid event or incorrect password" });
    }
    if (!tokens[recipient]) {
        return res.status(400).json({ error: "Invalid recipient event" });
    }

    if (banned.indexOf(tokens[code].slack) != -1 || banned.indexOf(tokens[recipient].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    if (tokens[code].bridge || tokens[recipient].bridge) {
        return res.status(400).json({ error: "Either this event or the target event is not a root and already has a merge source" });
    }

    let request = bridgeRequests.filter(x => x.recipient == code && x.code == recipient);
    if (request.length == 0) {
        return res.status(400).json({ error: "This request wasn't found" });
    }

    if (accept === true) {
        let myOutgoingRequests = bridgeRequests.filter(x => x.code == code);
        for (let outReq of myOutgoingRequests) {
            let outConn = bridgeConnections[outReq.code];
            if (outConn) {
                outConn.write("data: cancelled due to accepting another merge\n\n");
                outConn.end();
            }
        }
        bridgeRequests = bridgeRequests.filter(x => x.code != code);
    }

    let targetConnection = bridgeConnections[recipient];

    if (accept == true) {
        tokens[recipient].bridge = code;
        if (!tokens[code].sources) {
            tokens[code].sources = [tokens[recipient].slack];
        } else {
            tokens[code].sources.push(tokens[recipient].slack);
        }
        if (targetConnection) {
            targetConnection.write("data: accepted\n\n");
            targetConnection.end();
        }
    } else {
        if (targetConnection) {
            targetConnection.write("data: rejected\n\n");
            targetConnection.end();
        }
    }

    bridgeRequests = bridgeRequests.filter(x => !(x.recipient == code && x.code == recipient));
    delete bridgeConnections[recipient];

    if (accept == true) {
        return res.status(200).json({ message: "Merge request processed successfully", sources: tokens[code].sources });
    }

    return res.status(200).json({ message: "Merge request processed successfully" });
});

app.get("/getMergedEvents", async function (req, res) {
    let { code, password } = req.query;
    if (!code || !password) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Invalid credentials or event does not exist" });
    }

    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({ error: "Banned user" });
    }

    return res.status(200).json({ events: tokens[code].sources });
});

app.post("/unmergeEvents", async function (req, res) {
    const { code, password, root, slack } = req.body;
    if (!code || !password || !root || !slack) {
        return res.status(400).json({ error: "Missing parameters" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Failed to authenticate" });
    }

    if (!tokens[root]) {
        return res.status(400).json({ error: "Root event not found" });
    }

    let targetEntry = Object.entries(tokens).find(([c, t]) => t.slack === slack);

    if (!targetEntry) {
        return res.status(400).json({ error: "Bridged event not found for the given slack ID" });
    }

    let targetCode = targetEntry[0];

    if (tokens[targetCode].bridge !== root || !tokens[root].sources || !tokens[root].sources.includes(slack)) {
        return res.status(400).json({ error: "This event is not actually merged into the specified root event." });
    }

    if (tokens[root].sources) {
        tokens[root].sources = tokens[root].sources.filter(x => x != slack);
    }

    delete tokens[targetCode].bridge;

    console.log(tokenLog(tokens[code].slack, tokens[code].name), `Unmerged ${targetCode} from ${root}`);
    return res.status(200).json({ message: "Successfully unmerged events" });
});

app.get("/allEvents", async function (req, res) {
    let { code, password } = req.query;
    if (!code || !password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }

    let items = JSON.stringify(tokens);
    console.log(tokenLog(tokens[code].slack, tokens[code].name), "Requested all events through admin");
    return res.status(200).json({ list: items });
});

app.post("/setEvents", async function (req, res) {
    let { code, password, items } = req.body;
    if (!code || !password || !items) {
        return res.status(400).json({ error: "Admin permissions not present or missing list" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    console.log(tokenLog(tokens[code].slack, tokens[code].name), "Replaced all events through admin");

    for (let [jumbotronCode, clientResList] of Object.entries(sessions)) {
        if (clientResList && clientResList.length > 0) {
            for (let clientRes of clientResList) {
                try {
                    clientRes.write(`data: ${JSON.stringify({ error: "Events database replaced by administrator" })}\n\n`);
                    clientRes.end();
                } catch (e) {}
            }
        }
    }

    try {
        tokens = JSON.parse(items);
    } catch (e) {
        return res.status(400).json({ error: "Invalid JSON format for items" });
    }

    packets = {};
    sessions = {};
    for (let jumbotronCode of Object.keys(tokens)) {
        sessions[jumbotronCode] = [];
    }

    return res.status(200).json({ message: "Updated events, closed all active sessions, and reset packets successfully." });
});

app.post("/banEvent", async function (req, res) {
    let { code, password, banSlack, banList } = req.body;
    if (!code || !password || (!banSlack && !banList)) {
        return res.status(400).json({ error: "Admin permissions not present or missing parameters" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }

    const banUserBySlack = (targetSlack) => {
        for (let [jumbotronCode, tokenObj] of Object.entries(tokens)) {
            if (tokenObj.slack === targetSlack) {
                if (sessions[jumbotronCode] && sessions[jumbotronCode].length > 0) {
                    for (let clientRes of sessions[jumbotronCode]) {
                        try {
                            clientRes.write(`data: ${JSON.stringify({ error: "User banned by administrator" })}\n\n`);
                            clientRes.end();
                        } catch (e) {}
                    }
                    delete sessions[jumbotronCode];
                }
                delete tokens[jumbotronCode];
                delete packets[jumbotronCode];
            }
        }

        if (!banned.includes(targetSlack)) {
            banned.push(targetSlack);
        }
    };

    if (banSlack) {
        let targetSlack = banSlack.trim();
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Banned and purged Slack ID ${targetSlack}`);
        banUserBySlack(targetSlack);
        return res.status(200).json({ message: `Slack ID ${targetSlack} has been banned and terminated.` });
    } else if (banList) {
        banned = banList;
        for (let targetSlack of banned) {
            banUserBySlack(targetSlack);
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ban list and purged active events`);
        return res.status(200).json({ message: `Ban list updated and active sessions terminated.` });
    }
});

app.post("/unbanEvent", async function (req, res) {
    let { code, password, unbanSlack } = req.body;
    if (!code || !password || !unbanSlack) {
        return res.status(400).json({ error: "Admin permissions not present or missing list" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }

    banned = banned.filter(x => x != unbanSlack);
    console.log(tokenLog(tokens[code].slack, tokens[code].name), `Unbanned ${unbanSlack}`);
    return res.status(200).json({ message: "Unbanned user" });
});

app.get("/getBans", async function (req, res) {
    let { code, password } = req.query;
    if (!code || !password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({ error: "Admin permissions not present" });
    }

    console.log(tokenLog(tokens[code].slack, tokens[code].name), "Requested list of banned users");
    return res.status(200).json({ list: JSON.stringify(banned) });
});

app.get("/getAdmins", async function (req, res) {
    const { code, password} = req.query;
    if (!code || !password) {
        return res.status(401).json({ error: "Failed to authenticate; missing params" });
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({ error: "Failed to authenticate" });
    }

    return res.status(200).json({admins: admins});
});

const port = process.env.PORT || 3000; 

app.listen(port, function() {
    console.log(`Jumbotron running on port ${port}`);
});
app.set('trust proxy', 'loopback');
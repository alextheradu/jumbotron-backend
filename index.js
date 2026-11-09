import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
dotenv.config();

let admins = process.env.ADMINS;
let banned = [];

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
}))

let clientID = "e86d4d7eec9c546e6c4700388d4fea7f";


/*
function timeDiff(timestamp) {
    if (timestamp == null) {
        return true;
    }
    let clock = new Date();
    let curr = clock.getTime();
    let diff = curr - timestamp;
    diff = diff/1000/60;
    if (diff > 30) {
        return true
    }
    return false;
}
    */


/*async function sendDataToSlack() {
    const slackToken = process.env.BOT_TOKEN;
    const channelId = process.env.CHANNEL_ID;

    if (!slackToken || !channelId) {
        console.error("Missing Slack environment variables.");
        return;
    }

    // Isolate only emails per city; completely exclude active sessions and liveshare states
    const emailOnlyBackup = events.map(event => ({
        name: event.name,
        acceptedEmails: [...event.acceptedEmails]
    }));

    // Package directly into the requested structured JSON format
    const adminConsolePayload = {
        authKey: masterKey || 'your_master_key',
        eventsNew: emailOnlyBackup,
        sessionsNew: [] // Explicitly reset sessions to keep it clean
    };

    const payloadString = JSON.stringify(adminConsolePayload, null, 2);

    try {
        // Post directly to the chat channel as a clean markdown block for your admin console
        const response = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": `Bearer ${slackToken}`
            },
            body: JSON.stringify({
                channel: channelId,
                text: `🚨 *Jumbotron Email Configuration Snapshot* 🚨\nTotal Tracked Cities: *${emailOnlyBackup.length}* | _Active active login sessions excluded._\n\n*Copy and paste this JSON data block directly into your admin console or use with /mutate:* \n\`\`\`json\n${payloadString}\n\`\`\``
            })
        });

        const result = await response.json();
        if (!result.ok) {
            console.error("Slack chat.postMessage Error:", result.error);
        } else {
            console.log("JSON admin console payload posted to Slack channel!");
        }
    } catch (err) {
        console.error("Failed to post JSON backup to Slack:", err);
    }
}*/

let tokens = {};
let packets = {};
let sessions = {};

function codeGen(token) {
    let code = randomGen()
    tokens[code] = token;
    packets[code] = null;
    return code;
}

function randomGen() {
    let code = "";
    for (let i = 0; i <= 3; i++) {
        code += Math.floor(Math.random()*9) + 1;
    }
    /*
    if (codes.indexOf(code) == -1) {
        return code;
    }
    else {
        return randomGen();
    }*/
   if (tokens[code]) {
    return randomGen();
   }
   return code;
}

function tokenLog(slack, name) {
    return slack + "~" + name;
}

// --- Express Routes ---


app.post("/genToken", async function(req, res) {
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ error: "Missing code"});
    }

    let reqBody = {
            "client_id": clientID,
            "client_secret": process.env.CLIENT_SECRET,
            "redirect_uri": process.env.REDIRECT,
            "code": code,
            "grant_type": "authorization_code"
        }
    const response = await fetch("https://auth.hackclub.com/oauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(reqBody)
    })
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
    })
    if (!response2.ok) {
        return res.status(401).json({ error: "Information request failed" });
    }

    const prescopes = await response2.json();
    const scopes = prescopes.identity;
    if (!scopes.ysws_eligible || scopes.verification_status != "verified") {
        return res.status(401).json({ error: "User is not eligible" });
    }
    
    if (banned.indexOf(scopes.slack_id) != -1) {
        return res.status(401).json({error: "Banned user"});
    }

    if (true) { // keeps variables sub-local
        let expanded = Object.values(tokens);
        let index = expanded.findIndex((e) => {
            return e.slack == scopes.slack_id;
        })
        if (index != -1) {
            let expanded2 = Object.entries(tokens);
            return res.status(200).json({credentials: [expanded2[index][0], scopes.slack_id, scopes.first_name, tokens[expanded2[index][0]].password]})
        }
    }
    /*
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].slack == scopes.slack_id) {
            return res.status(200).json({credentials: [tokens[i].code, tokens[i].slack, tokens[i].name, tokens[i].password]});
        }
    }
    */

    const randarray = new Uint8Array(16);
    crypto.getRandomValues(randarray);
    let cryptoCode = "";
    for (let i = 0; i < randarray.length; i++) {
        cryptoCode += "" + randarray[i]
    }

    let newToken = {};
    newToken.name = scopes.first_name;
    newToken.slack = scopes.slack_id;
    newToken.password = cryptoCode;
    const jumbotronCode = await codeGen(newToken);
    sessions[jumbotronCode] = [];
    console.log(tokenLog(newToken.slack, newToken.name), `Generated new code ${jumbotronCode}`)
    return res.status(200).json({credentials: [jumbotronCode, newToken.slack, newToken.name, newToken.password]});
});


app.post("/initEvent", async function (req, res) {
    const { code, password, cityName } = req.body;
    if (!code || !password || !cityName) {
        return res.status(400).json({ error: "Missing parameter(s)"});
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Invalid Jumbotron token aspect"}); 
    }

    tokens[code].cityName = cityName;
    

    if (sessions[code].length != 0) {
        let payload = JSON.stringify({data: packets[code], cityName: tokens[code].cityName})
        for (let i = 0; i < sessions[code].length; i++) {
            sessions[code][i].write(`data: ${payload}\n\n`)
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ${cityName} as location visible and broadcast to ${sessions[code].length} users`)
    }
    else {
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ${cityName} as location visible`)
    }

    return res.status(200).json({message: `Set ${cityName} as location visible to participants`});
})


app.post("/sendPacket", async function (req, res) {
    const { code, password, packet } = req.body;
    if (!code || !password || !packet) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }

    if (banned.indexOf(code) != -1) {
        return res.status(401).json({error: "Banned user"});
    }

    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Invalid Jumbotron token aspect"}); 
    }

    packets[code] = packet;
    

    if (sessions[code].length != 0) {
        let payload = JSON.stringify({data: packet, cityName: tokens[code].cityName})
        for (let i = 0; i < sessions[code].length; i++) {
            sessions[code][i].write(`data: ${payload}\n\n`)
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Updated information based on ${packet} and broadcasted to ${sessions[code].length} users`);
        return res.status(200).json({message: `Updated information based on ${packet} and broadcasted to ${sessions[code].length} users`});
    }
    else {
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Updated information based on ${packet}`);
    }

    return res.status(200).json({message: `Updated information based on ${packet}`});
})

app.get("/getPacket", async function (req, res) {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({error: "Missing event code"});
    }

    let packet = packets[code];
    if (!packet) {
        if (tokens[code]) {
            return res.status(200).json({data: null, cityName: tokens[code].cityName});
        }
        return res.status(400).json({error: "No event found"});
    }
    return res.status(200).json({data: packet, cityName: tokens[code].cityName});
})

app.get("/getSession", async function(req, res) {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({error: "No event code provided"});
    }
    if (!tokens[code]) {
        return res.status(400).json({error: "No event found based on provided code"});
    }
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });
    res.flushHeaders();

    sessions[code].push(res);
    let payload = JSON.stringify({data: packets[code], cityName: tokens[code].cityName})
    res.write(`data: ${payload}\n\n`);

    res.on("close", () => {
        sessions[code] = sessions[code].filter(x => x != res);
    });
})

app.get("/allEvents", async function (req, res) {
    let { code, password } = req.query;
    if (!code || !password) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({error: "Admin permissions not present"});
    }

    let items = JSON.stringify(tokens);
    console.log(tokenLog(tokens[code].slack, tokens[code].name), "Requested all events through admin")
    return res.status(200).json({list: items});
})

app.post("/setEvents", async function (req, res) {
    let { code, password, items } = req.body;
    if (!code || !password || !items) {
        return res.status(400).json({error: "Admin permissions not present or missing list"});
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    console.log(tokenLog(tokens[code].slack, tokens[code].name), "Replaced all events through admin")

    tokens = JSON.parse(items);
    return res.status(200).json({message: "Updated events based on manual list"});
})

app.post("/banEvent", async function (req, res) {
    let { code, password, banCode, banList } = req.body;
    if (!code || !password || (!banCode && !banList)) {
        return res.status(400).json({error: "Admin permissions not present or missing list"});
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({error: "Admin permissions not present"});
    }

    const terminateAndPurge = (targetCode) => {
        // Terminate and close all active SSE participant connections
        if (sessions[targetCode] && sessions[targetCode].length > 0) {
            for (let clientRes of sessions[targetCode]) {
                try {
                    clientRes.write(`data: ${JSON.stringify({ error: "Event terminated/banned by administrator" })}\n\n`);
                    clientRes.end();
                } catch (e) {
                    // Ignore already-closed socket errors
                }
            }
            delete sessions[targetCode];
        }

        // Remove tokens and packet data from memory
        delete tokens[targetCode];
        delete packets[targetCode];

        // Add to banned array if not already present
        if (!banned.includes(targetCode)) {
            banned.push(targetCode);
        }
    };

    if (banCode) {
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Banned and purged event code ${banCode}`);
        terminateAndPurge(banCode);
        return res.status(200).json({message: `Event ${banCode} has been banned and terminated.`});
    }
    else if (banList) {
        banned = banList;
        for (let bCode of banned) {
            terminateAndPurge(bCode);
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ban list and purged active events`);
        return res.status(200).json({message: `Ban list updated and active sessions terminated.`});
    }
});

const port = process.env.PORT || 3000; 

app.listen(port, function() {
    console.log(`Jumbotron running on port ${port}`);
});
app.set('trust proxy', 'loopback');
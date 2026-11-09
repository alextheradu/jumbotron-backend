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

    if (true) {
        let expanded = Object.values(tokens);
        let index = expanded.findIndex((e) => {
            return e.slack == scopes.slack_id;
        })
        if (index != -1) {
            let expanded2 = Object.entries(tokens);
            return res.status(200).json({credentials: [expanded2[index][0], scopes.slack_id, scopes.first_name, tokens[expanded2[index][0]].password]})
        }
    }

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

    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({error: "Banned user"});
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

    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Invalid Jumbotron token aspect"}); 
    }

    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({error: "Banned user"});
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
            if (banned.indexOf(tokens[code].slack) != -1) {
                return res.status(401).json({error: "Banned user"});
            }
            return res.status(200).json({data: null, cityName: tokens[code].cityName});
        }
        return res.status(400).json({error: "No event found"});
    }
    if (tokens[code] && banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({error: "Banned user"});
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
    if (banned.indexOf(tokens[code].slack) != -1) {
        return res.status(401).json({error: "Banned user"});
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
    let { code, password, banSlack, banList } = req.body;
    if (!code || !password || (!banSlack && !banList)) {
        return res.status(400).json({error: "Admin permissions not present or missing parameters"});
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({error: "Admin permissions not present"});
    }

    const banUserBySlack = (targetSlack) => {
        // Iterate through tokens and purge any session associated with this Slack ID
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
        return res.status(200).json({message: `Slack ID ${targetSlack} has been banned and terminated.`});
    }
    else if (banList) {
        banned = banList;
        for (let targetSlack of banned) {
            banUserBySlack(targetSlack);
        }
        console.log(tokenLog(tokens[code].slack, tokens[code].name), `Set ban list and purged active events`);
        return res.status(200).json({message: `Ban list updated and active sessions terminated.`});
    }
});

app.post("/unbanEvent", async function (req, res) {
    let { code, password, unbanSlack } = req.body;
    if (!code || !password || !unbanSlack) {
        return res.status(400).json({error: "Admin permissions not present or missing list"});
    }
    if (!tokens[code] || tokens[code].password != password) {
        return res.status(401).json({error: "Admin permissions not present"});
    }
    if (admins.indexOf(tokens[code].slack) == -1) {
        return res.status(401).json({error: "Admin permissions not present"});
    }

    banned = banned.filter(x => x != unbanSlack);
    console.log(tokenLog(tokens[code].slack, tokens[code].name), `Unbanned ${unbanSlack}`);
})

app.get("/getBans", async function (req, res) {
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

    console.log(tokenLog(tokens[code].slack, tokens[code].name), "Requested list of banned users");
    return res.status(200).json({list: JSON.stringify(banned)});
})

const port = process.env.PORT || 3000; 

app.listen(port, function() {
    console.log(`Jumbotron running on port ${port}`);
});
app.set('trust proxy', 'loopback');
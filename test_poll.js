// Scratch script to test whatsapp-web.js poll
const fs = require('fs');

async function test() {
    console.log("This is a scratch script");
    try {
        const SessionManager = require('./session-manager.js');
        // Let's just mock or read from a session file if possible
        const dataPath = './data/messages/session_1772157864673.json';
        if (fs.existsSync(dataPath)) {
            const data = JSON.parse(fs.readFileSync(dataPath));
            const polls = Object.values(data).filter(m => m.type && m.type.includes('poll'));
            console.log("Found polls:", polls.length);
            if (polls.length > 0) {
                console.log(JSON.stringify(polls[0], null, 2));
            }
        }
    } catch (e) {
        console.error(e);
    }
}
test();

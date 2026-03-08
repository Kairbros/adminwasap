const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./data/messages/session_1772065699188.json'));
const msgs = Object.values(data);
const last20 = msgs.slice(-20);
fs.writeFileSync('last20.json', JSON.stringify(last20, null, 2));

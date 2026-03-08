const fs = require('fs');
const dir = './data/messages/';
const types = new Set();
fs.readdirSync(dir).forEach(file => {
    if (file.endsWith('.json')) {
        const data = JSON.parse(fs.readFileSync(dir + file));
        Object.values(data).forEach(msg => {
            if (msg.type) types.add(msg.type);
        });
    }
});
fs.writeFileSync('types_found.json', JSON.stringify(Array.from(types)));

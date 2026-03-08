const fs = require('fs');
const dir = './data/messages/';
let found = false;
fs.readdirSync(dir).forEach(file => {
    if (file.endsWith('.json') && !found) {
        const data = JSON.parse(fs.readFileSync(dir + file));
        Object.values(data).forEach(msg => {
            const str = JSON.stringify(msg).toLowerCase();
            if (!found && (str.includes('viewonce') || str.includes('view_once'))) {
                fs.writeFileSync('vo_found.json', JSON.stringify(msg, null, 2));
                found = true;
            }
        });
    }
});

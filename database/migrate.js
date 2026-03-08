const db = require('../src/services/db');

async function run() {
    try {
        await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_message_id VARCHAR(255) UNIQUE;`);
        console.log('Migration complete.');
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
run();

require('dotenv').config();
const { sendDisconnectAlert } = require('./notifier');

(async () => {
    console.log("Testing mail sender...");
    await sendDisconnectAlert(
        "session_test",
        "573001234567",
        "Test Phone",
        "Test Workspace"
    );
    console.log("Done");
})();

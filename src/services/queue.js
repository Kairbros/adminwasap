const { Queue, Worker } = require('bullmq');
const crypto = require('crypto');
const db = require('./db');
const storage = require('./storage');
const fs = require('fs');
const path = require('path');

const connection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

const mediaQueue = new Queue('MediaProcessingQueue', { connection });

/**
 * Calculates hash from a base64 string
 */
function calculateHashFromBase64(base64Data) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.from(base64Data, 'base64');
    hash.update(buffer);
    return hash.digest('hex');
}

/**
 * Worker that processes media background jobs
 */
const mediaWorker = new Worker('MediaProcessingQueue', async job => {
    const { sessionId, msgId, mimetype = 'application/octet-stream', tempFilePath, filename = null } = job.data;
    console.log(`[BullMQ] Procesando media para el mensaje ${msgId} (Sesion: ${sessionId})`);

    try {
        await storage.initBucket();

        // 1. Calculate Hash efficiently mapping file stream
        const fileHash = await storage.calculateFileHash(tempFilePath);
        const stats = fs.statSync(tempFilePath);
        const actualSize = stats.size;

        // 2. Comprobar deduplicación en PostgreSQL
        const { rows } = await db.query('SELECT s3_object_key FROM stored_files WHERE file_hash = $1', [fileHash]);
        let s3ObjectKey;
        let existsInMinio = false;

        if (rows.length > 0) {
            s3ObjectKey = rows[0].s3_object_key;
            try {
                // Verificar si FÍSICAMENTE existe en el bucket (Auto-reparación)
                await storage.minioClient.statObject(storage.DEFAULT_BUCKET, s3ObjectKey);
                existsInMinio = true;
            } catch (err) {
                console.log(`[BullMQ] Hash en DB pero NO en MinIO. Reparando: ${fileHash}`);
                existsInMinio = false;
            }
        }

        if (existsInMinio) {
            console.log(`[BullMQ] Archivo duplicado. Reutilizando: ${fileHash}`);
            fs.unlinkSync(tempFilePath); // Ya no necesitamos el temporal
        } else {
            console.log(`[BullMQ] Archivo nuevo o perdido. Subiendo a MinIO: ${fileHash}`);
            s3ObjectKey = fileHash; // Nombre exacto del archivo cifrado

            await storage.uploadToMinio(storage.DEFAULT_BUCKET, s3ObjectKey, tempFilePath, mimetype);
            fs.unlinkSync(tempFilePath); // Limpiar temporal

            await db.query(
                `INSERT INTO stored_files (file_hash, mime_type, size_bytes, s3_object_key) VALUES ($1, $2, $3, $4) ON CONFLICT (file_hash) DO NOTHING`,
                [fileHash, mimetype, actualSize, s3ObjectKey]
            );
        }

        // 3. Update the database 'messages' with the file_hash
        // Ensures the message exists and maps the file_hash correctly
        const { rows: deviceRows } = await db.query('SELECT id FROM devices WHERE session_name = $1 LIMIT 1', [sessionId]);
        let deviceId = null;
        if (deviceRows.length > 0) deviceId = deviceRows[0].id;

        await db.query(
            `INSERT INTO messages (device_id, remote_jid, message_type, wa_message_id, file_hash, original_file_name, timestamp) 
             VALUES ($1, 'system_media', $2, $3, $4, $5, NOW()) 
             ON CONFLICT (wa_message_id) 
             DO UPDATE SET file_hash = EXCLUDED.file_hash, original_file_name = EXCLUDED.original_file_name`,
            [deviceId, mimetype, msgId, fileHash, filename]
        );

        return { success: true, fileHash, msgId };

    } catch (error) {
        console.error(`[BullMQ] Error procesando ${msgId}:`, error);
        throw error;
    }
}, { connection });

mediaWorker.on('completed', job => {
    console.log(`[BullMQ] Trabajo ${job.id} completado con éxito (Hash: ${job.returnvalue?.fileHash})`);
});
mediaWorker.on('failed', (job, err) => {
    console.error(`[BullMQ] Trabajo ${job.id} falló:`, err);
});

module.exports = { mediaQueue };

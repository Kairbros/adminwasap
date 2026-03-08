const crypto = require('crypto');
const fs = require('fs');
const Minio = require('minio');

// Configuración de MinIO
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123'
});

const DEFAULT_BUCKET = process.env.MINIO_BUCKET || 'whatsapp-media';

/**
 * Inicializa el bucket de MinIo si no existe
 */
async function initBucket() {
    try {
        const exists = await minioClient.bucketExists(DEFAULT_BUCKET);
        if (!exists) {
            await minioClient.makeBucket(DEFAULT_BUCKET, 'us-east-1');
            console.log(`Bucket ${DEFAULT_BUCKET} creado exitosamente.`);
        }
    } catch (err) {
        console.error('Error inicializando MinIO Bucket:', err);
    }
}

/**
 * Calcula el hash SHA-256 de un archivo físico
 * @param {string} filePath - Ruta absoluta del archivo
 * @returns {Promise<string>} Hash hexadecimal del archivo
 */
function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', err => reject(err));
    });
}

/**
 * Sube un archivo a MinIO
 * @param {string} bucket - Nombre del bucket
 * @param {string} objectName - Ruta del archivo en S3
 * @param {string} filePath - Ruta local del archivo
 * @param {string} mimeType - Tipo Mime
 * @returns {Promise<void>}
 */
async function uploadToMinio(bucket, objectName, filePath, mimeType) {
    const metaData = {
        'Content-Type': mimeType,
    };
    return new Promise((resolve, reject) => {
        minioClient.fPutObject(bucket, objectName, filePath, metaData, function (err, objInfo) {
            if (err) return reject(err);
            resolve(objInfo);
        });
    });
}

/**
 * Genera una URL firmada válida temporalmente
 * @param {string} bucket - Nombre del bucket
 * @param {string} objectName - Ruta del archivo en S3
 * @param {number} expiryInSeconds - Tiempo de validez (ej. 3600 = 1 hr)
 * @returns {Promise<string>}
 */
async function getPresignedUrl(bucket, objectName, expiryInSeconds = 3600) {
    return new Promise((resolve, reject) => {
        minioClient.presignedGetObject(bucket, objectName, expiryInSeconds, function (err, presignedUrl) {
            if (err) return reject(err);
            resolve(presignedUrl);
        });
    });
}

/**
 * Obtiene un Readable Stream directamente desde MinIO
 * @param {string} bucket - Nombre del bucket
 * @param {string} objectName - Ruta del archivo en S3
 * @returns {Promise<ReadableStream>}
 */
async function getFileStream(bucket, objectName) {
    return new Promise((resolve, reject) => {
        minioClient.getObject(bucket, objectName, function (err, dataStream) {
            if (err) return reject(new Error(`MinIO Error [${err.code || 'UNKNOWN'}]: ${err.message}`));
            resolve(dataStream);
        });
    });
}

module.exports = {
    minioClient,
    initBucket,
    calculateFileHash,
    uploadToMinio,
    getPresignedUrl,
    getFileStream,
    DEFAULT_BUCKET
};

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../services/db');
const storage = require('../services/storage');

const router = express.Router();

// Configuración de Multer para almacenar temporalmente los archivos subidos al servidor VPS
const uploadDir = path.join(__dirname, '../../data/tmp_uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

/**
 * Middleware simulado de autenticación (a conectar con tu authMiddleware real)
 * Se asegura de que req.user exista.
 */
function authMiddleware(req, res, next) {
    // Si ya usas authMiddleware, puedes reemplazar esto
    if (!req.user) {
        // Mock user id solo para la estructura de prueba
        req.user = { id: '00000000-0000-0000-0000-000000000000' };
    }
    next();
}

/**
 * ENDPOINT: POST /api/media/process
 * Usado para recibir un archivo, calcular su hash y deduplicar en MinIO y PostgreSQL
 */
router.post('/process', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se envió ningún archivo' });
        }

        const filePath = req.file.path;
        const mimeType = req.file.mimetype;
        const size = req.file.size;

        // 1. Calcular el Hash SHA-256 del archivo
        const fileHash = await storage.calculateFileHash(filePath);

        // 2. Revisar si este archivo ya existe en nuestra Base de Datos
        const { rows } = await db.query('SELECT s3_object_key FROM stored_files WHERE file_hash = $1', [fileHash]);

        let s3ObjectKey;

        if (rows.length > 0) {
            // EL ARCHIVO YA EXISTE -> Reutilizar
            console.log("Archivo duplicado detectado, reutilizando almacenamiento.");
            s3ObjectKey = rows[0].s3_object_key;

            // Eliminar archivo temporal porque no lo necesitamos
            fs.unlinkSync(filePath);
        } else {
            // EL ARCHIVO ES NUEVO -> Subir a MinIO y guardar metadatos
            console.log("Archivo nuevo, subiendo a Minio...");
            s3ObjectKey = `${fileHash}`; // El nombre en MinIO será su hash

            await storage.initBucket();
            await storage.uploadToMinio(storage.DEFAULT_BUCKET, s3ObjectKey, filePath, mimeType);

            // Registrar archivo en la base de datos PostgreSQL
            await db.query(
                `INSERT INTO stored_files (file_hash, mime_type, size_bytes, s3_object_key) 
                 VALUES ($1, $2, $3, $4)`,
                [fileHash, mimeType, size, s3ObjectKey]
            );

            fs.unlinkSync(filePath); // Limpiar archivo temporal del disco VPS
        }

        res.json({
            success: true,
            fileHash,
            message: rows.length > 0 ? "Archivo reutilizado exitosamente." : "Media procesado exitosamente."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno procesando el archivo' });
    }
});

/**
 * ENDPOINT: GET /api/media/:hash
 * Usado por el frontend para solicitar acceso temporal a un archivo (Imagen, Video, Audio, Documento)
 */
router.get('/:hash', authMiddleware, async (req, res) => {
    try {
        const fileHash = req.params.hash;

        // Validar si la referencia existe en la BD
        const { rows } = await db.query('SELECT s3_object_key FROM stored_files WHERE file_hash = $1', [fileHash]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Archivo no encontrado' });
        }

        const s3ObjectKey = rows[0].s3_object_key;

        // Generar URL temporal firmada válida por 1 hora (3600 segundos)
        // El frontend debe usar esta URL en elementos <img>, <video>, <audio> o links de descarga <a>
        const presignedUrl = await storage.getPresignedUrl(storage.DEFAULT_BUCKET, s3ObjectKey, 3600);

        res.json({ url: presignedUrl });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error obteniendo acceso al archivo' });
    }
});

module.exports = router;

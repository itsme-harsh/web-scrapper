import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import scrape from 'website-scraper';
import fs from 'fs-extra';
import archiver from 'archiver';
import { URL } from 'url';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import keepAlive from "./keepAlive.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

const Oauth2client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);
Oauth2client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const drive = google.drive({
    version: 'v3',
    auth: Oauth2client
});

async function refreshAccessToken() {
    try {
        const { token } = await Oauth2client.getAccessToken();
        Oauth2client.setCredentials({ access_token: token });
    } catch (error) {
        console.error("Failed to refresh access token:", error);
    }
}

async function uploadToDrive(filePath, fileName) {
    await refreshAccessToken();

    const fileMetadata = {
        name: fileName,
        parents: [process.env.DRIVE_FOLDER_ID],
    };
    const media = {
        mimeType: 'application/zip',
        body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id',
    });

    // Make file accessible (optional)
    await drive.permissions.create({
        fileId: response.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
    });

    return response.data.id;
}

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/download', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.render('Error', { message: "Invalid URL!", string: 'Oops! Something went wrong while downloading the website. Please check the URL and try again.' });

    const baseDomain = new URL(url).hostname.replace('www.', '');
    const dir = path.join(__dirname, 'downloads', baseDomain);
    const zipPath = `${dir}.zip`;

    if (await fs.pathExists(dir)) await fs.remove(dir);

    try {
        // Scrape Website
        await scrape({
            urls: [url],
            directory: dir,
            recursive: true,
            urlFilter: (link) => link.includes(baseDomain),
            maxDepth: 2,
            request: {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            }
        });

        // Create ZIP Archive
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(zipPath);
        archive.pipe(output);
        archive.directory(dir, false);
        await archive.finalize();

        // Ensure ZIP file is created
        await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
        });

        // Upload ZIP to Google Drive
        const fileId = await uploadToDrive(zipPath, `${baseDomain}.zip`);

        // Delete local files after upload
        if (fileId) {
            await fs.remove(dir);
            await fs.remove(zipPath);
        }

        // Force Download from Google Drive
        console.log(`📥 Downloading file from Google Drive: ${fileId}`);

        const driveStream = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        // Set headers to force download
        res.setHeader('Content-Disposition', `attachment; filename="${baseDomain}.zip"`);
        res.setHeader('Content-Type', 'application/zip');
        
        // Set headers before piping, to avoid security warnings
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

        // Pipe the file stream from Google Drive to the response
        driveStream.data.pipe(res);

    } catch (error) {
        console.error("🚨 Error:", error);
        res.render('Error', { message: "Error downloading website!", string: "Oops! Something went wrong while downloading the website. Please check the URL and try again." });
    }
});


app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

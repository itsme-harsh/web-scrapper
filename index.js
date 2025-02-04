import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import scrape from 'website-scraper';
import fs from 'fs-extra';
import archiver from 'archiver';
import { URL } from 'url';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

// Google OAuth2 client setup using refresh token
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

// Refresh Google Drive access token using the refresh token
async function refreshAccessToken() {
    try {
        // Use the refresh token to get a new access token
        const { token } = await Oauth2client.getAccessToken(); 
        Oauth2client.setCredentials({ access_token: token });
        console.log('✅ Successfully refreshed access token');
    } catch (error) {
        console.error("❌ Failed to refresh access token:", error);
        throw error;
    }
}

// Upload ZIP file to Google Drive
async function uploadToDrive(filePath, fileName) {
    await refreshAccessToken();

    const fileMetadata = {
        name: fileName,
        parents: [process.env.DRIVE_FOLDER_ID],
    };

    const media = {
        mimeType: 'application/zip',
        body: fs.createReadStream(filePath)  // ✅ Stream file instead of loading it into memory
    };

    try {
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });

        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
        });

        console.log("✅ File uploaded to Drive:", response.data.id);
        return response.data.id;
    } catch (error) {
        console.error("❌ Google Drive upload failed:", error);
        throw error;
    }
}

// Function to create ZIP archive
async function createZip(dir, zipPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);  // ✅ Ensures ZIP is complete before uploading
        output.on('error', reject);

        archive.pipe(output);
        archive.directory(dir, false);
        archive.finalize();
    });
}

// Route for the homepage
app.get('/', (req, res) => {
    res.render('index');
});

// Route to start scraping and uploading
app.post('/download', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.render('Error', { message: "Invalid URL!" });

    const baseDomain = new URL(url).hostname.replace('www.', '');
    const dir = path.join(__dirname, 'downloads', baseDomain);
    const zipPath = `${dir}.zip`;

    // Ensure the download directory is empty before starting
    if (await fs.pathExists(dir)) await fs.remove(dir);

    try {
        // Scrape Website
        await scrape({
            urls: [url],
            directory: dir,
            recursive: true,
            maxDepth: 1,  // Reduce depth to avoid too many pages and large memory usage
            request: { headers: { "User-Agent": "Mozilla/5.0" } }
        });

        // Create ZIP archive
        await createZip(dir, zipPath);

        // Upload the ZIP file to Google Drive
        const fileId = await uploadToDrive(zipPath, `${baseDomain}.zip`);

        // Clean up local files after upload
        await fs.remove(dir);
        await fs.remove(zipPath);

        // Automatically download the file from Google Drive
        res.redirect(`https://drive.google.com/uc?id=${fileId}&export=download`);

    } catch (error) {
        console.error("❌ Error:", error);
        res.render('Error', { message: "Error downloading website!" });
    }
});

// Start the Express server
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

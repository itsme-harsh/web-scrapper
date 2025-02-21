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

// Set up OAuth2 Client
const Oauth2client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);

// Set credentials with refresh token
Oauth2client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const drive = google.drive({
    version: 'v3',
    auth: Oauth2client
});

// Refresh the access token before making any request
async function refreshAccessToken() {
    try {
        // Refresh the access token using the existing refresh token
        const { token } = await Oauth2client.getAccessToken();
        Oauth2client.setCredentials({ access_token: token });
        console.log("Access token refreshed.");
    } catch (error) {
        console.error("Failed to refresh access token:", error);
        if (error.response && error.response.status === 401) {
            console.error("Token expired or invalid. Re-authenticate.");
            // Generate the auth URL and redirect user for re-authentication
            const authUrl = Oauth2client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/drive.file'],
            });
            // Redirect the user to authUrl for re-authentication
            throw new Error(`Re-authenticate by visiting: ${authUrl}`);
        }
    }
}

// Upload file to Google Drive
async function uploadToDrive(filePath, fileName) {
    await refreshAccessToken();  // Ensure token is refreshed before each request

    const fileMetadata = {
        name: fileName,
        parents: [process.env.DRIVE_FOLDER_ID],
    };
    const media = {
        mimeType: 'application/zip',
        body: fs.createReadStream(filePath),
    };

    try {
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });

        // Make the uploaded file publicly accessible (optional)
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
        });

        return response.data.id;
    } catch (error) {
        console.error("Failed to upload to Drive:", error);
        throw error;
    }
}

// Handle requests
app.get('/', (req, res) => {
    res.render('index');
});

app.get("/keep-alive", async (req, res) => {
    res.json({ success: "true" });
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
        if (error.message && error.message.startsWith("Re-authenticate by visiting")) {
            const authUrl = error.message.replace("Re-authenticate by visiting: ", "");
            res.redirect(authUrl); // Redirect user to the Google auth URL for re-authentication
        } else {
            console.error("🚨 Error:", error);
            res.render('Error', { message: "Error downloading website!", string: "Oops! Something went wrong while downloading the website. Please check the URL and try again." });
        }
    }
});

// Handle OAuth callback
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code; // Get the code from the URL query
    try {
        // Exchange the authorization code for an access token and refresh token
        const { tokens } = await Oauth2client.getToken(code);
        Oauth2client.setCredentials(tokens); // Set the new tokens
        console.log("Authentication successful. Tokens refreshed.");

        res.send("Authentication successful. You can now use the application.");
    } catch (error) {
        console.error("Failed to exchange code for tokens:", error);
        res.send("Error during authentication.");
    }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

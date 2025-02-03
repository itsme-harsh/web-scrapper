import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import scrape from 'website-scraper';
import fs from 'fs-extra';
import archiver from 'archiver';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/download', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.render('Error',{message:"Invalid URL!",string:'Oops! Something went wrong while downloading the website. Please check the URL and try again.'});

    // Extract the domain name (for folder & zip naming)
    const baseDomain = new URL(url).hostname.replace('www.', ''); // Remove 'www.' if present
    
    
    const folderName = baseDomain; // Folder name like 'example-com'
    const dir = path.join(__dirname, 'downloads', folderName);
    if(await fs.pathExists(dir)) {
        // If the directory already exists, delete it
        await fs.remove(dir);
    }

    try {


        // Scrape the website
        await scrape({
            urls: [url],
            directory: dir,
            recursive: true,
            maxDepth: 2,
            urlFilter: (link) => link.includes(baseDomain),
            request: {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            }
        });

        // Create a stream for the zip file (without saving to disk)
        res.attachment(`${baseDomain}.zip`); // Tell the browser it's a file to be downloaded
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.pipe(res); // Stream the zip file directly to the response

        // Add the directory contents to the zip (without saving to disk)
        archive.directory(dir, false); 
        archive.finalize();

    } catch (error) {
        console.error("Scraping Error:", error);
        res.render('Error',{message:"Error downloading website!", string: "Oops! Something went wrong while downloading the website. Please check the URL and try again."});
    }
});

app.all('*', (req, res) => {
    res.render('Error',{message:"Page not found!", string: "We couldn't find the page you were looking for."});
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

// Test fetching the Play Store page and applying the same regex as the bot
// Run: node test_html_fetch.mjs
const appId = 'com.furkanhalici.promptpad';
const url = `https://play.google.com/store/apps/details?id=${appId}&hl=en_US&gl=US`;

const response = await fetch(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    }
});
console.log('Status:', response.status);
console.log('Content-Type:', response.headers.get('content-type'));

const htmlText = await response.text();
console.log('HTML length:', htmlText.length);
console.log('First 300 chars:', JSON.stringify(htmlText.substring(0, 300)));

// Apply same regexes as bot
const titleRegex = htmlText.match(/<title[^>]*>(.*?)<\/title>/i);
const rawTitle = (titleRegex?.[1] ?? appId).replace(' - Apps on Google Play', '').trim();

const devMatch = htmlText.match(/href="\/store\/apps\/dev\?id=[^"]+">([^<]+)<\/a>/);
const rawDev = devMatch?.[1]?.trim() ?? '';

const downloadsMatch = htmlText.match(/"([\d,]+\+)"/);
const downloads = (downloadsMatch && downloadsMatch[1].length < 15) ? downloadsMatch[1] : 'Unknown';

const ageMatch = htmlText.match(/"(Everyone|Teen|Mature 17\+|Everyone 10\+)"/);
const ageRating = ageMatch?.[1] ?? 'Unknown';

const updatedMatch = htmlText.match(/"([A-Z][a-z]{2} \d{1,2}, \d{4})"/);
const updated = updatedMatch?.[1] ?? 'Unknown';

console.log('\n--- Results ---');
console.log('Title:', rawTitle);
console.log('Developer:', rawDev);
console.log('Downloads:', downloads);
console.log('Age Rating:', ageRating);
console.log('Updated:', updated);

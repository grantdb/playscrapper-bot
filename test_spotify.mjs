// Test HTML scrape for Spotify (established app with lots of data in HTML)
const appId = 'com.spotify.music';
const url = `https://play.google.com/store/apps/details?id=${appId}&hl=en_US&gl=US`;

const response = await fetch(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
});
const htmlText = await response.text();
console.log('Status:', response.status, '| Length:', htmlText.length);

const titleRegex = htmlText.match(/<title[^>]*>(.*?)<\/title>/i);
console.log('Title:', (titleRegex?.[1] ?? '').replace(' - Apps on Google Play', '').trim());

const devIdMatch = htmlText.match(/"\/store\/apps\/developer\?id=([^"&\\]+)/) ||
    htmlText.match(/\/store\/apps\/developer\?id=([^"&<>\s\\]+)/);
console.log('Developer:', devIdMatch?.[1] ?? 'not found');

const downloadsMatch = htmlText.match(/"([\d,]+\+)"/);
console.log('Downloads:', (downloadsMatch && downloadsMatch[1].length < 15) ? downloadsMatch[1] : 'not found');

const ageMatch = htmlText.match(/"(Everyone|Teen|Mature 17\+|Everyone 10\+)"/);
console.log('Age Rating:', ageMatch?.[1] ?? 'not found');

const ratingMatch = htmlText.match(/\[null,null,"([0-5]\.[0-9])"\]/) ||
    htmlText.match(/"starRating":"([^"]+)"/) ||
    htmlText.match(/"averageRating":([0-9.]+)/);
console.log('Rating:', ratingMatch?.[1] ?? 'not found');

const updatedMatch = htmlText.match(/"([A-Z][a-z]{2} \d{1,2}, \d{4})"/);
console.log('Updated:', updatedMatch?.[1] ?? 'not found');

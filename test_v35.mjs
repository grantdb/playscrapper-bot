// Test the EXACT regexes used in v0.0.35 of main.ts against live Play Store HTML
const appId = 'com.furkanhalici.promptpad';
const url = `https://play.google.com/store/apps/details?id=${appId}&hl=en_US&gl=US`;

const response = await fetch(url);
const htmlText = await response.text();
console.log('Status:', response.status, '| Length:', htmlText.length);

// Exact regexes from v0.0.35 main.ts
const titleRegex = htmlText.match(/<title[^>]*>(.*?)<\/title>/i);
const rawTitle = (titleRegex?.[1] ?? appId).replace(' - Apps on Google Play', '').trim();

const devIdMatch = htmlText.match(/"\/store\/apps\/developer\?id=([^"&\\]+)/) ||
    htmlText.match(/\\\/store\\\/apps\\\/developer\?id(?:=|\\u003d)([^"&\\]+)/) ||
    htmlText.match(/\/store\/apps\/developer\?id=([^"&<>\s\\]+)/);
const rawDevFromUrl = devIdMatch?.[1] ? decodeURIComponent(devIdMatch[1].replace(/\+/g, ' ')) : '';

const devLinkMatch = htmlText.match(/href="\/store\/apps\/developer\?id=[^"]+">([^<]+)<\/a>/);
const devSchemaMatch = htmlText.match(/"author":\{"@type"[^}]+"name":"([^"]+)"/);
const rawDev = rawDevFromUrl || devLinkMatch?.[1]?.trim() || devSchemaMatch?.[1]?.trim() || '';


const downloadsMatch = htmlText.match(/"([\d,]+\+)"/);
const downloads = (downloadsMatch && downloadsMatch[1].length < 15) ? downloadsMatch[1] : 'Unknown';

const ageMatch = htmlText.match(/"(Everyone|Teen|Mature 17\+|Everyone 10\+)"/);
const ageRating = ageMatch?.[1] ?? 'Unknown';

const updatedMatch = htmlText.match(/"([A-Z][a-z]{2} \d{1,2}, \d{4})"/);
const updated = updatedMatch?.[1] ?? 'Unknown';

console.log('\n--- Results with v0.0.35 regexes ---');
console.log('Title:', rawTitle);
console.log('Developer (link match):', devLinkMatch?.[1] ?? 'none');
console.log('Developer (from URL regex):', rawDevFromUrl || 'none');
console.log('Developer (schema match):', devSchemaMatch?.[1] ?? 'none');
console.log('Developer (final):', rawDev || '(empty - will use Unknown Developer)');

console.log('Downloads:', downloads);
console.log('Age Rating:', ageRating);
console.log('Updated:', updated);

// Show surrounding context for developer link search
const devCtx = htmlText.match(/.{0,30}developer\?id[^"]{0,50}.{0,30}/g);
console.log('\nDeveloper URL fragments in HTML:', devCtx?.slice(0, 3) ?? 'none');

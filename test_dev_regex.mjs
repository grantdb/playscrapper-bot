// Find the developer link format
import { readFileSync } from 'fs';
const html = readFileSync('test_html.html', 'utf-16le');

// Try different patterns for the developer link
const patterns = [
    /href="\/store\/apps\/dev\?id=[^"]+">([^<]+)<\/a>/,
    /href="\/store\/apps\/dev[^"]*">([^<]+)<\/a>/,
    /"author":\{"@type"[^}]+"name":"([^"]+)"/,
    /itemprop="author"[^>]*>(.*?)<\/a>/,
    /"applicationCategory"[^,]+,"author":\{"[^}]+"name":"([^"]+)"/,
];

for (const p of patterns) {
    const m = html.match(p);
    console.log(p.toString().substring(0, 50) + '...', '->', m ? m[1] : 'no match');
}

// Show any dev links
const all = [...html.matchAll(/\/store\/apps\/dev[^"'> ]{0,50}/g)];
console.log('\nDev link fragments found:', all.slice(0, 3).map(m => m[0]));

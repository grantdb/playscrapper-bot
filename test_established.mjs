// Test Gemini call against an ESTABLISHED app to verify the bot would work for typical posts
// Run: node test_gemini_established.mjs
const apiKey = 'AIzaSyCs7RWnpJOMM0A5eC4KVbvlqNvslR0C3Vo'; // NOTE: regenerate this key!
const appId = 'com.spotify.music'; // Spotify - well-known, Gemini definitely knows it
const playStoreLink = `https://play.google.com/store/apps/details?id=${appId}`;

const prompt = `You are a helpful assistant that retrieves details about Android apps from the Google Play Store.

Please visit this exact URL and read the page to get the app details:
${playStoreLink}

Use your Google Search tool to search for and visit: "${playStoreLink}"

From the page, I need:
- The EXACT app title as it appears on the Play Store page (not guessed from the package name)
- The EXACT developer/publisher name shown on the page
- The star rating
- The download count
- The last updated date
- The content rating (e.g. Everyone, Teen)
- A brief 1-2 sentence description of what the app does

Return ONLY a raw JSON object with no markdown or backticks:
{
  "found": true or false,
  "title": "exact title from page",
  "developer": "exact developer name from page",
  "rating": "e.g. 4.5 or Unrated",
  "downloads": "e.g. 50M+ or Unknown",
  "updated": "e.g. Jan 15, 2025 or Unknown",
  "ageRating": "e.g. Everyone or Unknown",
  "description": "1-2 sentence description, max 250 chars"
}

If you cannot visit or find the page at all, return {"found": false}.`;

const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }]
    })
});

const data = await response.json();
const parts = data.candidates?.[0]?.content?.parts ?? [];
const text = parts.find(p => p.text)?.text ?? '{}';
const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
console.log('Gemini result for Spotify:');
console.log(JSON.parse(clean));

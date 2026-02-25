import { Devvit, SettingScope } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  http: true,
});

Devvit.addSettings([
  {
    name: 'gemini_api_key',
    label: 'Google Gemini API Key',
    type: 'string',
    isSecret: true,
    scope: SettingScope.Installation,
    helpText: 'Get a free API key from Google AI Studio (aistudio.google.com).',
  }
]);

Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    const post = await context.reddit.getPostById(event.post?.id!);
    const contentToSearch = `${post.url ?? ''} ${post.body ?? ''}`;
    const playStoreRegex = /id=([a-zA-Z0-9._]+)/;
    const match = contentToSearch.match(playStoreRegex);

    if (!match) return;

    const appId = match[1];

    try {
      console.log(`NEW PROJECT: Fetching details for ${appId} using Gemini...`);

      const apiKey = await context.settings.get('gemini_api_key');
      if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('Gemini API key is not configured in App Settings.');
      }

      const prompt = `You are a helpful assistant that retrieves details about Android apps from the Google Play Store.
I need the details for the app with the package ID: ${appId}

Please return ONLY a raw JSON object with no markdown formatting or backticks. The JSON object must have exactly these keys:
- "title": The name of the app
- "developer": The developer of the app
- "rating": The star rating out of 5 (e.g., "4.5", or "Unrated")
- "downloads": The approximate number of downloads (e.g., "50M+", or "Unknown")
- "updated": The date it was last updated (e.g., "Oct 12, 2023", or "Unknown")
- "ageRating": The content rating (e.g., "Everyone", "Teen")
- "description": A very brief, 1-2 sentence description of what the app does. Do not exceed 250 characters.

If you literally cannot find the app, return a JSON object with those keys populated with "Unknown" and a description stating the app could not be found.`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API Error: Status ${response.status}`);
      }

      const data = await response.json();

      // Parse the AI's response text (which should be just JSON)
      const aiResponseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      let appData;

      try {
        // Strip any residual markdown formatting the AI might have accidentally added
        const clenedText = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
        appData = JSON.parse(clenedText);
      } catch (parseError) {
        throw new Error(`Failed to parse Gemini response as JSON: ${aiResponseText}`);
      }

      const title = appData.title || appId;
      const developer = appData.developer || "Unknown Developer";
      const rating = appData.rating || "Unrated";
      const downloads = appData.downloads || "Unknown";
      const updatedOn = appData.updated || "Unknown";
      const ageRating = appData.ageRating || "Unknown";
      const description = appData.description || "No description available.";

      // Build the nicely formatted Markdown summary
      const commentBody = `### 📱 **${title}** by ${developer}\n\n` +
        `⭐ **Rating:** ${rating} | 📈 **Downloads:** ${downloads} | 📅 **Updated:** ${updatedOn} | 🔞 **Age Rating:** ${ageRating}\n\n` +
        `📝 **Summary:**\n> ${description}`;

      const comment = await context.reddit.submitComment({
        id: post.id,
        text: commentBody,
      });
      await comment.distinguish(true);

      console.log(`SUCCESS: Comment posted and stickied for ${title}.`);
    } catch (e) {
      console.error("CONNECTION/PROCESSING FAILED:", e);
    }
  },
});

export default Devvit;
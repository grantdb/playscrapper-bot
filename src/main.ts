import { Devvit, SettingScope } from '@devvit/public-api';
import * as cheerio from 'cheerio';

Devvit.configure({
  redditAPI: true,
  http: true,
});

Devvit.addSettings([
  {
    name: 'gemini_api_key',
    label: 'Google Gemini API Key',
    type: 'string',
    scope: SettingScope.Installation,
    helpText: 'Get a free API key from Google AI Studio (aistudio.google.com).',
  }
]);

async function processAppUrl(context: any, postId: string): Promise<{ success: boolean; message: string }> {
  const post = await context.reddit.getPostById(postId);
  // 1. Strip Markdown backslashes (Reddit escapes underscores as \_ which breaks regex)
  // 2. Decode content to handle encoded underscores (%5F) and other entities
  let contentToSearch = (post.body ?? '').replace(/\\/g, '');
  try {
    contentToSearch = decodeURIComponent(contentToSearch);
  } catch (e) {
    // Fallback if decoding fails (e.g. malformed sequence)
    console.log(`URL decoding failed for post ${postId}, using raw content.`);
  }

  // Refined regex: matches package ID segments (alphanumeric/underscore) separated by dots.
  // Package names must have at least two segments (e.g., com.example).
  const playStoreRegex = /(?:id=|testing\/)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/;
  let match = contentToSearch.match(playStoreRegex);

  // Fallback: If no link found in body/url (common with Image/Gallery posts), scan the author's comments
  if (!match) {
    try {
      const comments = await post.comments.all();
      for (const comment of comments) {
        if (comment.authorId === post.authorId) {
          contentToSearch += ` ${comment.body}`;
        }
      }
      match = contentToSearch.match(playStoreRegex);
    } catch (e) {
      console.log(`Failed to fetch comments for fallback scan: ${e}`);
    }
  }

  if (!match) {
    console.log(`No Play Store ID found for post ${postId} after scanning title, body and OP comments.`);
    return { success: false, message: 'No Play Store link or package ID found in the post content.' };
  }

  const appId = match[1];

  try {
    console.log(`NEW PROJECT: Fetching details for ${appId} using Gemini...`);

    const apiKey = await context.settings.get('gemini_api_key');
    if (!apiKey || typeof apiKey !== 'string') {
      throw new Error('Gemini API key is not configured in App Settings.');
    }

    const playStoreLink = `https://play.google.com/store/apps/details?id=${appId}`;
    const prompt = `You are a helpful assistant that retrieves details about Android apps from the Google Play Store.

Please search the web for the Android app exactly matching this package ID: "${appId}"

IMPORTANT: Try to find the official Google Play Store page first. 
If the official Play Store page is not found (often due to geo-restrictions or region locking), you MUST look for the app's metadata on trustworthy alternative databases like AppBrain or APKPure.

From your search results, you MUST extract:
- The EXACT app title as it appears on the Play Store page.
- The EXACT developer or publisher name. (Do not return "Unknown". Look hard in the search snippets for the creator's name).
- The star rating.
- The download count (e.g., 50M+, 1K+, or "New Release"). You MUST provide a download count. If the official Play Store search snippet is missing it (often due to geo-restrictions), search specifically for "[App Name] downloads" or "[App ID] installs" and check sites like APKPure, AppBrain, or similar APK databases for the estimate (e.g., 1M+, 5M+).
- The last updated date.
- The content rating (e.g., Everyone, Teen, PEGI 3).
- A brief 1-2 sentence description of what the app does.

Return ONLY a raw JSON object with no markdown or backticks:
{
  "found": true or false,
  "title": "exact title from page",
  "developer": "exact developer name from page",
  "rating": "e.g. 4.5 or Unrated",
  "downloads": "e.g. 50M+",
  "updated": "e.g. Jan 15, 2025",
  "ageRating": "e.g. Everyone",
  "description": "1-2 sentence description, max 250 chars"
}

If you cannot visit or find the page at all, return {"found": false}.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [
          {
            googleSearch: {}
          }
        ],
        generationConfig: {
          temperature: 0.1,
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API Error: Status ${response.status}`);
    }

    const data = await response.json();

    // When googleSearch tool is active, Gemini returns multiple parts.
    // Some parts are prose text, and the actual JSON may be in any part.
    // We try to parse each part as JSON and use the first one that succeeds.
    const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
    let aiResponseText = '{}';
    for (const part of parts) {
      const text = (part.text ?? '').replace(/```json/g, '').replace(/```/g, '').trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        aiResponseText = text;
        break;
      }
    }
    // If no part starts with { or [, fall back to last non-empty text part
    if (aiResponseText === '{}') {
      for (let i = parts.length - 1; i >= 0; i--) {
        const text = (parts[i].text ?? '').replace(/```json/g, '').replace(/```/g, '').trim();
        if (text.length > 0) { aiResponseText = text; break; }
      }
    }
    console.log(`Gemini raw response text (first 200 chars): ${aiResponseText.substring(0, 200)}`);
    let appData;

    try {
      // Strip any residual markdown formatting the AI might have accidentally added
      const cleanedText = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
      appData = JSON.parse(cleanedText);

      // Explicitly handle the edge case where Gemini returns an empty object {}
      // This happens when the search finds absolutely nothing and the model forgets the schema
      if (Object.keys(appData).length === 0) {
        appData = { found: false };
      }
    } catch (parseError) {
      throw new Error(`Failed to parse Gemini response as JSON: ${aiResponseText}`);
    }

    console.log(`Gemini result - found: ${appData.found}, developer: ${appData.developer ?? 'none'}, downloads: ${appData.downloads ?? 'none'}`);

    // Trigger HTML fallback if:
    // - Gemini found nothing OR is missing the developer (complete failure)
    // - OR Gemini found the app but is still missing key stats (downloads, updated, ageRating)
    const geminiFoundNothing = appData.found === false;
    const geminiMissingDeveloper = !appData.developer || appData.developer === "Unknown";
    const geminiMissingStats = !appData.downloads || appData.downloads === "Unknown" ||
      !appData.updated || appData.updated === "Unknown" ||
      !appData.ageRating || appData.ageRating === "Unknown";

    if (geminiFoundNothing || geminiMissingDeveloper || geminiMissingStats) {
      console.log(`Attempting HTML fallback for ${appId} (foundNothing=${geminiFoundNothing}, missingDev=${geminiMissingDeveloper}, missingStats=${geminiMissingStats})...`);

      const playStoreURL = `https://play.google.com/store/apps/details?id=${appId}&hl=en_US&gl=US`;
      let htmlResponse;
      try {
        htmlResponse = await fetch(playStoreURL, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          }
        });
      } catch (fetchErr) {
        console.log(`Fetch to play.google.com blocked by Devvit: ${fetchErr}`);
        // Mock a failed response so it falls down to the Beta Testing or Partial Data logic
        htmlResponse = { ok: false, status: 403, text: async () => '' } as any;
      }

      if (htmlResponse && !htmlResponse.ok) {
        // If still nothing from Gemini, post a beta notice
        if (geminiFoundNothing) {
          console.log(`Fallback failed (HTTP ${htmlResponse.status}). Treating as Beta/Testing app.`);
          const testingUrl = `https://play.google.com/apps/testing/${appId}`;
          const betaCommentBody = `### **Early Access / Beta Testing App**\n\n` +
            `It looks like this app is currently in **Early Access**, **Closed Testing**, or isn't publicly indexed on the Play Store yet.\n\n` +
            `**Want to help test this app?**\n` +
            `You may need to opt-in as a tester to download it. You can try the standard Play Store testing opt-in link below:\n\n` +
            `👉 **[Sign up to test this app](${testingUrl})**\n\n` +
            `*Note: App details such as developer, rating, and downloads cannot be verified for unpublished testing apps.*\n\n` +
            `---\n\n` +
            `*I am a bot. If you find an error, please contact the moderators of this subreddit.*`;
          const betaComment = await context.reddit.submitComment({ id: post.id, text: betaCommentBody });
          await betaComment.distinguish(true);
          console.log(`SUCCESS: Posted beta/testing fallback comment for ${appId}.`);
          return { success: true, message: 'App identified as Early Access/Beta. Testing link posted.' };
        }
        // Gemini had partial info — fall through and post with that
      }

      if (htmlResponse && htmlResponse.ok) {
        const htmlText = await htmlResponse.text();
        const $ = cheerio.load(htmlText);

        // Regex-based extraction works on raw HTML without JS rendering
        const titleRegex = htmlText.match(/<title[^>]*>(.*?)<\/title>/i);
        const rawTitleFromTag = (titleRegex?.[1] ?? '').replace(' - Apps on Google Play', '').trim();

        // Also try SoftwareApplication schema.org name which is more reliable
        const titleSchemaMatch = htmlText.match(/"name":"([^"]+)","description"/) ||
          htmlText.match(/"@type":"SoftwareApplication"[^}]{0,200}"name":"([^"]+)"/);
        const rawTitle = (rawTitleFromTag && rawTitleFromTag !== appId) ? rawTitleFromTag
          : (titleSchemaMatch?.[1] || '');

        // Extract developer from the URL parameter — most reliable, appears in all page variants
        // Handles both ?id=Name and \u003fid\u003dName (URL-encoded) and \u003d (encoded =)
        const devIdMatch = htmlText.match(/"\/store\/apps\/developer\?id=([^"&\\]+)/) ||
          htmlText.match(/\\\/store\\\/apps\\\/developer\?id(?:=|\\u003d)([^"&\\]+)/) ||
          htmlText.match(/\/store\/apps\/developer\?id=([^"&<>\s\\]+)/);
        const rawDevFromUrl = devIdMatch?.[1] ? decodeURIComponent(devIdMatch[1].replace(/\+/g, ' ')) : '';

        // Anchor text fallback (less reliable, may show personal account name)
        const devLinkMatch = htmlText.match(/href="\/store\/apps\/developer\?id=[^"]+"><span>([^<]+)<\/span><\/a>/);
        const rawDev = rawDevFromUrl || devLinkMatch?.[1]?.trim() || '';


        console.log(`HTML extracted - title: ${rawTitle}, devFromUrl: ${rawDevFromUrl}, devLinkText: ${devLinkMatch?.[1]}`);
        // HTML from the Play Store URL is the source of truth — always prefer over Gemini's guess
        if (rawTitle && rawTitle !== appId) {
          appData.title = rawTitle;  // e.g. "PromptVault AI Prompt Manager" beats Gemini's "PromptPad"
        }
        if (rawDev) {
          appData.developer = rawDev; // e.g. "PromptVault" beats Gemini's "Furkan Halici"
        }
        if (!appData.description || appData.description.includes("No description available")) {
          const descEl = $('div[data-g-id="description"]').first().text().trim();
          if (descEl) appData.description = descEl.substring(0, 250) + '...';
        }

        console.log(`After HTML override - title: ${appData.title}, dev: ${appData.developer}`);

        let rating = "Unrated";
        let downloads = "Unknown";
        let ageRating = "Unknown";

        // Regex parsing of embedded JSON data for fields that load dynamically
        const downloadsMatch = htmlText.match(/"([\d,]+\+)"/);
        if (downloadsMatch && downloadsMatch[1].length < 15) {
          downloads = downloadsMatch[1];
        }

        const ageMatch = htmlText.match(/"(Everyone|Teen|Mature 17\+|Everyone 10\+)"/);
        if (ageMatch) {
          ageRating = ageMatch[1];
        }

        // Find the most recent date in the HTML — the update date is typically the latest one
        const allDates = [...htmlText.matchAll(/"([A-Z][a-z]{2} \d{1,2}, \d{4})"/g)]
          .map(m => m[1]);
        let updatedDate = "Unknown";
        if (allDates.length > 0) {
          // Sort descending to get most recent date
          updatedDate = allDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
        }

        const wVqUob: string[] = [];
        $('div.wVqUob').each((i, el) => { wVqUob.push($(el).text().trim()); });

        for (const text of wVqUob) {
          if (text.includes('star')) {
            const match = text.match(/([\d.]+)star/);
            if (match) rating = match[1];
          } else if (text.includes('Downloads')) {
            downloads = text.replace('Downloads', '').trim();
          } else if (text.includes('info')) {
            ageRating = text.replace('info', '').trim();
          }
        }

        if (rating === "Unrated") {
          const altRating = $('div[itemprop="starRating"] > div.TT9eO').text() || $('div:contains("star")').first().text().match(/([\d.]+)star/)?.[1];
          // Try JSON extraction as absolute last resort
          const jsonRatingMatch = htmlText.match(/\[null,null,"([0-5]\.[0-9])"\]/);
          if (altRating) rating = altRating;
          else if (jsonRatingMatch) rating = jsonRatingMatch[1];
        }

        if (updatedDate === "Unknown") {
          const updatedDateText = $('div:contains("Updated on")').last().next().text() || $('div.xg1aie').text();
          if (updatedDateText && updatedDateText.length > 5 && updatedDateText.length < 25) {
            updatedDate = updatedDateText;
          }
        }

        // Only overwrite if missing or Unknown
        if (!appData.rating || appData.rating === "Unrated") appData.rating = rating;
        if (!appData.downloads || appData.downloads === "Unknown") appData.downloads = downloads;
        if (!appData.updated || appData.updated === "Unknown") appData.updated = updatedDate;
        if (!appData.ageRating || appData.ageRating === "Unknown") appData.ageRating = ageRating;

        console.log(`Fallback successful! Extracted basic details for ${appData.title}.`);
      }
    }

    const title = appData.title || appId;
    const developer = appData.developer || "Unknown Developer";
    const rating = appData.rating || "Unrated";
    // For confirmed apps, "Unknown" downloads just means it's too new — show "New Release"
    const downloads = (appData.downloads && appData.downloads !== "Unknown")
      ? appData.downloads
      : (appData.found !== false ? "New Release" : "Unknown");
    const updatedOn = appData.updated || "Unknown";
    const ageRating = appData.ageRating || "Unknown";
    const description = appData.description || "No description available.";

    // Abort if we have no real title (title is still the raw package ID) AND no developer
    // This means both Gemini and HTML scraping completely failed — don't post garbage
    if ((title === appId || !appData.title) && (developer === "Unknown Developer" || !appData.developer)) {
      console.log(`Aborting post for ${appId}: Could not extract any real app data. Title=${title}, Dev=${developer}`);
      return { success: false, message: 'Could not extract valid app details from the Play Store page.' };
    }

    // Build the comment body dynamically, omitting "Unknown" or "Unrated" fields
    let commentLines = [`### **${title}**\n`];

    if (developer !== "Unknown Developer") {
      commentLines.push(`* **Developer:** ${developer}`);
    }
    if (rating !== "Unrated") {
      commentLines.push(`* **Rating:** ${rating}`);
    }
    if (downloads !== "Unknown") {
      commentLines.push(`* **Downloads:** ${downloads}`);
    }
    if (updatedOn !== "Unknown") {
      commentLines.push(`* **Updated:** ${updatedOn}`);
    }
    if (ageRating !== "Unknown") {
      commentLines.push(`* **Content Rating:** ${ageRating}`);
    }

    const commentBody = commentLines.join('\n') +
      `\n\n**Description:**\n> ${description}\n\n` +
      `[📲 View on Google Play](${playStoreLink})\n\n` +
      `---\n\n` +
      `*I am a bot. If you find an error, please contact the moderators of this subreddit.*`;

    const comment = await context.reddit.submitComment({
      id: post.id,
      text: commentBody,
    });
    await comment.distinguish(true);

    console.log(`SUCCESS: Comment posted and stickied for ${title}.`);
    return { success: true, message: `Successfully scraped and posted details for ${title}!` };
  } catch (e) {
    console.error("CONNECTION/PROCESSING FAILED:", e);
    return { success: false, message: `An unexpected error occurred: ${e}` };
  }
}

Devvit.addSchedulerJob({
  name: 'process_post_delayed',
  onRun: async (event, context) => {
    if (event.data?.postId) {
      console.log(`Scheduled job running for post ${event.data.postId}`);
      await processAppUrl(context, event.data.postId as string);
    }
  },
});

Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    if (event.post?.id) {
      console.log(`New post ${event.post.id} detected. Scheduling scraper with 1-minute delay...`);
      await context.scheduler.runJob({
        name: 'process_post_delayed',
        data: { postId: event.post.id },
        runAt: new Date(Date.now() + 60000), // 1 minute delay
      });
    }
  },
});

Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event, context) => {
    // Only process if the mod action is approving a post
    if (event.action === 'approvelink' && event.targetPost?.id) {
      console.log(`Post ${event.targetPost.id} was approved. Processing immediately...`);
      // Run immediately because a human moderator intentionally approved it
      await processAppUrl(context, event.targetPost.id);
    }
  },
});

Devvit.addMenuItem({
  location: 'post',
  label: 'Trigger App Scraper',
  description: 'Manually run the scraper bot on this post',
  onPress: async (event, context) => {
    if (event.targetId) {
      console.log(`Manual trigger initiated for ${event.targetId}`);
      const result = await processAppUrl(context, event.targetId);
      if (result.success) {
        context.ui.showToast(result.message);
      } else {
        context.ui.showToast(`Scraper failed: ${result.message}`);
      }
    } else {
      context.ui.showToast('No post ID found.');
    }
  }
});

export default Devvit;
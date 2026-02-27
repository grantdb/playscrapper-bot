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

async function processAppUrl(context: any, postId: string, force: boolean = false): Promise<{ success: boolean; message: string }> {
  // 0. Deduplication & Locking
  const lockKey = `processing:${postId}`;
  const isLocked = await context.redis.get(lockKey);
  if (isLocked) {
    console.log(`Aborting: Post ${postId} is already being processed by another trigger.`);
    return { success: false, message: 'Already processing.' };
  }

  // Set a 2-minute lock to prevent race conditions between triggers
  await context.redis.set(lockKey, 'true', { expiration: new Date(Date.now() + 120000) });

  try {
    const post = await context.reddit.getPostById(postId);

    // Check if we already commented (safeguard against Job vs Trigger race)
    // Only skip if not forced (manual trigger)
    if (!force) {
      const existingComments = await post.comments.all();
      const botUser = await context.reddit.getAppUser();
      if (existingComments.find((cmt: any) => cmt.authorId === botUser.id)) {
        console.log(`Aborting: Bot already commented on ${postId}.`);
        return { success: true, message: 'Already handled.' };
      }
    }

    // 1. Strip Markdown backslashes (Reddit escapes underscores as \_ which breaks regex)
    // 2. Decode content to handle encoded underscores (%5F) and other entities
    let contentToSearch = (post.body ?? '').replace(/\\/g, '');
    try {
      contentToSearch = decodeURIComponent(contentToSearch);
    } catch (e) {
      console.log(`URL decoding failed for post ${postId}, using raw content.`);
    }

    // Refined regex: matches package ID segments (alphanumeric/underscore) separated by dots.
    const playStoreRegex = /(?:id=|testing\/)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/;
    let match = contentToSearch.match(playStoreRegex);

    // Fallback: If no link found in body/url, scan the author's comments
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
      return { success: false, message: 'No Play Store link or package ID found.' };
    }

    const appId = match[1];
    let appData: any = { title: appId, developer: "Unknown Developer", found: true };

    try {
      console.log(`NEW PROJECT: Fetching details for ${appId} using Gemini...`);
      const apiKey = await context.settings.get('gemini_api_key');
      if (!apiKey || typeof apiKey !== 'string') {
        throw new Error('Gemini API key is not configured.');
      }

      const playStoreLink = `https://play.google.com/store/apps/details?id=${appId}`;
      const prompt = `You are a helpful assistant that retrieves details about Android apps from the Google Play Store.

Please search the web for the Android app exactly matching this package ID: "${appId}"

CRITICAL: You MUST verify that the search results refer to the EXACT package ID "${appId}". 
DO NOT provide information for a different app even if the name is similar (e.g., if the user asks for "com.matedoro.app", do NOT return "Matadero Madrid" or "com.matadero.madrid"). 
If you find multiple similar results, prioritize the one that matches the package ID exactly in the URL or snippet.

IMPORTANT: Try to find the official Google Play Store page first. 
Some apps are in "Early Access" or "Beta" but are still publicly visible with download counts (e.g., 10+, 50+, 100+ downloads). You MUST extract details for these apps.

If you find an app that significantly matches the name or context of the request, return "found": true even if the package ID is not explicitly visible in the search snippet.

From your search results, you MUST extract:
- The EXACT app title.
- The Official Developer name (e.g., "adrisanchiner").
- The star rating (if available, else "Unrated").
- The exact download count if visible (e.g., "10+", "50+", "100+"). 
- The last updated date.
- The maturity rating (e.g., "Everyone", "Teen", "PEGI 3", "Rated for 3+").
- A brief 1-2 sentence description.

Return ONLY a raw JSON object with no markdown or backticks:
{
  "found": true or false,
  "title": "...",
  "developer": "...",
  "rating": "...",
  "downloads": "...",
  "updated": "...",
  "ageRating": "...",
  "description": "..."
}

If you find NO evidence of any app resembling this name or ID, return {"found": false}.`;

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
      const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
      let aiResponseText = '{}';
      for (const part of parts) {
        const text = (part.text ?? '').replace(/```json/g, '').replace(/```/g, '').trim();
        if (text.startsWith('{')) {
          aiResponseText = text;
          break;
        }
      }
      if (aiResponseText === '{}') {
        for (let i = parts.length - 1; i >= 0; i--) {
          const text = (parts[i].text ?? '').replace(/```json/g, '').replace(/```/g, '').trim();
          if (text.length > 0) { aiResponseText = text; break; }
        }
      }

      console.log(`Gemini raw response text (first 200 chars): ${aiResponseText.substring(0, 200)}`);

      try {
        const cleanedText = aiResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanedText);
        if (Object.keys(parsed).length > 0) {
          appData = { ...appData, ...parsed };
        }
      } catch (parseError) {
        console.log(`Failed to parse Gemini response as JSON: ${aiResponseText}`);
      }
      console.log(`Gemini result - found: ${appData.found}, title: ${appData.title}, developer: ${appData.developer}`);

      const geminiFoundNothing = appData.found === false;
      const geminiMissingStats = !appData.downloads || appData.downloads === "Unknown";

      if (geminiFoundNothing || geminiMissingStats) {
        console.log(`Attempting HTML fallback for ${appId}...`);

        const playStoreURL = `https://play.google.com/store/apps/details?id=${appId}&hl=en_US&gl=US`;
        let htmlResponse;
        try {
          htmlResponse = await fetch(playStoreURL, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            }
          });
        } catch (fetchErr) {
          htmlResponse = { ok: false, status: 403, statusText: "Blocked by Devvit" } as any;
        }

        if (htmlResponse && !htmlResponse.ok) {
          // Only post Beta notice if Gemini found ABSOLUTELY nothing (no title)
          if (geminiFoundNothing && (!appData.title || appData.title === appId)) {
            console.log(`Fallback failed (HTTP ${htmlResponse.status}). Treating as potential Beta/Testing app.`);
            const testingUrl = `https://play.google.com/apps/testing/${appId}`;
            const betaCommentBody = `### **Early Access / Indexed App**\n\n` +
              `It looks like this app is currently in **Early Access**, a **Closed Beta**, or its details are not yet fully available in our primary data sources.\n\n` +
              `**Want to try this app?**\n` +
              `You can find it on the Google Play Store using the link below. For some testing apps, you may need to opt-in as a tester first:\n\n` +
              `👉 **[View App on Play Store](https://play.google.com/store/apps/details?id=${appId})**\n` +
              `👉 **[Opt-in to testing](${testingUrl})**\n\n` +
              `*Note: Detailed ratings and download statistics may be hidden for unpublished or new testing apps.*\n\n` +
              `---\n\n` +
              `*I am a bot. If you find an error, please [contact the moderators](https://www.reddit.com/message/compose?to=/r/${post.subredditName}) of this subreddit.*`;
            const betaComment = await context.reddit.submitComment({ id: post.id, text: betaCommentBody });
            await betaComment.distinguish(true);
            return { success: true, message: 'App identified as Early Access/Beta. Meta-link posted.' };
          }
        }

        if (htmlResponse && htmlResponse.ok) {
          const htmlText = await htmlResponse.text();
          const $ = cheerio.load(htmlText);

          const titleTag = $('title').text().replace(' - Apps on Google Play', '').trim();
          if (titleTag && titleTag !== appId) {
            appData.title = titleTag;
          }

          const devIdMatch = htmlText.match(/\/store\/apps\/developer\?id=([^"&]+)/);
          if (devIdMatch) {
            appData.developer = decodeURIComponent(devIdMatch[1].replace(/\+/g, ' '));
          }

          const downloadsMatch = htmlText.match(/"([\d,]+\+)"/);
          if (downloadsMatch) {
            appData.downloads = downloadsMatch[1];
          }

          const ageMatch = htmlText.match(/"(Everyone|Teen|Mature 17\+|Everyone 10\+)"/);
          if (ageMatch) {
            appData.ageRating = ageMatch[1];
          }

          if (!appData.description || appData.description.includes("No description available")) {
            const descEl = $('div[data-g-id="description"]').first().text().trim();
            if (descEl) appData.description = descEl.substring(0, 250) + '...';
          }
        }
      }
    } catch (apiErr) {
      console.log(`Non-critical search error for ${appId}: ${apiErr}`);
    }

    const title = appData.title || appId;
    const developer = (appData.developer && !appData.developer.includes("Not specified") && !appData.developer.includes("Unknown")) ? appData.developer : "Unknown Developer";
    const rating = appData.rating || "Unrated";
    const downloads = (appData.downloads && !appData.downloads.includes("Not check") && !appData.downloads.includes("Not available")) ? appData.downloads : (appData.found !== false ? "New Release" : "Unknown");
    const updatedOn = appData.updated || "Unknown";
    const ageRating = appData.ageRating || "Unknown";
    const description = appData.description || "No description available.";

    if ((title === appId || !appData.title) && (developer === "Unknown Developer" || !appData.developer)) {
      console.log(`Aborting: Could not extract any real app data for ${appId}.`);
      return { success: false, message: 'Could not extract valid app details.' };
    }

    const commentLines = [`### **${title}**\n`];
    if (developer !== "Unknown Developer") commentLines.push(`* **Developer:** ${developer}`);
    if (rating !== "Unrated") commentLines.push(`* **Rating:** ${rating}`);
    if (downloads !== "Unknown") commentLines.push(`* **Downloads:** ${downloads}`);
    if (updatedOn !== "Unknown") commentLines.push(`* **Updated:** ${updatedOn}`);
    if (ageRating !== "Unknown") commentLines.push(`* **Content Rating:** ${ageRating}`);

    const playStoreLink = `https://play.google.com/store/apps/details?id=${appId}`;
    const commentBody = commentLines.join('\n') +
      `\n\n**Description:**\n> ${description}\n\n` +
      `[📲 View on Google Play](${playStoreLink})\n\n` +
      `---\n\n` +
      `*I am a bot. If you find an error, please [contact the moderators](https://www.reddit.com/message/compose?to=/r/${post.subredditName}) of this subreddit.*`;

    const comment = await context.reddit.submitComment({ id: post.id, text: commentBody });
    await comment.distinguish(true);

    console.log(`SUCCESS: Comment posted for ${title}.`);
    return { success: true, message: `Successfully posted details for ${title}!` };
  } catch (e: any) {
    if (e?.message?.includes('RATELIMIT')) {
      console.log(`Hit Reddit Rate Limit on ${postId}. Retrying in 6 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 6000));
      return await processAppUrl(context, postId);
    }
    console.error("CONNECTION/PROCESSING FAILED:", e);
    return { success: false, message: `An unexpected error occurred: ${e}` };
  } finally {
    await context.redis.del(lockKey);
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
    if (event.action === 'approvelink' && event.targetPost?.id) {
      console.log(`Post ${event.targetPost.id} was approved. Processing immediately...`);
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
      // Pass force: true to allow re-runs even if bot already commented
      const result = await processAppUrl(context, event.targetId, true);
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
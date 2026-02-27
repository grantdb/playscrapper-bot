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

async function processAppUrl(context: any, postId: string): Promise<boolean> {
  const post = await context.reddit.getPostById(postId);
  let contentToSearch = `${post.url ?? ''} ${post.body ?? ''}`;

  const playStoreRegex = /(?:id=|testing\/)([a-zA-Z0-9._]+)/;
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
    console.log(`No Play Store ID found for post ${postId} after scanning body and OP comments.`);
    return false;
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

I need the details for this app:
- Package ID: ${appId}
- Play Store URL: ${playStoreLink}

IMPORTANT: This may be a brand-new or recently released app. Please use your Google Search tool to:
1. Search for the exact Play Store URL: ${playStoreLink}
2. Also try searching for the package ID: "${appId}"

Please return ONLY a raw JSON object with no markdown formatting or backticks. The JSON object must have exactly these keys:
- "found": A boolean true or false indicating if you could find information about this app.
- "title": The name of the app (if found)
- "developer": The developer or company name (if found)
- "rating": The star rating out of 5 (e.g., "4.5", or "Unrated")
- "downloads": The approximate number of downloads (e.g., "50M+", or "Unknown")
- "updated": The date it was last updated (e.g., "Oct 12, 2023", or "Unknown")
- "ageRating": The content rating (e.g., "Everyone", "Teen")
- "description": A very brief, 1-2 sentence description of what the app does. Do not exceed 250 characters.

If you absolutely cannot find any information about this app, return {"found": false}.`;

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
        if (geminiFoundNothing) {
          console.log("Both Gemini and HTML fallback failed. Aborting silently.");
          return false;
        }
        // Gemini had partial data — continue and post what we have
        console.log("HTML blocked but Gemini has partial data — will post with that.");
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
            `*Note: App details such as developer, rating, and downloads cannot be verified for unpublished testing apps.*`;
          const betaComment = await context.reddit.submitComment({ id: post.id, text: betaCommentBody });
          await betaComment.distinguish(true);
          console.log(`SUCCESS: Posted beta/testing fallback comment for ${appId}.`);
          return true;
        }
        // Gemini had partial info — fall through and post with that
      }

      if (htmlResponse && htmlResponse.ok) {
        const htmlText = await htmlResponse.text();
        const $ = cheerio.load(htmlText);

        // Regex-based extraction works on raw HTML without JS rendering
        const titleRegex = htmlText.match(/<title[^>]*>(.*?)<\/title>/i);
        const rawTitle = (titleRegex?.[1] ?? appId).replace(' - Apps on Google Play', '').trim();

        // Play Store uses /store/apps/developer?id= with developer name in a nested <span>
        // Also try schema.org JSON-LD author field as fallback
        const devLinkMatch = htmlText.match(/href="\/store\/apps\/developer\?id=[^"]+"><span>([^<]+)<\/span><\/a>/) ||
          htmlText.match(/href="\/store\/apps\/developer\?id=[^"]+">([^<]+)<\/a>/);
        const devSchemaMatch = htmlText.match(/"author":\{"@type"[^}]+"name":"([^"]+)"/);
        const rawDev = devLinkMatch?.[1]?.trim() || devSchemaMatch?.[1]?.trim() || '';

        console.log(`HTML extracted - title: ${rawTitle}, devLink: ${devLinkMatch?.[1]}, devSchema: ${devSchemaMatch?.[1]}`);
        if (!appData.title || appData.title === appId) {
          appData.title = rawTitle || $('h1').first().text().trim() || appId;
        }
        if (!appData.developer || appData.developer === "Unknown" || appData.developer === "Unknown Developer") {
          appData.developer = rawDev || $('a.VtfRFb').first().text().trim() || "Unknown Developer";
        }
        if (!appData.description || appData.description.includes("No description available")) {
          const descEl = $('div[data-g-id="description"]').first().text().trim();
          if (descEl) appData.description = descEl.substring(0, 250) + '...';
        }

        console.log(`HTML regex extracted - title: ${rawTitle}, dev: ${rawDev}`);

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

        const updatedMatch = htmlText.match(/"([A-Z][a-z]{2} \d{1,2}, \d{4})"/);
        let updatedDate = "Unknown";
        if (updatedMatch) {
          updatedDate = updatedMatch[1];
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
      return false;
    }

    const commentBody = `### **${title}**\n\n` +
      `* **Developer:** ${developer}\n` +
      `* **Rating:** ${rating}\n` +
      `* **Downloads:** ${downloads}\n` +
      `* **Updated:** ${updatedOn}\n` +
      `* **Content Rating:** ${ageRating}\n\n` +
      `**Description:**\n> ${description}\n\n` +
      `[📲 View on Google Play](${playStoreLink})`;

    const comment = await context.reddit.submitComment({
      id: post.id,
      text: commentBody,
    });
    await comment.distinguish(true);

    console.log(`SUCCESS: Comment posted and stickied for ${title}.`);
    return true;
  } catch (e) {
    console.error("CONNECTION/PROCESSING FAILED:", e);
    return false;
  }
}

// Removed scheduler job process_post_delayed

Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    if (event.post?.id) {
      console.log(`New post ${event.post.id} detected. Processing immediately...`);
      await processAppUrl(context, event.post.id);
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
      const success = await processAppUrl(context, event.targetId);
      if (success) {
        context.ui.showToast('App details scraper task has been triggered and posted!');
      } else {
        context.ui.showToast('Could not find app details or scraping was blocked by restrictions.');
      }
    } else {
      context.ui.showToast('No post ID found.');
    }
  }
});

export default Devvit;
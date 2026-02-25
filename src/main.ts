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

async function processAppUrl(context: any, postId: string) {
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
    return;
  }

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
- "found": A boolean true or false indicating if you could find information about this app.
- "title": The name of the app (if found)
- "developer": The developer of the app (if found)
- "rating": The star rating out of 5 (e.g., "4.5", or "Unrated")
- "downloads": The approximate number of downloads (e.g., "50M+", or "Unknown")
- "updated": The date it was last updated (e.g., "Oct 12, 2023", or "Unknown")
- "ageRating": The content rating (e.g., "Everyone", "Teen")
- "description": A very brief, 1-2 sentence description of what the app does. Do not exceed 250 characters.

If you cannot find the app via search or your memory, simply return {"found": false}.`;

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

    // Check if the app was actually found
    if (appData.found === false) {
      console.log(`App ID ${appId} could not be found by Gemini. Attempting direct HTML scrape fallback...`);

      const playStoreURL = `https://play.google.com/store/apps/details?id=${appId}&hl=en_US&gl=US`;
      const htmlResponse = await fetch(playStoreURL);

      if (!htmlResponse.ok) {
        console.log(`Fallback failed. App ${appId} returned HTTP ${htmlResponse.status}. Treating as Beta/Testing app.`);

        let testingUrl = `https://play.google.com/apps/testing/${appId}`;

        const betaCommentBody = `### **Early Access / Beta Testing App**\n\n` +
          `It looks like this app is currently in **Early Access**, **Closed Testing**, or isn't publicly indexed on the Play Store yet.\n\n` +
          `**Want to help test this app?**\n` +
          `You may need to opt-in as a tester to download it. You can try the standard Play Store testing opt-in link below:\n\n` +
          `👉 **[Sign up to test this app](${testingUrl})**\n\n` +
          `*Note: App details such as developer, rating, and downloads cannot be verified for unpublished testing apps.*`;

        const betaComment = await context.reddit.submitComment({
          id: post.id,
          text: betaCommentBody,
        });
        await betaComment.distinguish(true);
        console.log(`SUCCESS: Posted beta/testing fallback comment for ${appId}.`);
        return;
      }

      const htmlText = await htmlResponse.text();
      const $ = cheerio.load(htmlText);

      appData.title = $('h1').first().text().trim() || appId;
      appData.developer = $('div:contains("Offered By"), a[href*="/store/apps/dev"]').first().text().trim() || $('a.VtfRFb').first().text().trim() || "Unknown Developer";
      appData.description = $('div[data-g-id="description"]').first().text().trim().substring(0, 250) + '...' || "No description available.";

      let rating = "Unrated";
      let downloads = "Unknown";
      let ageRating = "Unknown";

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
        if (altRating) rating = altRating;
      }

      const updatedDateText = $('div:contains("Updated on")').last().next().text() || $('div.xg1aie').text();
      let updatedDate = "Unknown";
      if (updatedDateText && updatedDateText.length > 5 && updatedDateText.length < 25) {
        updatedDate = updatedDateText;
      }

      appData.rating = rating;
      appData.downloads = downloads;
      appData.updated = updatedDate;
      appData.ageRating = ageRating;

      console.log(`Fallback successful! Extracted basic details for ${appData.title}.`);
    }

    const title = appData.title || appId;
    const developer = appData.developer || "Unknown Developer";
    const rating = appData.rating || "Unrated";
    const downloads = appData.downloads || "Unknown";
    const updatedOn = appData.updated || "Unknown";
    const ageRating = appData.ageRating || "Unknown";
    const description = appData.description || "No description available.";

    const commentBody = `### **${title}**\n\n` +
      `* **Developer:** ${developer}\n` +
      `* **Rating:** ${rating}\n` +
      `* **Downloads:** ${downloads}\n` +
      `* **Updated:** ${updatedOn}\n` +
      `* **Content Rating:** ${ageRating}\n\n` +
      `**Description:**\n> ${description}`;

    const comment = await context.reddit.submitComment({
      id: post.id,
      text: commentBody,
    });
    await comment.distinguish(true);

    console.log(`SUCCESS: Comment posted and stickied for ${title}.`);
  } catch (e) {
    console.error("CONNECTION/PROCESSING FAILED:", e);
  }
}

Devvit.addSchedulerJob({
  name: 'process_post_delayed',
  onRun: async (event, context) => {
    if (event.data && typeof event.data.postId === 'string') {
      const postId = event.data.postId as string;
      const post = await context.reddit.getPostById(postId);

      // Check if the post was removed by Reddit's filters or AutoModerator
      // during the delay window before we attempt to process it.
      if (post.isRemoved() || post.isSpam()) {
        console.log(`Post ${postId} was removed or marked as spam. Skipping Gemini processing.`);
        return;
      }

      console.log(`Delay finished for post ${postId}. Ready to process...`);
      await processAppUrl(context, postId);
    }
  },
});

Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    if (event.post?.id) {
      console.log(`New post ${event.post.id} detected. Scheduling delayed check in 1 minute...`);
      // Schedule the job to run 1 minute from now
      await context.scheduler.runJob({
        name: 'process_post_delayed',
        data: { postId: event.post.id },
        runAt: new Date(Date.now() + 60 * 1000), // + 1 minute
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
      await processAppUrl(context, event.targetId);
      context.ui.showToast('App details scraper task has been triggered!');
    } else {
      context.ui.showToast('No post ID found.');
    }
  }
});

export default Devvit;
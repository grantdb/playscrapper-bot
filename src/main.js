import { Devvit } from '@devvit/public-api';
Devvit.configure({
    redditAPI: true,
    http: true,
});
Devvit.addTrigger({
    event: 'PostSubmit',
    onEvent: async (event, context) => {
        const post = await context.reddit.getPostById(event.post?.id);
        const contentToSearch = `${post.url ?? ''} ${post.body ?? ''}`;
        const playStoreRegex = /id=([a-zA-Z0-9._]+)/;
        const match = contentToSearch.match(playStoreRegex);
        if (!match)
            return;
        const appId = match[1];
        const token = 'a9fa089cd5904586b66db6fbf2341595cb5326d9bf7';
        const targetUrl = encodeURIComponent(`https://play.google.com/store/apps/details?id=${appId}`);
        const apiUrl = `https://api.scrape.do/?token=${token}&url=${targetUrl}`;
        try {
            console.log(`NEW PROJECT: Fetching ${appId}...`);
            const response = await fetch(apiUrl);
            if (!response.ok)
                throw new Error(`Status: ${response.status}`);
            const html = await response.text();
            // Extract data using regex
            const titleMatch = html.match(/<title>(.*?) - Apps on Google Play<\/title>/);
            let title = titleMatch ? titleMatch[1] : appId;
            // Decode entities minimally if needed, though most titles might be okay.
            const devMatch = html.match(/href="\/store\/apps\/dev\?id=[^"]+"><span>([^<]+)<\/span>/);
            const developer = devMatch ? devMatch[1] : "Unknown Developer";
            const ratingMatch = html.match(/aria-label="Rated ([0-9.]+) stars out of five/);
            const rating = ratingMatch ? ratingMatch[1] : "Unrated";
            const downloadsMatch = html.match(/<div class="[^"]+">([^<]+)<\/div><div class="[^"]+">Downloads<\/div>/) ||
                html.match(/<div>([^<]+)\+<\/div><div>Downloads<\/div>/) ||
                html.match(/>([^<]+)\+?<\/div>[^<]*<div[^>]*>Downloads<\/div>/);
            const downloads = downloadsMatch ? downloadsMatch[1] : "Unknown";
            const updatedMatch = html.match(/<div class="[^"]+">Updated on<\/div><div class="[^"]+">([^<]+)<\/div>/) ||
                html.match(/>Updated on<\/div>[^<]*<div[^>]*>([^<]+)<\/div>/);
            const updatedOn = updatedMatch ? updatedMatch[1] : "Unknown";
            const ageMatch = html.match(/itemprop="contentRating"><span>([^<]+)<\/span>/) ||
                html.match(/"contentRating"><span>([^<]+)<\/span>/);
            const ageRating = ageMatch ? ageMatch[1] : "Everyone";
            const descMatch = html.match(/<meta name="description" content="(.*?)"/);
            let description = descMatch ? descMatch[1] : "No description available.";
            // Clean up description (decode some basic HTML entities and truncate)
            description = description.replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, "&");
            if (description.length > 250) {
                description = description.substring(0, 247) + "...";
            }
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
        }
        catch (e) {
            console.error("CONNECTION FAILED:", e);
        }
    },
});
export default Devvit;

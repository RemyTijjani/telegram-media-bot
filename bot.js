const dotenv = require('dotenv');
dotenv.config();

const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { downloadMedia } = require('./services/socialDownloader');
const { searchMovies, getMovieDetails, searchPerson, getPersonCredits } = require('./services/tmdb');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==========================================
// 📢 FORCE-JOIN CHANNEL MIDDLEWARE
// ==========================================
const CHANNEL_USERNAME = '@EMPTYMOVIEBOX';

bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private' || !ctx.message?.text || ctx.message.text.startsWith('/start')) {
    return next();
  }

  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
    const isSubscribed = ['creator', 'administrator', 'member'].includes(member.status);

    if (!isSubscribed) {
      const channelLink = `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`;
      
      return ctx.reply(
        `⚠️ *Access Restricted!*\n\nTo use this bot, you must be a member of our official channel.\n\nPlease join ${CHANNEL_USERNAME} and search again!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url('📢 Join Channel First', channelLink)]
          ])
        }
      );
    }
  } catch (err) {
    console.error('Force-join check error:', err);
  }

  return next();
});

// ==========================================
// 🛠️ AUTOMATIC BOT PROFILE & COMMAND SETUP
// ==========================================
async function setupBotProfile() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🚀 Start the bot & view main menu' },
      { command: 'help', description: '❓ Get help and usage instructions' },
      { command: 'latest', description: '🔥 View trending movies & series' }
    ]);

    await bot.telegram.setMyDescription(
      "🎬 Search, stream online, and download HD movies & TV series directly inside Telegram!\n\nFast streams & high-speed direct downloads."
    );

    await bot.telegram.setMyShortDescription(
      "🍿 Watch and download movies & TV series inside Telegram."
    );

    console.log("✅ Bot commands & profile setup complete!");
  } catch (error) {
    console.error("⚠️ Failed to set bot commands/description:", error);
  }
}

setupBotProfile();

const startMessage = [
  '🎬 Welcome to ReelGrab.',
  '',
  'Type a movie or TV title for a cinematic info card.',
  'Send a movie poster or screenshot for AI visual identification and download links!',
  '',
  'Please only download and share content you have permission to use.'
].join('\n');

bot.start((ctx) => ctx.reply(startMessage));
bot.command('help', (ctx) => ctx.reply(startMessage));

// ==========================================
// 🍿 HELPER FUNCTION TO RENDER PAGINATED RESULTS
// ==========================================
async function renderPageResults(ctx, searchQuery, pageNum = 1, isCallback = false) {
  const itemsPerPage = 5;
  const tmdbPage = Math.ceil((pageNum * itemsPerPage) / 20);
  const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}&page=${tmdbPage}`;

  const { data } = await axios.get(tmdbUrl);
  const rawResults = data.results || [];
  const validResults = rawResults.filter(item => item.media_type === 'movie' || item.media_type === 'tv');

  const totalResults = data.total_results || validResults.length;
  const totalPages = Math.ceil(totalResults / itemsPerPage) || 1;

  if (validResults.length === 0) {
    if (isCallback) await ctx.answerCbQuery('No more results found.');
    else {
      const encodedQuery = encodeURIComponent(searchQuery);
      const fallbackButtons = Markup.inlineKeyboard([
        [Markup.button.url('📥 Download Server 1', `https://loadedfiles.net/?s=${encodedQuery}`)],
        [Markup.button.url('📥 Download Server 2', `https://meetdownload.com/?q=${encodedQuery}`)],
        [Markup.button.url('📥 Download Server 3', `https://videodownloader.site/?q=${encodedQuery}`)]
      ]);

      await ctx.reply(
        `🎬 *Search Results for "${searchQuery}":*\n\n*Overview:*\nRequested title processed via download servers. Click below to download or search your title on the platforms.`,
        { parse_mode: 'Markdown', ...fallbackButtons }
      );
    }
    return;
  }

  const indexOnTmdbPage = ((pageNum - 1) % 4) * itemsPerPage;
  const pageItems = validResults.slice(indexOnTmdbPage, indexOnTmdbPage + itemsPerPage);

  await ctx.reply(`🔎 *Found ${totalResults} result(s) for "${searchQuery}" (Page ${pageNum} of ${totalPages}):*`, {
    parse_mode: 'Markdown'
  });

  for (const item of pageItems) {
    try {
      const mediaType = item.media_type;
      const details = await getMovieDetails(item.id, mediaType);
      if (!details) continue;

      const title = details.title || details.name || 'Unknown Title';
      const releaseDate = details.release_date || details.first_air_date || '';
      const year = releaseDate ? ` (${releaseDate.split('-')[0]})` : '';
      const rating = details.vote_average ? `⭐ ${details.vote_average.toFixed(1)}/10` : '⭐ N/A';
      const overview = details.overview ? details.overview.slice(0, 250) + '...' : 'No description available.';

      const queryEncoded = encodeURIComponent(title);

      const buttonRows = [
        [Markup.button.url('📥 Download Server 1', `https://loadedfiles.net/?s=${queryEncoded}`)],
        [Markup.button.url('📥 Download Server 2', `https://meetdownload.com/?q=${queryEncoded}`)],
        [Markup.button.url('📥 Download Server 3', `https://videodownloader.site/?q=${queryEncoded}`)],
        [Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/${mediaType === 'tv' ? 'tv' : 'movie'}/${details.id}`)]
      ];

      const actionButtons = Markup.inlineKeyboard(buttonRows);
      const caption = `🎬 *${title}*${year} [${mediaType.toUpperCase()}]\n${rating}\n\n📝 *Overview:*\n${overview}`;

      if (details.poster_path) {
        await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${details.poster_path}`, {
          caption: caption,
          parse_mode: 'Markdown',
          ...actionButtons
        });
      } else {
        await ctx.reply(caption, { parse_mode: 'Markdown', ...actionButtons });
      }
    } catch (err) {
      console.error(`Error loading item ID ${item.id}:`, err);
    }
  }

  const navButtons = [];
  if (pageNum > 1) {
    navButtons.push(Markup.button.callback('◀️ Previous', `page_${pageNum - 1}_${encodeURIComponent(searchQuery)}`));
  }
  navButtons.push(Markup.button.callback(`📄 Page ${pageNum}/${totalPages}`, 'noop'));
  if (pageNum < totalPages) {
    navButtons.push(Markup.button.callback('Next ▶️', `page_${pageNum + 1}_${encodeURIComponent(searchQuery)}`));
  }

  await ctx.reply(`Navigation for *"${searchQuery}"*:`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([navButtons])
  });
}

// ==========================================
// 🔍 HANDLE USER TEXT SEARCHES
// ==========================================
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  const searchQuery = ctx.message.text.trim();

  try {
    await ctx.replyWithChatAction('typing');
    await renderPageResults(ctx, searchQuery, 1, false);
  } catch (error) {
    console.error('Search Error:', error);
    ctx.reply('⚠️ Something went wrong while searching. Please try again.');
  }
});

// ==========================================
// 🔄 HANDLE PAGINATION CLICK
// ==========================================
bot.action(/^page_(\d+)_(.+)$/, async (ctx) => {
  const targetPage = parseInt(ctx.match[1], 10);
  const searchQuery = decodeURIComponent(ctx.match[2]);

  try {
    await ctx.answerCbQuery(`Loading Page ${targetPage}...`);
    await ctx.replyWithChatAction('typing');
    await renderPageResults(ctx, searchQuery, targetPage, true);
  } catch (error) {
    console.error('Pagination Callback Error:', error);
    await ctx.answerCbQuery('⚠️ Failed to load page.');
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// ==========================================
// 🆕 /LATEST COMMAND (FIXED & HIGH-SPEED)
// ==========================================
bot.command('latest', async (ctx) => {
  try {
    await ctx.replyWithChatAction('typing');

    // Use TMDB trending movie endpoint with 4s timeout
    const tmdbUrl = `https://api.themoviedb.org/3/trending/all/day?api_key=${process.env.TMDB_API_KEY}`;
    const { data } = await axios.get(tmdbUrl, { timeout: 4000 });
    
    const results = (data.results || [])
      .filter(item => item.media_type === 'movie' || item.media_type === 'tv' || item.title || item.name)
      .slice(0, 5);

    if (!results || results.length === 0) {
      return ctx.reply('⚠️ No new releases found at the moment.');
    }

    await ctx.reply('🔥 *Latest Trending Movies & Series Releases:*', { parse_mode: 'Markdown' });

    for (const item of results) {
      try {
        const isTv = item.media_type === 'tv' || (!item.title && item.name);
        const mediaType = isTv ? 'tv' : 'movie';
        const title = item.title || item.name || 'Unknown Title';
        const releaseDate = item.release_date || item.first_air_date || '';
        const year = releaseDate ? ` (${releaseDate.split('-')[0]})` : '';
        const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '⭐ N/A';
        const overview = item.overview ? item.overview.slice(0, 200) + '...' : 'No description available.';

        const queryEncoded = encodeURIComponent(title);

        const actionButtons = Markup.inlineKeyboard([
          [Markup.button.url('📥 Download Server 1', `https://loadedfiles.net/?s=${queryEncoded}`)],
          [Markup.button.url('📥 Download Server 2', `https://meetdownload.com/?q=${queryEncoded}`)],
          [Markup.button.url('📥 Download Server 3', `https://videodownloader.site/?q=${queryEncoded}`)],
          [Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/${mediaType}/${item.id}`)]
        ]);

        const caption = `🎬 *${title}*${year} [${mediaType.toUpperCase()}]\n${rating}\n\n📝 *Overview:*\n${overview}`;

        if (item.poster_path) {
          await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, {
            caption,
            parse_mode: 'Markdown',
            ...actionButtons
          });
        } else {
          await ctx.reply(caption, { parse_mode: 'Markdown', ...actionButtons });
        }
      } catch (itemError) {
        console.error('Error rendering individual latest item:', itemError);
      }
    }
  } catch (error) {
    console.error('Error fetching latest updates:', error?.response?.data || error.message);
    ctx.reply('⚠️ Failed to load latest releases. Please try again.');
  }
});

// ==========================================
// ⚡ LIGHTNING-FAST AI VISUAL MOVIE SEARCH
// ==========================================
bot.on('photo', async (ctx) => {
  const startTime = Date.now();
  try {
    // Grab the smallest compressed thumbnail from Telegram for instant downloading
    const photoArray = ctx.message.photo;
    const targetPhoto = photoArray[0]; 
    const file = await ctx.telegram.getFile(targetPhoto.file_id);
    const photoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    // Fast buffer download with a strict 3-second timeout
    const imageResponse = await axios.get(photoUrl, { responseType: 'arraybuffer', timeout: 3000 });
    const imageBuffer = Buffer.from(imageResponse.data);

    const prompt = 'Identify the movie or TV series in this image. Return ONLY a JSON object: {"query": "Movie Name"}. If unknown: {"query": null}.';

    // Fast AI analysis using Gemini 3.8 Flash
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBuffer.toString('base64')
          }
        },
        prompt
      ]
    });

    const aiOutput = response.text.trim().replace(/```json|```/g, '');
    let result = { query: null };

    try {
      result = JSON.parse(aiOutput);
    } catch (e) {
      result.query = response.text.trim();
    }

    const searchQuery = result.query;

    if (!searchQuery || searchQuery.toLowerCase() === 'null') {
      return ctx.reply('⚠️ Sorry, I could not identify any movie or series in this photo.');
    }

    // Direct TMDB search query lookup
    const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}`;
    const tmdbRes = await axios.get(tmdbUrl, { timeout: 3000 });
    const item = (tmdbRes.data.results || [])[0];

    if (!item) {
      return ctx.reply(`⚠️ Identified *${searchQuery}*, but no records were found.`);
    }

    const title = item.title || item.name || 'Unknown Title';
    const releaseDate = item.release_date || item.first_air_date || '';
    const year = releaseDate ? ` (${releaseDate.split('-')[0]})` : '';
    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '⭐ N/A';
    const overview = item.overview ? item.overview.slice(0, 130) + '...' : 'No description available.';

    const queryEncoded = encodeURIComponent(title);

    const actionButtons = Markup.inlineKeyboard([
      [Markup.button.url('📥 Download Server 1', `https://loadedfiles.net/?s=${queryEncoded}`)],
      [Markup.button.url('📥 Download Server 2', `https://meetdownload.com/?q=${queryEncoded}`)],
      [Markup.button.url('📥 Download Server 3', `https://videodownloader.site/?q=${queryEncoded}`)],
      [Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/${item.media_type === 'tv' ? 'tv' : 'movie'}/${item.id}`)]
    ]);

    const caption = `🎬 *${title}*${year} | ${rating}\n\n📝 ${overview}`;
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

    if (item.poster_path) {
      await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, {
        caption: `${caption}\n\n⚡ _Processed in ${elapsedTime}s_`,
        parse_mode: 'Markdown',
        ...actionButtons
      });
    } else {
      await ctx.reply(`${caption}\n\n⚡ _Processed in ${elapsedTime}s_`, { parse_mode: 'Markdown', ...actionButtons });
    }

  } catch (error) {
    console.error('Visual search error:', error);
    ctx.reply('⚠️ Failed to process the image quickly. Please try sending it again.');
  }
});

module.exports = bot;

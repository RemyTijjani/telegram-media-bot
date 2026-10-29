const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const { downloadMedia } = require('./services/socialDownloader');
const { searchMovies, getMovieDetails, searchPerson, getPersonCredits } = require('./services/tmdb');
const { identifyActor } = require('./services/actorMatcher');

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==========================================
// 📢 FORCE-JOIN CHANNEL MIDDLEWARE (PASTE HERE)
// ==========================================
const CHANNEL_USERNAME = '@EMPTYMOVIEBOX'; // 👈 Replace with your channel username

bot.use(async (ctx, next) => {
  // Allow /start command or non-private chats without blocking
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

// ... rest of your code (bot.command, bot.on, etc.)
// ==========================================
// 🛠️ AUTOMATIC BOT PROFILE & COMMAND SETUP
// ==========================================
async function setupBotProfile() {
  try {
    // 1. Set Menu Commands (Shown in bottom-left / menu button)
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🚀 Start the bot & view main menu' },
      { command: 'help', description: '❓ Get help and usage instructions' }
    ]);

    // 2. Set Main Description (Seen on welcome screen before clicking Start)
    await bot.telegram.setMyDescription(
      "🎬 Search, stream online, and download HD movies & TV series directly inside Telegram!\n\nFast streams & high-speed direct downloads."
    );

    // 3. Set Short Description (Seen in bot profile preview)
    await bot.telegram.setMyShortDescription(
      "🍿 Watch and download movies & TV series inside Telegram."
    );

    console.log("✅ Bot commands & profile setup complete!");
  } catch (error) {
    console.error("⚠️ Failed to set bot commands/description:", error);
  }
}

// Run setup on bot launch
setupBotProfile();
const SOCIAL_URL_PATTERN = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com)\/[^\s<]+/i;

const startMessage = [
  '🎬 Welcome to ReelGrab.',
  '',
  'Paste a YouTube, TikTok, Instagram, Facebook, or X link and I will prepare the video.',
  'Type a movie or TV title for a cinematic info card.',
  'Send an actor photo for recognition and a filmography lookup.',
  '',
  'Please only download and share content you have permission to use.'
].join('\n');

function cleanUrl(value) {
  return value.replace(/[),.!?]+$/, '');
}

function movieButtons(movieId, movieTitle) {
  // Format the movie title safely for the web search URL
  const query = encodeURIComponent(movieTitle);

  return Markup.inlineKeyboard([
    [
      // Button 1: Takes user straight to videodownloader.site with the movie title pre-filled
      Markup.button.webApp('📥 Download Movie', `https://videodownloader.site/?q=${query}`)
    ],
    [
      // Button 2: Stream button for instant playback
      Markup.button.webApp('▶️ Stream Online', `https://vidsrc.to/embed/movie/${movieId}`)
    ]
  ]);
}

function movieCaption(movie) {
  const year = movie.release_date ? movie.release_date.slice(0, 4) : '—';
  const rating = typeof movie.vote_average === 'number' ? movie.vote_average.toFixed(1) : '—';
  const genres = movie.genres?.length ? movie.genres.join(', ') : 'Genre unavailable';
  const overview = movie.overview || 'No overview is available for this title.';
  return [
    `🎬 ${movie.title} (${year})`,
    `⭐ ${rating} / 10`,
    `${genres}`,
    '',
    overview
  ].join('\n');
}

bot.start((ctx) => ctx.reply(startMessage));

bot.command('help', (ctx) => ctx.reply(startMessage));

bot.on('photo', async (ctx) => {
  await ctx.reply('🔎 Looking at the photo and checking the film database…');
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    const actorName = await identifyActor(fileUrl.toString());
    if (!actorName) {
      await ctx.reply('I could not recognize an actor in that image. Try a clearer, front-facing photo.');
      return;
    }

    const person = await searchPerson(actorName);
    if (!person) {
      await ctx.reply(`I recognized ${actorName}, but could not find a matching film profile.`);
      return;
    }

    const credits = await getPersonCredits(person.id);
    const lines = credits.length
      ? credits.map((credit) => {
          const year = credit.release_date ? credit.release_date.slice(0, 4) : '—';
          return `• ${credit.title}${year !== '—' ? ` (${year})` : ''}`;
        })
      : ['No movie credits were found.'];
    const caption = [`🎭 ${person.name}`, '', ...lines].join('\n');
    const profileUrl = person.profile_path ? `https://image.tmdb.org/t/p/w500${person.profile_path}` : null;
    if (profileUrl) {
      await ctx.replyWithPhoto(profileUrl, { caption });
    } else {
      await ctx.reply(caption);
    }
  } catch (error) {
    console.error('Actor lookup failed:', error.message);
    await ctx.reply('I could not complete the actor lookup right now. Please try again with another image.');
  }
});

// ==========================================
// 🍿 HELPER FUNCTION TO RENDER PAGINATED RESULTS
// ==========================================
async function renderPageResults(ctx, searchQuery, pageNum = 1, isCallback = false) {
  const itemsPerPage = 5;

  // TMDB pages return 20 items per request. Calculate which TMDB page to fetch:
  const tmdbPage = Math.ceil((pageNum * itemsPerPage) / 20);
  const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}&page=${tmdbPage}`;

  const { data } = await axios.get(tmdbUrl);
  const rawResults = data.results || [];

  // Filter out people (only keep movies & tv)
  const validResults = rawResults.filter(item => item.media_type === 'movie' || item.media_type === 'tv');

  // Total results and total pages calculation based on 5 items per view
  const totalResults = data.total_results || validResults.length;
  const totalPages = Math.ceil(totalResults / itemsPerPage) || 1;

  if (validResults.length === 0) {
    if (isCallback) await ctx.answerCbQuery('No more results found.');
    else {
      // Fallback for custom or non-TMDB titles
      const encodedQuery = encodeURIComponent(searchQuery);
      const fallbackButtons = Markup.inlineKeyboard([
        [Markup.button.url ('📥 Download Server 1', `https://9jarocks.net/latest?s=${encodedQuery}`)],
        [Markup.button.url ('📥 Download Server 2', `https://videodownloader.site/?q=${encodedQuery}`)]
      ]);

      await ctx.reply(
        `🎬 *Search Results for "${searchQuery}":*\n\n*Overview:*\nRequested title processed via download servers. Click below to download or search your title on the platforms.`,
        { parse_mode: 'Markdown', ...fallbackButtons }
      );
    }
    return;
  }

  // Calculate slice range for 5 items per page
  const indexOnTmdbPage = ((pageNum - 1) % 4) * itemsPerPage;
  const pageItems = validResults.slice(indexOnTmdbPage, indexOnTmdbPage + itemsPerPage);

  // Send header message
  await ctx.reply(`🔎 *Found ${totalResults} result(s) for "${searchQuery}" (Page ${pageNum} of ${totalPages}):*`, {
    parse_mode: 'Markdown'
  });

  // Loop through items on the current page
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

      let buttonRows = [];
      if (mediaType === 'tv') {
        buttonRows = [
          [Markup.button.url ('📥 Download Series (VideoDownloader)', `https://videodownloader.site/?q=${queryEncoded}`)],
          [Markup.button.url('▶️ Stream Series Online', `https://vidsrc.to/embed/tv/${details.id}`)]
        ];
      } else {
        buttonRows = [
          [Markup.button.url('📥 Download Server 1', `https://9jarocks.net/latest?s=${queryEncoded}`)],
          [Markup.button.url('📥 Download Server 2', `https://videodownloader.site/?q=${queryEncoded}`)],
          [Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/movie/${details.id}`)]
        ];
      }

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

  // Generate Navigation Bar (Next / Prev Buttons)
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
// 🔄 HANDLE PAGINATION CLICK (NEXT / PREV)
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

// Handle dummy click on page indicator button
bot.action('noop', (ctx) => ctx.answerCbQuery());
// Handle dummy click on page indicator button
bot.action('noop', (ctx) => ctx.answerCbQuery());

// ==========================================
// 🆕 /LATEST COMMAND & AVAILABILITY CHECK
// ==========================================
async function checkAvailability(title) {
  const query = encodeURIComponent(title);
  
  const [has9jaRocks, hasVideoDownloader] = await Promise.all([
    axios.head(`https://9jarocks.net/latest?s=${query}`).then(res => res.status === 200).catch(() => false),
    axios.head(`https://videodownloader.site/?q=${query}`).then(res => res.status === 200).catch(() => false)
  ]);

  return {
    has9jaRocks,
    hasVideoDownloader,
    isAvailable: has9jaRocks || hasVideoDownloader
  };
}

bot.command('latest', async (ctx) => {
  try {
    await ctx.replyWithChatAction('typing');

    const tmdbUrl = `https://api.themoviedb.org/3/trending/all/day?api_key=${process.env.TMDB_API_KEY}`;
    const { data } = await axios.get(tmdbUrl);
    const results = (data.results || []).filter(item => item.media_type === 'movie' || item.media_type === 'tv').slice(0, 5);

    if (results.length === 0) {
      return ctx.reply('⚠️ No new releases found at the moment.');
    }

    await ctx.reply('🔥 *Latest Movies & Series Releases:*', { parse_mode: 'Markdown' });

    for (const item of results) {
      const mediaType = item.media_type;
      const title = item.title || item.name || 'Unknown Title';
      const releaseDate = item.release_date || item.first_air_date || 'Coming Soon';
      const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '⭐ N/A';
      const overview = item.overview ? item.overview.slice(0, 250) + '...' : 'No description available.';

      const queryEncoded = encodeURIComponent(title);
      const status = await checkAvailability(title);

      let buttonRows = [];

      if (status.isAvailable) {
        if (mediaType === 'tv') {
          if (status.hasVideoDownloader) {
            buttonRows.push([Markup.button.webApp('📥 Download Series (VideoDownloader)', `https://videodownloader.site/?q=${queryEncoded}`)]);
          }
          buttonRows.push([Markup.button.webApp('▶️ Stream Series Online', `https://vidsrc.to/embed/tv/${item.id}`)]);
        } else {
          if (status.has9jaRocks) {
            buttonRows.push([Markup.button.webApp('📥 Download Server 1 (9jaRocks)', `https://9jarocks.net/latest?s=${queryEncoded}`)]);
          }
          if (status.hasVideoDownloader) {
            buttonRows.push([Markup.button.webApp('📥 Download Server 2 (VideoDownloader)', `https://videodownloader.site/?q=${queryEncoded}`)]);
          }
          buttonRows.push([Markup.button.webApp('▶️ Stream Online', `https://vidsrc.to/embed/movie/${item.id}`)]);
        }
      }

      const caption = `🎬 *${title}* (${releaseDate.split('-')[0] || '2026'})\n🏷️ Type: *${mediaType.toUpperCase()}*\n${rating}\n\n📝 *Overview:*\n${overview}${!status.isAvailable ? '\n\n⏳ *Status:* _Not yet available for download/stream._' : ''}`;

      if (buttonRows.length > 0) {
        const actionButtons = Markup.inlineKeyboard(buttonRows);
        if (item.poster_path) {
          await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, { caption, parse_mode: 'Markdown', ...actionButtons });
        } else {
          await ctx.reply(caption, { parse_mode: 'Markdown', ...actionButtons });
        }
      } else {
        if (item.poster_path) {
          await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, { caption, parse_mode: 'Markdown' });
        } else {
          await ctx.reply(caption, { parse_mode: 'Markdown' });
        }
      }
    }
  } catch (error) {
    console.error('Error fetching latest updates:', error);
    ctx.reply('⚠️ Failed to load latest releases.');
  }
});

module.exports = bot;
module.exports = bot;

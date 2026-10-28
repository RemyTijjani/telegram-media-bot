const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const { downloadMedia } = require('./services/socialDownloader');
const { searchMovies, getMovieDetails, searchPerson, getPersonCredits } = require('./services/tmdb');
const { identifyActor } = require('./services/actorMatcher');

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
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
// 🔍 1. HANDLE USER TEXT SEARCHES (MULTI-RESULT)
// ==========================================
bot.on('text', async (ctx) => {
  // Ignore command messages like /start or /help
  if (ctx.message.text.startsWith('/')) return;

  const searchQuery = ctx.message.text.trim();

  try {
    // Search TMDB for the query
    const tmdbUrl = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}`;
    const { data } = await axios.get(tmdbUrl);

    if (!data.results || data.results.length === 0) {
      return ctx.reply(`❌ No movies found matching *"${searchQuery}"*. Try another title!`, { parse_mode: 'Markdown' });
    }

    // Limit to top 5 results for clean display
    const topResults = data.results.slice(0, 5);

    // Build Inline Buttons for each search result
    const buttons = topResults.map((movie) => {
      const year = movie.release_date ? ` (${movie.release_date.split('-')[0]})` : '';
      return [Markup.button.callback(`🎬 ${movie.title}${year}`, `select_movie_${movie.id}`)];
    });

    await ctx.reply(
      `🔎 *Found ${data.results.length} results for "${searchQuery}":*\nSelect a movie from the list below:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    );
  } catch (error) {
    console.error('Search Error:', error);
    ctx.reply('⚠️ Something went wrong while searching. Please try again.');
  }
});
// ==========================================
// 🎯 2. HANDLE MOVIE SELECTION CLICK
// ==========================================
bot.action(/^select_movie_(\d+)$/, async (ctx) => {
  const movieId = ctx.match[1]; // Get TMDB movie ID from regex

  try {
    // Fetch full details for the chosen movie
    const movieUrl = `https://api.themoviedb.org/3/movie/${movieId}?api_key=${process.env.TMDB_API_KEY}`;
    const { data: movie } = await axios.get(movieUrl);

    const title = movie.title;
    const year = movie.release_date ? movie.release_date.split('-')[0] : 'N/A';
    const rating = movie.vote_average ? `⭐ ${movie.vote_average.toFixed(1)}/10` : '';
    const overview = movie.overview ? movie.overview.slice(0, 250) + '...' : 'No description available.';

    // Create action buttons for streaming & downloads
    const movieTitleQuery = encodeURIComponent(title);
    const actionButtons = Markup.inlineKeyboard([
      [
        Markup.button.webApp('📥 Download via 9jaRocks', `https://9jarocks.net/latest?s=${movieTitleQuery}`)
      ],
      [
        Markup.button.webApp('📥 Download Server 2', `https://videodownloader.site/?q=${movieTitleQuery}`)
      ],
      [
        Markup.button.webApp('▶️ Stream Online', `https://vidsrc.to/embed/movie/${movie.id}`)
      ]
    ]);

    const caption = `🎬 *${title}* (${year})\n${rating}\n\n📝 *Overview:*\n${overview}`;

    // Stop loading indicator on the clicked button
    await ctx.answerCbQuery();

    // Send poster if available, otherwise send text
    if (movie.poster_path) {
      await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${movie.poster_path}`, {
        caption: caption,
        parse_mode: 'Markdown',
        ...actionButtons
      });
    } else {
      await ctx.reply(caption, {
        parse_mode: 'Markdown',
        ...actionButtons
      });
    }
  } catch (error) {
    console.error('Callback Error:', error);
    ctx.answerCbQuery('⚠️ Failed to load movie details.');
  }
});
    
  // ==========================================
// 🔍 HANDLE USER TEXT SEARCHES (MULTI-RESULT)
// ==========================================
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  const searchQuery = ctx.message.text.trim();

  try {
    await ctx.replyWithChatAction('typing');

    // Use your project's existing searchMovies service
    const results = await searchMovies(searchQuery);

    if (!results || results.length === 0) {
      return ctx.reply(`❌ No movies found matching *"${searchQuery}"*. Try another title!`, { parse_mode: 'Markdown' });
    }

    // Limit to top 5 results for clean display
    const topResults = results.slice(0, 5);

    // Build Inline Buttons for each search result
    const buttons = topResults.map((movie) => {
      const title = movie.title || movie.name || 'Unknown Title';
      const releaseDate = movie.release_date || movie.first_air_date || '';
      const year = releaseDate ? ` (${releaseDate.split('-')[0]})` : '';
      return [Markup.button.callback(`🎬 ${title}${year}`, `select_movie_${movie.id}`)];
    });

    await ctx.reply(
      `🔎 *Found results for "${searchQuery}":*\nSelect a movie from the list below:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      }
    );
  } catch (error) {
    console.error('Search Error:', error);
    ctx.reply('⚠️ Something went wrong while searching. Please try again.');
  }
});

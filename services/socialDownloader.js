const axios = require('axios');

async function downloadMedia(url) {
  const cobaltUrl = process.env.COBALT_API_URL || 'https://sunny.imput.net/';
  const response = await axios.post(cobaltUrl, {
    url,
    videoQuality: '720',
    downloadMode: 'auto'
  }, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: 30000,
    validateStatus: (status) => status >= 200 && status < 300
  });

  const mediaUrl = response.data?.url || response.data?.stream?.url;
  if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
    throw new Error('Cobalt did not return a media URL');
  }
  return mediaUrl;
}

module.exports = { downloadMedia };

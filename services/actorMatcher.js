const axios = require('axios');

async function identifyActor(imageUrl) {
  const endpoint = process.env.ACTOR_RECOGNITION_API_URL;
  if (!endpoint) return null;

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ACTOR_RECOGNITION_API_KEY) {
    headers.Authorization = `Bearer ${process.env.ACTOR_RECOGNITION_API_KEY}`;
  }
  const { data } = await axios.post(endpoint, { image_url: imageUrl }, {
    headers,
    timeout: 30000
  });
  return data?.name || data?.actor?.name || data?.result?.name || data?.data?.name || null;
}

module.exports = { identifyActor };

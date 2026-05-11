import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Voice from '../../../models/voice.schema';

const MAX_SECONDS = parseInt(env.VOICE_MAX_SECONDS ?? '240');

export async function GET({ url }) {
  const id = url.searchParams.get('id') ?? '';

  try {
    const voice = await Voice.findOne({ _id: id });
    if (voice) return json({ status: 200, body: voice });
    return json({ status: 404, body: 'Voice not found' });
  } catch (error) {
    console.error(error);
    return json({ status: 500, body: 'Error fetching voice' });
  }
}

export async function POST({ request }) {
  const { encryptedAudio, preset, durationSeconds } = await request.json();

  if (!encryptedAudio?.length) {
    return json({ status: 400, body: 'Missing encryptedAudio' });
  }

  if (durationSeconds > MAX_SECONDS) {
    return json({ status: 400, body: `Voice exceeds max duration of ${MAX_SECONDS}s` });
  }

  try {
    const voice = new Voice({ encryptedAudio, preset, durationSeconds });
    await voice.save();
    return json({ status: 200, body: { id: voice._id } });
  } catch (error) {
    console.error(error);
    return json({ status: 500, body: 'Error saving voice' });
  }
}

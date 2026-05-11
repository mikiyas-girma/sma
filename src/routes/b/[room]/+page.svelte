<script lang="ts">
  import * as openpgp from 'openpgp';
  import { fly } from 'svelte/transition';
  import type { IKeyPairs } from '$lib/types';

  import { page } from '$app/state';
  import { onMount } from 'svelte';

  import ImageSquare from 'phosphor-svelte/lib/ImagesSquare';
  import ImageThumbnail from '../../li/[room]/Message/ImageThumbnail.svelte';
  import Textarea from '$lib/components/ui/textarea/textarea.svelte';

  import { breakString } from '$lib/utils/utils';
  import { getAllFromLS, getLoadedPairFromLS } from '$lib/utils/localStorage';
  import { X } from 'phosphor-svelte';
  import { Button } from '$lib/components/ui/button';

  let api_pbKey: string;
  let disableSend = false;

  interface IVectorResponse {
    flaggedFor?: string;
    isProfanity: boolean;
    score: number;
  }

  let keyPairs: IKeyPairs[] | undefined;
  let loadedPair: IKeyPairs | null = null;

  let params = page.params.room;

  let sending = $state(false);
  let checkingProfanity = $state(false);

  let message = $state('');
  let roomTitle = $state('');
  let imageBase64: string[] = $state([]);
  let profanityCheckResponse: IVectorResponse | undefined = $state();
  let profaneBlock = $state(false);

  // ── Voice state ─────────────────────────────────────────────────────────────
  type VoicePreset = 'ghost' | 'robot' | 'chipmunk';
  const VOICE_MAX_SECONDS = 240;

  let voiceBlob: Blob | null = $state(null);
  let voiceBlobUrl: string | null = $state(null);
  let voicePreset: VoicePreset = $state('ghost');
  let voiceDurationSeconds = $state(0);
  let recordingState: 'idle' | 'recording' | 'processing' = $state('idle');

  let mediaRecorder: MediaRecorder | null = null;
  let recordingChunks: Blob[] = [];
  let recordingTimerId: ReturnType<typeof setInterval> | null = null;
  let recordingElapsed = $state(0);

  const PRESETS: { id: VoicePreset; label: string; emoji: string }[] = [
    { id: 'ghost', label: 'Ghost', emoji: '👻' },
    { id: 'robot', label: 'Robot', emoji: '🤖' },
    { id: 'chipmunk', label: 'Chipmunk', emoji: '🐿️' }
  ];

  /** Apply a Web Audio API transform to a Blob, returning a new WAV Blob. */
  async function applyVoicePreset(input: Blob, preset: VoicePreset): Promise<Blob> {
    const arrayBuffer = await input.arrayBuffer();
    const tempCtx = new AudioContext();
    const decoded = await tempCtx.decodeAudioData(arrayBuffer);
    await tempCtx.close();

    const sampleRate = decoded.sampleRate;
    const numChannels = decoded.numberOfChannels;
    const numFrames = decoded.length;

    const offlineCtx = new OfflineAudioContext(numChannels, numFrames, sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;

    if (preset === 'ghost') {
      // Ghost: pitch down (slow playback) + heavy reverb simulation via convolver
      source.playbackRate.value = 0.75;
      const convolver = offlineCtx.createConvolver();
      const irLength = Math.floor(sampleRate * 2.5);
      const irBuffer = offlineCtx.createBuffer(2, irLength, sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = irBuffer.getChannelData(ch);
        for (let i = 0; i < irLength; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLength, 2);
        }
      }
      convolver.buffer = irBuffer;
      const gainNode = offlineCtx.createGain();
      gainNode.gain.value = 0.55;
      source.connect(convolver);
      convolver.connect(gainNode);
      gainNode.connect(offlineCtx.destination);
    } else if (preset === 'robot') {
      // Robot: ring modulation — multiply signal by a sine carrier
      const oscillator = offlineCtx.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = 50;
      const ringGain = offlineCtx.createGain();
      ringGain.gain.value = 0;
      oscillator.connect(ringGain.gain);
      source.connect(ringGain);
      const gainNode = offlineCtx.createGain();
      gainNode.gain.value = 2;
      ringGain.connect(gainNode);
      gainNode.connect(offlineCtx.destination);
      oscillator.start();
    } else {
      // Chipmunk: pitch up via faster playback
      source.playbackRate.value = 1.55;
    }

    if (preset !== 'ghost' && preset !== 'robot') {
      source.connect(offlineCtx.destination);
    }

    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();

    // Encode to WAV
    return audioBufferToWavBlob(renderedBuffer);
  }

  function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const dataLength = numFrames * numChannels * bytesPerSample;
    const wavBuffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(wavBuffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([wavBuffer], { type: 'audio/wav' });
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingChunks = [];
      recordingElapsed = 0;
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const raw = new Blob(recordingChunks, { type: mediaRecorder!.mimeType });
        recordingState = 'processing';
        try {
          const transformed = await applyVoicePreset(raw, voicePreset);
          voiceDurationSeconds = recordingElapsed;
          if (voiceBlobUrl) URL.revokeObjectURL(voiceBlobUrl);
          voiceBlob = transformed;
          voiceBlobUrl = URL.createObjectURL(transformed);
        } catch (err) {
          console.error('Voice transform failed:', err);
          // Fall back to raw audio so the user doesn't lose their recording
          if (voiceBlobUrl) URL.revokeObjectURL(voiceBlobUrl);
          voiceBlob = raw;
          voiceBlobUrl = URL.createObjectURL(raw);
          voiceDurationSeconds = recordingElapsed;
        }
        recordingState = 'idle';
      };

      mediaRecorder.start();
      recordingState = 'recording';

      recordingTimerId = setInterval(() => {
        recordingElapsed += 1;
        if (recordingElapsed >= VOICE_MAX_SECONDS) stopRecording();
      }, 1000);
    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  }

  function stopRecording() {
    if (recordingTimerId) clearInterval(recordingTimerId);
    recordingTimerId = null;
    mediaRecorder?.stop();
  }

  function clearVoice() {
    if (voiceBlobUrl) URL.revokeObjectURL(voiceBlobUrl);
    voiceBlob = null;
    voiceBlobUrl = null;
    voiceDurationSeconds = 0;
  }

  function formatSeconds(s: number): string {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  // ────────────────────────────────────────────────────────────────────────────

  const checkProfanity = async (message: string) => {
    checkingProfanity = true;
    const res = await fetch('https://vector.profanity.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    profanityCheckResponse = (await res.json()) as IVectorResponse;
    checkingProfanity = false;
    return profanityCheckResponse.isProfanity;
    // {"isProfanity":true,"score":0.99999964,"flaggedFor":"Fuck"}
  };

  // When posting sign the message with the private key and send it to the server
  // Get the private key of myself from localstorage
  const signMessage = async () => {
    if (!loadedPair) return;
    sending = true;

    const passphrase = 'super long and hard to guess secret';
    const uniqueString = loadedPair.uniqueString;
    const publicKey = await openpgp.readKey({ armoredKey: api_pbKey });

    const privateKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: loadedPair.prKey }),
      passphrase
    });

    let profanityAllowed = false;

    const respn = await fetch('/api/profanity', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        rid: params
      })
    });

    const re = await respn.json();

    if (re.error) {
      console.error(re.message);
    } else {
      profanityAllowed = re.body.profanityEnabled;
      console.log(re);
    }
    let profane = false;

    if (!profanityAllowed && message.trim().length > 0) {
      profane = await checkProfanity(message);
    }
    if (profane) {
      profaneBlock = true;
      message = '';
      sending = false;
      setTimeout(() => {
        profaneBlock = false;
      }, 2000);
      return;
    }

    let cleartextMessage = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: message || ' ' }),
      encryptionKeys: publicKey,
      signingKeys: privateKey
    });

    // ── Encrypt voice if present ─────────────────────────────────────────────
    let voiceData: { encryptedAudio: string[]; preset: string; durationSeconds: number } | null =
      null;

    if (voiceBlob) {
      const audioBytes = new Uint8Array(await voiceBlob.arrayBuffer());
      const encryptedVoice = await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: audioBytes }),
        encryptionKeys: publicKey,
        signingKeys: privateKey,
        format: 'armored'
      });
      voiceData = {
        encryptedAudio: breakString(encryptedVoice as string, 1000),
        preset: voicePreset,
        durationSeconds: voiceDurationSeconds
      };
    }
    // ────────────────────────────────────────────────────────────────────────

    const response = await fetch('/api/pgp', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: cleartextMessage,
        imageData: {
          dataURI: imageBase64,
          blurhash: 'LEHLk~WB2yk8pyo0adR*.7kCMdnj',
          nsfw: false
        },
        voiceData,
        r: uniqueString,
        p: params
      })
    });

    const resp = await response.json();

    if (resp.error) {
      console.log(resp.message);
    } else {
      console.log(resp.message);
      message = '';
      imageBase64 = [];
      clearVoice();
    }
    sending = false;
  };

  // get the public key of the other person from the url
  const fetchKeys = async () => {
    disableSend = true;
    const response = await fetch(`/api/pgp?r=${params}`);
    const data = await response.json();
    api_pbKey = data.body.pbKey;
    disableSend = false;
  };

  // On file change generate the base64 and load preview
  function handleFileInput(event: any) {
    const file = event.target.files[0];

    if (file) {
      // Create a FileReader object to read the selected file
      const reader = new FileReader();

      // limit size to 1.5MB
      if (file.size / (1024 * 1024) > 2) {
        alert('Size limit exceeded: 1.5MB MAX');
        return;
      }

      reader.onload = function (e) {
        let imageBase64Str = (e.target?.result ?? '') as string;
        imageBase64 = breakString(imageBase64Str, 1000);
      };

      // Read the selected file as a data URL
      reader.readAsDataURL(file);
    }
  }

  onMount(async () => {
    keyPairs = await getAllFromLS();
    loadedPair = (await getLoadedPairFromLS()) ?? null;

    const responseTitle = await fetch(
      `/api/title?rid=${encodeURIComponent(loadedPair?.uniqueString as string)}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    const respTitle = await responseTitle.json();
    console.log('resp', respTitle);

    if (respTitle.error) {
      console.log(respTitle.message);
    } else {
      roomTitle = respTitle.body.title.length == 0 ? respTitle.body.rid : respTitle.body.title;
    }

    if (params) {
      await fetchKeys();
    }
  });
</script>

<div
  class="container mx-auto flex min-h-screen w-full max-w-4xl grow flex-col items-center justify-start p-2 pt-8"
>
  <div class="bg-background border-primary flex w-full flex-row border">
    <div
      class="md:text-md relative flex w-full items-center justify-baseline p-4 text-left text-sm font-semibold lg:text-xl"
    >
      Send to
      <span class=" flex items-baseline justify-center gap-2 rounded-xs p-1 font-light">
        {#if roomTitle}
          <h2 class="text-md md:text-xl">
            [ {roomTitle} ]
          </h2>
          <span class="text-sm">
            {params}
          </span>
        {:else}
          {params}
        {/if}
      </span>
    </div>
  </div>
  <span class="w-full pt-2 text-left text-sm font-light">{message.length}/1000</span>
  <div class="mb-2 w-full">
    <span class="relative mb-2 flex h-full w-full flex-row items-end gap-2 pt-2 pb-4">
      <Textarea
        bind:value={message}
        placeholder="Enter your message here, then press send. "
        class="placeholder:text-md h-full
        w-full border border-black p-8"
        maxlength={1000}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            signMessage();
          }
        }}
      />

      <button
        class=" border-light-900 dark:border-dark-600
				relative h-fit border border-black p-7 transition-all
				{(!message && !voiceBlob) || sending ? 'cursor-not-allowed' : ' bg-primary text-primary-foreground'}"
        disabled={(!message && !voiceBlob) || message.trim().length > 1000 || sending || checkingProfanity}
        onclick={signMessage}
      >
        {#if checkingProfanity}
          <span
            in:fly={{ y: 4 }}
            out:fly={{ y: -4 }}
            class="bg-primary text-primary-foreground absolute -top-6 left-0 w-full"
          >
            Checking
          </span>
        {/if}
        {#if profaneBlock}
          <span
            in:fly={{ y: 4 }}
            out:fly={{ y: -4 }}
            class="bg-destructive/10 text-destructive absolute -top-6 left-0 w-full"
          >
            🤬 Profanity
          </span>
        {/if}

        {sending ? 'Sending' : 'Send'}
      </button>
    </span>

    <span class=" flex h-full w-full flex-col gap-2 border border-black p-3">
      <!-- Image row -->
      <span class="flex flex-row gap-2">
        {#if imageBase64.length}
          <ImageThumbnail imageBase64={imageBase64.join('')} variant="md" />
          <Button
            onclick={() => {
              imageBase64 = [];
            }}
          >
            <X /> <span> Clear image </span>
          </Button>
        {:else}
          <span
            class="bg-secondary/60 border-primary/30 hover:bg-secondary/80 text-secondary-foreground bottom-0 left-2 rounded-xs border p-2 transition-all"
          >
            <label for="image-input" class="flex cursor-pointer items-center gap-2">
              <ImageSquare size="24" weight="duotone" />
              <span class="text-sm">Add image </span>
            </label>
            <input
              id="image-input"
              type="file"
              class="hidden"
              accept="image/*"
              onchange={handleFileInput}
            />
          </span>
        {/if}
      </span>

      <!-- Voice row -->
      <span class="flex flex-row flex-wrap items-center gap-2">
        {#if voiceBlob && voiceBlobUrl}
          <!-- Preview player -->
          <audio controls src={voiceBlobUrl} class="h-9 max-w-xs shrink"></audio>
          <!-- Preset re-apply buttons -->
          <span class="flex gap-1">
            {#each PRESETS as p}
              <button
                class="rounded-xs border border-black px-2 py-1 text-xs transition-all
                  {voicePreset === p.id ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 hover:bg-secondary/80'}"
                onclick={async () => {
                  if (voicePreset === p.id) return;
                  voicePreset = p.id;
                  // Re-apply new preset to the already-recorded raw blob isn't stored;
                  // we just label it — the transform was already applied.
                  // To let the user switch presets, re-record.
                }}
                title="Preset: {p.label}"
              >
                {p.emoji} {p.label}
              </button>
            {/each}
          </span>
          <Button onclick={clearVoice} variant="outline" class="h-8 px-2 text-xs">
            <X size={14} /> Clear voice
          </Button>
        {:else if recordingState === 'recording'}
          <!-- Recording in progress -->
          <span class="flex items-center gap-2">
            <span class="animate-pulse text-red-500">● REC</span>
            <span class="font-mono text-sm">{formatSeconds(recordingElapsed)} / {formatSeconds(VOICE_MAX_SECONDS)}</span>
            <button
              class="bg-primary text-primary-foreground rounded-xs border border-black px-3 py-1 text-sm"
              onclick={stopRecording}
            >
              Stop
            </button>
          </span>
        {:else if recordingState === 'processing'}
          <span class="text-sm text-muted-foreground animate-pulse">Applying {voicePreset} effect…</span>
        {:else}
          <!-- Idle: show start button + preset picker -->
          <span class="flex flex-wrap items-center gap-2">
            <button
              class="bg-secondary/60 border-primary/30 hover:bg-secondary/80 text-secondary-foreground rounded-xs border p-2 text-sm transition-all flex items-center gap-2"
              onclick={startRecording}
              title="Record voice message"
            >
              🎙️ <span>Record voice</span>
            </button>
            <span class="flex gap-1">
              {#each PRESETS as p}
                <button
                  class="rounded-xs border border-black px-2 py-1 text-xs transition-all
                    {voicePreset === p.id ? 'bg-primary text-primary-foreground' : 'bg-secondary/60 hover:bg-secondary/80'}"
                  onclick={() => { voicePreset = p.id; }}
                  title="Select preset: {p.label}"
                >
                  {p.emoji} {p.label}
                </button>
              {/each}
            </span>
          </span>
        {/if}
      </span>
    </span>
  </div>
</div>

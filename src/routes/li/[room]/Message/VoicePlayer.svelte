<script lang="ts">
  import * as openpgp from 'openpgp';
  import { onMount, onDestroy } from 'svelte';
  import type { IKeyPairs } from '$lib/types';

  interface Props {
    voiceId: string;
    preset: string;
    loadedPair: IKeyPairs | undefined;
  }

  let { voiceId, preset, loadedPair }: Props = $props();

  const passphrase = 'super long and hard to guess secret';

  const PRESET_LABELS: Record<string, string> = {
    ghost: '👻 Ghost',
    robot: '🤖 Robot',
    chipmunk: '🐿️ Chipmunk'
  };

  let audioUrl: string | null = $state(null);
  let error: string | null = $state(null);
  let loading = $state(true);

  onMount(async () => {
    if (!loadedPair) {
      error = 'No identity loaded';
      loading = false;
      return;
    }

    try {
      const res = await fetch(`/api/voice?id=${voiceId}`);
      const data = await res.json();

      if (data.status !== 200) {
        error = 'Could not fetch voice';
        loading = false;
        return;
      }

      const encryptedArmored: string = (data.body.encryptedAudio as string[]).join('');

      const privateKey = await openpgp.decryptKey({
        privateKey: await openpgp.readPrivateKey({ armoredKey: loadedPair.prKey }),
        passphrase
      });

      const readMsg = await openpgp.readMessage({ armoredMessage: encryptedArmored });
      const { data: decryptedBytes } = await openpgp.decrypt({
        message: readMsg,
        decryptionKeys: privateKey,
        format: 'binary',
        config: { allowInsecureDecryptionWithSigningKeys: true }
      });

      const blob = new Blob([decryptedBytes as Uint8Array], { type: 'audio/wav' });
      audioUrl = URL.createObjectURL(blob);
    } catch (err) {
      console.error('Voice decryption failed:', err);
      error = 'Could not decrypt voice';
    }

    loading = false;
  });

  onDestroy(() => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  });
</script>

<span class="mt-2 flex flex-col gap-1">
  <span class="text-xs text-muted-foreground">{PRESET_LABELS[preset] ?? preset}</span>
  {#if loading}
    <span class="text-xs animate-pulse text-muted-foreground">Decrypting voice…</span>
  {:else if error}
    <span class="text-xs text-destructive">{error}</span>
  {:else if audioUrl}
    <audio controls src={audioUrl} class="h-9 max-w-xs"></audio>
  {/if}
</span>

<script>
  import { isStaging } from '$lib/api.js';
  import { onMount } from 'svelte';

  onMount(() => {
    // F33: envBannerH store was write-only — the CSS var below is the real source.
    const staging = isStaging();
    document.documentElement.style.setProperty('--env-banner-h', staging ? '38px' : '0px');
  });
</script>

{#if isStaging()}
  <div id="env-staging-banner">
    <span>⚠ STAGING</span>
    <span class="sub">— not production</span>
  </div>
{/if}

<style>
  #env-staging-banner {
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: #f59e0b; color: #000;
    font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    padding: 6px 16px; padding-top: calc(6px + env(safe-area-inset-top));
    box-shadow: 0 2px 8px rgba(0,0,0,.3);
  }
  .sub { font-weight: 400; opacity: .75; }
</style>

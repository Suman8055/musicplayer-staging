import { writable } from 'svelte/store';
import { persisted } from './persisted.js';

export const smartPlayOn      = persisted('mbx_smartplay_on', true);
export const smartQueueActive = writable(false);
export const whyChip          = writable(null);   // { reason, label } | null

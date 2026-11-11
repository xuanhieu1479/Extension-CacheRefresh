import { event_types, eventSource, saveSettingsDebounced } from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const MODULE_NAME = 'cache_refresh';
const extensionName = 'third-party/Extension-CacheRefresh';

let refreshTimer = null;
let pingCount = 0;
let isRefreshing = false;
/** Timestamp (ms) when the next auto ping fires, or null when none is scheduled. */
let nextPingAt = null;
/** Full length (ms) of the current countdown, for the badge progress bar. */
let countdownTotal = 0;
let countdownTicker = null;

const defaultSettings = Object.freeze({
    enabled: false,
    interval: 240,
    maxPings: 0,
    promptText: 'Continue.',
});

/**
 * Load extension settings with defaults.
 */
async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings[MODULE_NAME].hasOwnProperty(key)) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    populateUI();
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function populateUI() {
    const s = getSettings();
    $('#cache_refresh_enabled').prop('checked', s.enabled);
    $('#cache_refresh_interval').val(s.interval);
    $('#cache_refresh_max_pings').val(s.maxPings);
    $('#cache_refresh_prompt').val(s.promptText);
    updateCounterDisplay();
}

function formatCountdown(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${m}:${sec}`;
}

/** Text describing the countdown state, shared by the badge and the settings panel. */
function getCountdownText() {
    if (isRefreshing) return 'pinging…';
    if (nextPingAt === null) {
        const { maxPings } = getSettings();
        if (maxPings > 0 && pingCount >= maxPings) return 'max reached';
        return '–:––';
    }
    return formatCountdown(Math.max(0, nextPingAt - Date.now()));
}

function updateCounterDisplay() {
    const countdown = getCountdownText();
    $('#cache_refresh_counter').text(pingCount);
    $('#cache_refresh_countdown').text(countdown);

    const badge = $('#cache_refresh_badge');
    badge.find('.cache_refresh_badge_count').text(`⟳ ${pingCount}`);
    badge.find('.cache_refresh_badge_time').text(countdown);

    // Progress bar drains as the next ping approaches
    let fraction = 0;
    if (nextPingAt !== null && countdownTotal > 0) {
        fraction = Math.min(1, Math.max(0, (nextPingAt - Date.now()) / countdownTotal));
    }
    badge.find('.cache_refresh_badge_bar').css('width', `${fraction * 100}%`);
    badge.toggleClass('soon', nextPingAt !== null && nextPingAt - Date.now() <= 30000);

    if (getSettings().enabled) {
        badge.show();
    } else {
        badge.hide();
    }
}

/** Mark the countdown as idle (no ping scheduled) and stop the display ticker. */
function clearCountdown() {
    nextPingAt = null;
    countdownTotal = 0;
    if (countdownTicker) {
        clearInterval(countdownTicker);
        countdownTicker = null;
    }
    updateCounterDisplay();
}

function startCountdown(delay) {
    nextPingAt = Date.now() + delay;
    countdownTotal = getSettings().interval * 1000;
    if (!countdownTicker) countdownTicker = setInterval(updateCounterDisplay, 1000);
    updateCounterDisplay();
}

/**
 * Reset the refresh timer. Called after pings and user messages.
 * Claude's cache lifetime runs from when a request is sent, not when its reply finishes,
 * so the interval is counted from `sentAt` (default: now) and reply time is subtracted.
 * @param {number} [sentAt] Timestamp (ms) when the request that refreshed the cache was sent
 */
function resetTimer(sentAt = Date.now()) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    clearCountdown();

    const context = getContext();
    if (!context.characterId && !context.groupId) return;

    const settings = getSettings();
    if (!settings.enabled) return;

    // Nothing left to send once the ping limit is hit; a real generation or manual refresh restarts it
    if (settings.maxPings > 0 && pingCount >= settings.maxPings) return;

    const delay = Math.max(0, settings.interval * 1000 - (Date.now() - sentAt));
    refreshTimer = setTimeout(sendCacheRefresh, delay);
    startCountdown(delay);
    console.debug(`[${MODULE_NAME}] Timer set for ${Math.round(delay / 1000)}s`);
}

/**
 * Send a quiet prompt to the API to keep the cache alive.
 * Uses minimal responseLength so the request completes (ensuring cache is written)
 * while generating only a few tokens.
 * A manual refresh ignores the enabled/max-pings checks and resets the counter to 0.
 */
async function sendCacheRefresh(manual = false) {
    const settings = getSettings();
    if (!manual && !settings.enabled) return;
    if (isRefreshing) {
        if (manual) toastr.info('A cache refresh is already in progress.');
        return;
    }

    // Check max pings (0 = unlimited)
    if (!manual && settings.maxPings > 0 && pingCount >= settings.maxPings) {
        console.debug(`[${MODULE_NAME}] Max pings reached (${settings.maxPings})`);
        return;
    }

    // Don't interrupt an ongoing generation
    if ($('#mes_stop').is(':visible')) {
        console.debug(`[${MODULE_NAME}] Generation in progress, skipping ping`);
        if (manual) toastr.info('Generation in progress, try again after it finishes.');
        resetTimer();
        return;
    }

    if (manual) {
        const context = getContext();
        if (!context.characterId && !context.groupId) {
            toastr.warning('Open a chat before refreshing the cache.');
            return;
        }
        // Stop the pending auto ping; resetTimer() restarts the countdown afterwards
        if (refreshTimer) clearTimeout(refreshTimer);
    }

    isRefreshing = true;
    clearCountdown();
    console.log(`[${MODULE_NAME}] Sending ${manual ? 'manual cache refresh' : `cache refresh ping #${pingCount + 1}`}`);

    // Pulse the badge
    $('#cache_refresh_badge').addClass('pinging');
    setTimeout(() => $('#cache_refresh_badge').removeClass('pinging'), 800);

    // The next ping is scheduled from this moment, not from when the reply finishes
    const sentAt = Date.now();

    try {
        const { generateQuietPrompt } = getContext();

        await generateQuietPrompt({
            quietPrompt: settings.promptText,
        });

        if (manual) {
            pingCount = 0;
            updateCounterDisplay();
            console.log(`[${MODULE_NAME}] Manual cache refresh complete, counter reset`);
            toastr.success('Cache refreshed.');
        } else {
            pingCount++;
            updateCounterDisplay();
            console.log(`[${MODULE_NAME}] Cache refresh ping #${pingCount} complete`);
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error during cache refresh:`, err);
        if (manual) toastr.error('Cache refresh failed: ' + err.message);
    } finally {
        isRefreshing = false;
        resetTimer(sentAt);
    }
}

/** Type of the generation currently being prepared ('normal', 'swipe', 'quiet', ...). */
let pendingGenerationType = null;

/**
 * GENERATION_STARTED fires at the start of every Generate() call, even ones that end up
 * sending nothing (e.g. aborted by slash commands), so only remember the type here.
 */
function onGenerationStarted(type, _options, dryRun) {
    if (dryRun) return;
    pendingGenerationType = type;
}

/**
 * GENERATE_AFTER_DATA fires once the prompt is built, right before the request is sent.
 * Any real, non-quiet generation (send, empty send, swipe, regenerate, continue,
 * impersonate...) refreshes the cache, so reset the ping counter and restart the countdown.
 * Quiet prompts are skipped: our own pings schedule themselves, and other extensions'
 * quiet prompts may not send the same prompt.
 */
function onGenerationRequest(_data, dryRun) {
    if (dryRun) return;
    const type = pendingGenerationType;
    pendingGenerationType = null;
    if (type === 'quiet' || isRefreshing) return;
    pingCount = 0;
    updateCounterDisplay();
    resetTimer();
}

function addGenerationListeners() {
    removeGenerationListeners();
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, onGenerationRequest);
}

function removeGenerationListeners() {
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.removeListener(event_types.GENERATE_AFTER_DATA, onGenerationRequest);
}

/**
 * Handle enable/disable toggle.
 */
function handleToggle() {
    const settings = getSettings();
    if (settings.enabled) {
        resetTimer();
        addGenerationListeners();
    } else {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        removeGenerationListeners();
        pingCount = 0;
        clearCountdown();
    }
}

function updateSetting(elementId, property, isCheckbox = false) {
    let value = $(`#${elementId}`).val();
    if (isCheckbox) {
        value = $(`#${elementId}`).prop('checked');
    }
    extension_settings[MODULE_NAME][property] = value;
    saveSettingsDebounced();
}

function attachUpdateListener(elementId, property, isCheckbox = false) {
    $(`#${elementId}`).on('input', debounce(() => {
        updateSetting(elementId, property, isCheckbox);
    }, 250));
}

async function loadSettingsHTML() {
    const settingsHtml = await renderExtensionTemplateAsync(extensionName, 'dropdown');
    const getContainer = () => $(document.getElementById('idle_container') ?? document.getElementById('extensions_settings2'));
    getContainer().append(settingsHtml);

    // Add floating badge to the page
    $('body').append(`
        <div id="cache_refresh_badge" title="Cache Refresh: pings sent · time until next ping">
            <span class="cache_refresh_badge_count"></span>
            <span class="cache_refresh_badge_time"></span>
            <div class="cache_refresh_badge_bar"></div>
        </div>`);
}

function setupListeners() {
    const settings = [
        ['cache_refresh_enabled', 'enabled', true],
        ['cache_refresh_interval', 'interval'],
        ['cache_refresh_max_pings', 'maxPings'],
        ['cache_refresh_prompt', 'promptText'],
    ];

    settings.forEach(s => attachUpdateListener(...s));

    $('#cache_refresh_enabled').on('input', debounce(handleToggle, 250));
    $('#cache_refresh_now').on('click', () => sendCacheRefresh(true));
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cache-refresh',
        callback: async () => {
            const settings = getSettings();
            settings.enabled = !settings.enabled;
            $('#cache_refresh_enabled').prop('checked', settings.enabled);
            saveSettingsDebounced();
            handleToggle();
            const state = settings.enabled ? 'enabled' : 'disabled';
            toastr.info(`Cache Refresh ${state}`);
            return state;
        },
        helpString: 'Toggle Cache Refresh on/off.',
    }));
}

jQuery(async () => {
    await loadSettingsHTML();
    await loadSettings();
    setupListeners();
    registerSlashCommands();

    if (getSettings().enabled) {
        resetTimer();
        addGenerationListeners();
    }
});

import { event_types, eventSource, saveSettingsDebounced } from '../../../../script.js';
import { debounce } from '../../../utils.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';

const MODULE_NAME = 'cache_refresh';
const extensionName = 'third-party/Extension-CacheRefresh';

let refreshTimer = null;
let pingCount = 0;
let isRefreshing = false;

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

function updateCounterDisplay() {
    $('#cache_refresh_counter').text(pingCount);
    const badge = $('#cache_refresh_badge');
    badge.text(`⟳ ${pingCount}`);

    if (getSettings().enabled) {
        badge.show();
    } else {
        badge.hide();
    }
}

/**
 * Reset the refresh timer. Called after pings and user messages.
 */
function resetTimer() {
    if (refreshTimer) clearTimeout(refreshTimer);

    const context = getContext();
    if (!context.characterId && !context.groupId) return;

    const settings = getSettings();
    if (!settings.enabled) return;

    refreshTimer = setTimeout(sendCacheRefresh, settings.interval * 1000);
    console.debug(`[${MODULE_NAME}] Timer set for ${settings.interval}s`);
}

/**
 * Wait for the stop button to appear (meaning the API has started responding
 * and the cache is warmed), then stop generation after a 1-second safety margin.
 */
function stopGenerationWhenReady() {
    return new Promise(resolve => {
        const maxWait = 30000;
        const startTime = Date.now();

        const check = setInterval(() => {
            if ($('#mes_stop').is(':visible')) {
                clearInterval(check);
                // Wait 1 second after response starts to ensure cache is fully warmed
                setTimeout(() => {
                    $('#mes_stop').trigger('click');
                    console.debug(`[${MODULE_NAME}] Stopped generation 1s after response started`);
                    resolve(true);
                }, 1000);
            } else if (Date.now() - startTime > maxWait) {
                clearInterval(check);
                console.debug(`[${MODULE_NAME}] Timed out waiting for stop button`);
                resolve(false);
            }
        }, 200);
    });
}

/**
 * Send a quiet prompt to the API to keep the cache alive.
 * The cache is warmed when Claude processes the prompt (before generation completes).
 * We wait for the response to start, then stop after 1 second to save tokens.
 */
async function sendCacheRefresh() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (isRefreshing) return;

    // Check max pings (0 = unlimited)
    if (settings.maxPings > 0 && pingCount >= settings.maxPings) {
        console.debug(`[${MODULE_NAME}] Max pings reached (${settings.maxPings})`);
        return;
    }

    // Don't interrupt an ongoing generation
    if ($('#mes_stop').is(':visible')) {
        console.debug(`[${MODULE_NAME}] Generation in progress, skipping ping`);
        resetTimer();
        return;
    }

    isRefreshing = true;
    console.log(`[${MODULE_NAME}] Sending cache refresh ping #${pingCount + 1}`);

    // Pulse the badge
    $('#cache_refresh_badge').addClass('pinging');
    setTimeout(() => $('#cache_refresh_badge').removeClass('pinging'), 800);

    try {
        const { generateQuietPrompt } = getContext();

        // Fire generation without awaiting — we'll stop it early
        const genPromise = generateQuietPrompt({
            quietPrompt: settings.promptText,
        }).catch(() => {
            // Abort error is expected when we click stop — silently ignore
        });

        // Wait for the response to start streaming, then stop after 1s
        await stopGenerationWhenReady();

        // Wait for the generation promise to settle (should resolve quickly after stop)
        await genPromise;

        pingCount++;
        updateCounterDisplay();
        console.log(`[${MODULE_NAME}] Cache refresh ping #${pingCount} complete`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error during cache refresh:`, err);
    } finally {
        isRefreshing = false;
        resetTimer();
    }
}

/**
 * When the user sends a message manually, reset the ping counter and timer.
 * The user's message already refreshes the cache, so we restart the countdown.
 */
function onUserMessage() {
    if (isRefreshing) return;
    pingCount = 0;
    updateCounterDisplay();
    resetTimer();
}

/**
 * Handle enable/disable toggle.
 */
function handleToggle() {
    const settings = getSettings();
    if (settings.enabled) {
        resetTimer();
        eventSource.on(event_types.MESSAGE_SENT, onUserMessage);
    } else {
        if (refreshTimer) clearTimeout(refreshTimer);
        eventSource.removeListener(event_types.MESSAGE_SENT, onUserMessage);
        pingCount = 0;
        updateCounterDisplay();
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
    $('body').append('<div id="cache_refresh_badge" title="Cache Refresh ping count"></div>');
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
}

jQuery(async () => {
    await loadSettingsHTML();
    await loadSettings();
    setupListeners();

    if (getSettings().enabled) {
        resetTimer();
        eventSource.on(event_types.MESSAGE_SENT, onUserMessage);
    }
});

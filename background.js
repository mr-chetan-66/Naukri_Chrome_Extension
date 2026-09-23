// ====================================================================
// Naukri Auto Follow — background.js (service worker)
// ====================================================================
//
// Responsibilities:
//   - Click through company "arrow" links on the filtered list tab
//   - Detect the new company detail tab, find + click "Follow"
//   - Close the detail tab, move to the next company
//   - Pause every BATCH_SIZE companies so you can sanity-check progress
//   - Persist progress to chrome.storage so a popup close / SW restart
//     doesn't lose your place
//   - When the current list page runs out of arrows, automatically click
//     the "Next" pagination link and keep going; fall back to a manual
//     pause only if that ever fails
//
// ====================================================================


// --------------------------------------------------
// Config — tune here
// --------------------------------------------------

const CONFIG = {
    // Pause and wait for the user to click "Continue" after this many
    // companies, even if there are more arrows left on the page.
    DEFAULT_BATCH_SIZE: 25,

    ARROW_SELECTOR: "span.right-arrow-onetheme",
    FOLLOW_SELECTOR: "span.follow-button.typ-16Bold",
    FOLLOW_SELECTOR_FALLBACK: "span.follow-button",

    // Pagination "Next" link at the bottom of the company list.
    PAGINATION_NEXT_SELECTOR: ".pagination a.btn-secondary.next",
    PAGINATION_NEXT_SELECTOR_FALLBACK: ".pagination a.next",
    PAGE_TRANSITION_POLL_INTERVAL: 1000,   // how often to check whether the next page has loaded
    PAGE_TRANSITION_MAX_ATTEMPTS: 15,      // ~15s max wait for the next page to render

    // ---- Timing (ms) ----
    // These are the main knobs for speed vs. reliability. Total round
    // trip per company ≈ PAGE_RENDER_WAIT + (follow-button poll, ~0 if
    // found immediately) + PRE_CLICK_SCROLL_WAIT + POST_CLICK_CONFIRM_WAIT
    // + SAVE_SETTLE_WAIT (only if we actually clicked Follow) +
    // NEXT_COMPANY_DELAY, plus however long the tab itself takes to load.
    // As configured below that's ~3.8s of fixed waiting, which combined
    // with typical page-load time lands around the 4-5s/company you asked
    // for. Pushing these much lower risks closing the tab before Naukri's
    // own follow request lands, or clicking before the button exists.
    PAGE_RENDER_WAIT: 1000,        // wait after tab reports "complete", before searching for Follow
    FOLLOW_POLL_INTERVAL: 1000,    // re-check interval if Follow control isn't there yet
    FOLLOW_POLL_MAX_ATTEMPTS: 12,  // ~12s max wait for the Follow control to appear
    PRE_CLICK_SCROLL_WAIT: 300,    // settle time after scrollIntoView, before clicking
    POST_CLICK_CONFIRM_WAIT: 1000, // wait after clicking, before re-reading button text
    SAVE_SETTLE_WAIT: 800,         // extra time before closing the tab, only when we actually clicked Follow
    NEXT_COMPANY_DELAY: 700,       // gap before opening the next company (also acts as a soft rate limit)
    ARROW_CLICK_SETTLE: 250        // delay inside the page before clicking the arrow
};

const STORAGE_KEY = "naukriAutoFollowState";


// --------------------------------------------------
// State
// --------------------------------------------------
// This mirrors what's persisted in chrome.storage.local under
// STORAGE_KEY. We keep an in-memory copy for the running loop and
// write it out on every meaningful change so the popup (and a
// restarted service worker) can always see current progress.

let STATE = {
    status: "idle",          // idle | running | batch-paused | page-paused | stopped | completed | error
    listTabId: null,
    companyTabId: null,
    currentIndex: 0,         // arrow index on the CURRENT list page
    batchSize: CONFIG.DEFAULT_BATCH_SIZE,
    batchProcessed: 0,       // companies done in the current batch
    batchNumber: 1,
    totalProcessed: 0,       // companies done since the last Reset
    stats: { followed: 0, alreadyFollowing: 0, failed: 0 },
    failedCompanies: [],     // [{ url, reason }]
    lastMessage: "Ready.",
    updatedAt: Date.now()
};

let running = false; // local execution flag (mirrors STATE.status === "running")


// --------------------------------------------------
// Utility
// --------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
    console.log("[Naukri Auto Follow]", ...args);
}

async function loadState() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data && data[STORAGE_KEY]) {
        STATE = { ...STATE, ...data[STORAGE_KEY] };
    }
    return STATE;
}

async function saveState(patch = {}) {
    STATE = { ...STATE, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [STORAGE_KEY]: STATE });
    updateBadge();
    return STATE;
}

function updateBadge() {
    const map = {
        idle: { text: "", color: "#9CA3AF" },
        running: { text: String(STATE.batchProcessed), color: "#2563EB" },
        "batch-paused": { text: "P", color: "#F59E0B" },
        "page-paused": { text: "PG", color: "#F59E0B" },
        stopped: { text: "S", color: "#6B7280" },
        completed: { text: "OK", color: "#16A34A" },
        error: { text: "!", color: "#DC2626" }
    };

    const cfg = map[STATE.status] || map.idle;

    chrome.action.setBadgeText({ text: cfg.text });
    chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

function notify(title, message) {
    try {
        chrome.notifications.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icon128.png"),
            title,
            message,
            priority: 1
        });
    } catch (error) {
        log("Notification failed (non-fatal):", error);
    }
}


// --------------------------------------------------
// Open next company from the main list
// --------------------------------------------------

async function clickNextCompany() {

    if (!running) {
        return;
    }

    log(`Opening company ${STATE.currentIndex + 1} (batch ${STATE.batchNumber}, ${STATE.batchProcessed}/${STATE.batchSize} in this batch)`);

    let result;

    try {

        const execResult = await chrome.scripting.executeScript({

            target: { tabId: STATE.listTabId },

            func: (selector, index, settleMs) => {

                const arrows = Array.from(document.querySelectorAll(selector));

                if (!arrows[index]) {
                    return {
                        success: false,
                        reason: "no-more-arrows",
                        totalArrows: arrows.length,
                        index
                    };
                }

                const arrow = arrows[index];
                arrow.scrollIntoView({ behavior: "instant", block: "center" });

                setTimeout(() => arrow.click(), settleMs);

                return { success: true, totalArrows: arrows.length, index };
            },

            args: [CONFIG.ARROW_SELECTOR, STATE.currentIndex, CONFIG.ARROW_CLICK_SETTLE]
        });

        result = execResult?.[0]?.result;

    } catch (error) {

        log("Could not run arrow-click script:", error);
        running = false;
        await saveState({
            status: "error",
            lastMessage: `Could not access the list tab: ${error.message}`
        });
        notify("Naukri Auto Follow — Error", "Lost access to the list tab. Open the popup to see details.");
        return;
    }

    // --------------------------------------------------
    // Page exhausted: no more arrows at this index.
    // This is expected once you reach the bottom of a list page —
    // try to auto-paginate rather than stopping.
    // --------------------------------------------------
    if (!result || result.success === false) {

        log(`No arrow found at index ${STATE.currentIndex} (page had ${result?.totalArrows ?? "?"} arrows). Trying to move to the next page automatically.`);

        await goToNextPage();
        return;
    }

    log("Arrow click script executed:", result);
}


// --------------------------------------------------
// Auto-paginate: click "Next" on the company list, wait for the new
// page to render, then keep going from company index 0.
// --------------------------------------------------

async function waitForNextPageToLoad(previousUrl) {

    for (let attempt = 1; attempt <= CONFIG.PAGE_TRANSITION_MAX_ATTEMPTS; attempt++) {

        let currentUrl = null;
        let arrowCount = 0;

        try {
            const tabInfo = await chrome.tabs.get(STATE.listTabId);
            currentUrl = tabInfo.url;
        } catch (_) {
            // tab may be mid-navigation; retry
        }

        try {
            const execResult = await chrome.scripting.executeScript({
                target: { tabId: STATE.listTabId },
                func: (selector) => document.querySelectorAll(selector).length,
                args: [CONFIG.ARROW_SELECTOR]
            });
            arrowCount = execResult?.[0]?.result || 0;
        } catch (_) {
            // page mid-reload; retry
        }

        const urlChanged = Boolean(currentUrl && previousUrl && currentUrl !== previousUrl);

        if (urlChanged && arrowCount > 0) {
            log(`Next page loaded with ${arrowCount} companies:`, currentUrl);
            return { success: true };
        }

        await sleep(CONFIG.PAGE_TRANSITION_POLL_INTERVAL);
    }

    return { success: false };
}

async function goToNextPage() {

    if (!running) {
        return;
    }

    let previousUrl = null;
    try {
        const tabInfo = await chrome.tabs.get(STATE.listTabId);
        previousUrl = tabInfo.url;
    } catch (_) {
        // non-fatal — we can still try to click
    }

    let clickResult;

    try {

        const execResult = await chrome.scripting.executeScript({

            target: { tabId: STATE.listTabId },

            func: (primarySelector, fallbackSelector) => {

                const nextLink =
                    document.querySelector(primarySelector) ||
                    document.querySelector(fallbackSelector);

                if (!nextLink) {
                    return { success: false, reason: "no-next-link" };
                }

                const isDisabled =
                    nextLink.hasAttribute("disabled") ||
                    nextLink.getAttribute("aria-disabled") === "true" ||
                    nextLink.classList.contains("disabled");

                if (isDisabled) {
                    return { success: false, reason: "last-page" };
                }

                nextLink.scrollIntoView({ behavior: "instant", block: "center" });
                nextLink.click();

                return { success: true };
            },

            args: [CONFIG.PAGINATION_NEXT_SELECTOR, CONFIG.PAGINATION_NEXT_SELECTOR_FALLBACK]
        });

        clickResult = execResult?.[0]?.result;

    } catch (error) {

        log("Could not click the next-page link:", error);
        running = false;
        await saveState({
            status: "error",
            lastMessage: `Could not access the list tab to paginate: ${error.message}`
        });
        notify("Naukri Auto Follow — Error", "Lost access to the list tab while trying to go to the next page.");
        return;
    }

    // --------------------------------------------------
    // No usable "Next" link found or found already disabled.
    // --------------------------------------------------
    if (!clickResult || clickResult.success === false) {

        running = false;

        if (clickResult?.reason === "last-page") {

            await saveState({
                status: "completed",
                lastMessage: `Reached the last page. All done — processed ${STATE.totalProcessed} companies in total.`
            });

            notify(
                "Naukri Auto Follow — All done",
                `Reached the last page of your filtered list. Processed ${STATE.totalProcessed} companies total.`
            );

        } else {

            // Selector didn't match anything (site markup may have
            // changed) — fall back to asking the user to paginate by hand.
            await saveState({
                status: "page-paused",
                lastMessage: `Couldn't find a "Next" pagination link automatically. Go to the next page yourself, then click Continue.`
            });

            notify(
                "Naukri Auto Follow — Page complete",
                `Couldn't auto-paginate. Navigate to the next page, then click Continue. Total so far: ${STATE.totalProcessed}.`
            );
        }

        return;
    }

    log("Clicked next-page link. Waiting for the new page to load...");

    const pageResult = await waitForNextPageToLoad(previousUrl);

    if (!pageResult.success) {

        // The click didn't actually move to a new page — most likely
        // this really was the last page and the "disabled" check above
        // just didn't catch it. Treat it as done rather than erroring.
        running = false;

        await saveState({
            status: "completed",
            lastMessage: `The "Next" link didn't lead to a new page — you're likely on the last page. All done, processed ${STATE.totalProcessed} companies total.`
        });

        notify(
            "Naukri Auto Follow — All done",
            `Processed ${STATE.totalProcessed} companies total. That looks like the last page.`
        );

        return;
    }

    STATE.currentIndex = 0;

    await saveState({
        currentIndex: 0,
        lastMessage: "Moved to the next page automatically. Running…"
    });

    log("Next page ready. Resuming.");

    if (!running) {
        return;
    }

    await clickNextCompany();
}


// --------------------------------------------------
// Process the company detail tab
// --------------------------------------------------

async function processCompanyTab(tabId) {

    if (!running) {
        return;
    }

    log("Processing company tab:", tabId);

    let tabUrl = "(unknown URL)";
    try {
        const tabInfo = await chrome.tabs.get(tabId);
        tabUrl = tabInfo.url || tabUrl;
    } catch (_) {
        // tab may already be gone; not fatal
    }

    // Let the page render before we start polling for the Follow control.
    await sleep(CONFIG.PAGE_RENDER_WAIT);

    let executionResult;

    try {

        executionResult = await chrome.scripting.executeScript({

            target: { tabId },

            func: async (selector, fallbackSelector, pollInterval, maxAttempts, preClickWait, postClickWait) => {

                function wait(ms) {
                    return new Promise(resolve => setTimeout(resolve, ms));
                }

                function findButton() {
                    return document.querySelector(selector) || document.querySelector(fallbackSelector);
                }

                let button = null;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    button = findButton();
                    if (button) break;
                    await wait(pollInterval);
                }

                if (!button) {
                    return { status: "error", message: "Follow button not found in time." };
                }

                const readText = () => (button.innerText || "").trim().toLowerCase();
                const text = readText();

                if (text.includes("following") || text.includes("unfollow")) {
                    return { status: "already-following", text };
                }

                if (text !== "follow") {
                    return { status: "error", message: `Unexpected Follow button text: "${text}"` };
                }

                async function attemptClick() {
                    button.scrollIntoView({ behavior: "instant", block: "center" });
                    await wait(preClickWait);
                    button.click();
                    await wait(postClickWait);
                    const updated = findButton();
                    return (updated?.innerText || "").trim().toLowerCase();
                }

                let after = await attemptClick();

                if (after.includes("following") || after.includes("unfollow")) {
                    return { status: "followed", before: text, after };
                }

                // One retry — sometimes the first click just registers focus/hover.
                after = await attemptClick();

                if (after.includes("following") || after.includes("unfollow")) {
                    return { status: "followed", before: text, after, retried: true };
                }

                return {
                    status: "error",
                    message: "Click did not change button state after retry.",
                    before: text,
                    after
                };
            },

            args: [
                CONFIG.FOLLOW_SELECTOR,
                CONFIG.FOLLOW_SELECTOR_FALLBACK,
                CONFIG.FOLLOW_POLL_INTERVAL,
                CONFIG.FOLLOW_POLL_MAX_ATTEMPTS,
                CONFIG.PRE_CLICK_SCROLL_WAIT,
                CONFIG.POST_CLICK_CONFIRM_WAIT
            ]
        });

    } catch (error) {

        log("Error processing company:", error);
        executionResult = [{ result: { status: "error", message: error.message } }];
    }

    const result = executionResult?.[0]?.result || { status: "error", message: "No result returned." };
    log("Company result:", result, tabUrl);

    // Only spend time waiting for the save to land if we actually
    // triggered a write (a click). Skipping already-followed companies
    // can move on immediately.
    if (result.status === "followed") {
        await sleep(CONFIG.SAVE_SETTLE_WAIT);
    }

    // --------------------------------------------------
    // Update stats
    // --------------------------------------------------

    const stats = { ...STATE.stats };
    const failedCompanies = [...STATE.failedCompanies];

    if (result.status === "followed") {
        stats.followed++;
    } else if (result.status === "already-following") {
        stats.alreadyFollowing++;
    } else {
        stats.failed++;
        failedCompanies.push({ url: tabUrl, reason: result.message || "Unknown error" });
        // Cap what we persist so a long run can't bloat chrome.storage indefinitely.
        if (failedCompanies.length > 200) {
            failedCompanies.splice(0, failedCompanies.length - 200);
        }
    }

    // --------------------------------------------------
    // Close company tab
    // --------------------------------------------------

    try {
        await chrome.tabs.remove(tabId);
        log("Company tab closed:", tabId);
    } catch (error) {
        log("Could not close company tab (may already be closed):", error);
    }

    STATE.companyTabId = null;

    const totalProcessed = STATE.totalProcessed + 1;
    const batchProcessed = STATE.batchProcessed + 1;
    const currentIndex = STATE.currentIndex + 1;

    log(`Completed ${totalProcessed} total (batch ${STATE.batchNumber}: ${batchProcessed}/${STATE.batchSize})`);

    // --------------------------------------------------
    // Batch boundary — pause and ask the user to continue
    // --------------------------------------------------
    if (batchProcessed >= STATE.batchSize) {

        running = false;

        await saveState({
            status: "batch-paused",
            currentIndex,
            totalProcessed,
            batchProcessed,
            stats,
            failedCompanies,
            lastMessage: `Batch ${STATE.batchNumber} complete (${STATE.batchSize} companies). Click Continue for the next batch.`
        });

        notify(
            "Naukri Auto Follow — Batch complete",
            `Batch ${STATE.batchNumber} done. Followed ${stats.followed}, already following ${stats.alreadyFollowing}, failed ${stats.failed}. Open the popup and click Continue.`
        );

        return;
    }

    await saveState({ currentIndex, totalProcessed, batchProcessed, stats, failedCompanies });

    if (!running) {
        return;
    }

    await sleep(CONFIG.NEXT_COMPANY_DELAY);
    await clickNextCompany();
}


// --------------------------------------------------
// Start / resume a run
// --------------------------------------------------

async function beginRun({ resetProgress, listTabId, batchSize }) {

    await loadState();

    if (resetProgress) {
        STATE = {
            ...STATE,
            currentIndex: 0,
            totalProcessed: 0,
            batchProcessed: 0,
            batchNumber: 1,
            stats: { followed: 0, alreadyFollowing: 0, failed: 0 },
            failedCompanies: []
        };
    }

    STATE.listTabId = listTabId;
    STATE.companyTabId = null;
    if (batchSize) {
        STATE.batchSize = batchSize;
    }

    running = true;

    await saveState({
        status: "running",
        listTabId,
        batchSize: STATE.batchSize,
        lastMessage: "Running…"
    });

    log("STARTED. List tab:", listTabId, "batch size:", STATE.batchSize);

    await clickNextCompany();
}

async function continueRun() {

    await loadState();

    if (STATE.status === "page-paused") {
        // Moving to a new list page — the arrow index resets, but
        // batch progress / totals / stats all carry forward, since the
        // batch wasn't actually finished, the page just ran out.
        let tab;
        try {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        } catch (error) {
            await saveState({ status: "error", lastMessage: `Could not find the active tab: ${error.message}` });
            return;
        }

        if (!tab || !tab.url || !tab.url.includes("naukri.com")) {
            await saveState({ status: "page-paused", lastMessage: "The active tab isn't a naukri.com page. Switch to your list page, then click Continue again." });
            return;
        }

        STATE.listTabId = tab.id;
        STATE.currentIndex = 0;

    } else if (STATE.status === "batch-paused") {
        // A full batch actually completed — start counting the next one.
        STATE.batchProcessed = 0;
        STATE.batchNumber = (STATE.batchNumber || 1) + 1;
    }

    STATE.companyTabId = null;

    running = true;

    await saveState({
        status: "running",
        listTabId: STATE.listTabId,
        currentIndex: STATE.currentIndex,
        batchProcessed: 0,
        batchNumber: STATE.batchNumber,
        lastMessage: "Running…"
    });

    log("CONTINUED. List tab:", STATE.listTabId, "batch:", STATE.batchNumber);

    await clickNextCompany();
}

async function stopRun() {
    running = false;
    await saveState({ status: "stopped", lastMessage: "Stopped. Click Start to resume from where you left off." });
    log("STOPPED");
}

async function resetRun() {
    running = false;
    STATE = {
        status: "idle",
        listTabId: null,
        companyTabId: null,
        currentIndex: 0,
        batchSize: STATE.batchSize || CONFIG.DEFAULT_BATCH_SIZE,
        batchProcessed: 0,
        batchNumber: 1,
        totalProcessed: 0,
        stats: { followed: 0, alreadyFollowing: 0, failed: 0 },
        failedCompanies: [],
        lastMessage: "Ready.",
        updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: STATE });
    updateBadge();
    log("RESET");
}


// --------------------------------------------------
// Messages from popup
// --------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    (async () => {

        if (message.action === "start") {

            log("START message received.");

            if (!message.tabId) {
                await saveState({ status: "error", lastMessage: "No active tab id received from popup." });
                sendResponse({ ok: false });
                return;
            }

            await loadState();
            const resume = (STATE.status === "stopped" || STATE.status === "error") && STATE.totalProcessed > 0;

            await beginRun({
                resetProgress: !resume,
                listTabId: message.tabId,
                batchSize: message.batchSize
            });

            sendResponse({ ok: true });
            return;
        }

        if (message.action === "stop") {
            await stopRun();
            sendResponse({ ok: true });
            return;
        }

        if (message.action === "continueBatch") {
            await continueRun();
            sendResponse({ ok: true });
            return;
        }

        if (message.action === "reset") {
            await resetRun();
            sendResponse({ ok: true });
            return;
        }

        if (message.action === "getStatus") {
            await loadState();
            sendResponse({ ok: true, state: STATE });
            return;
        }

        sendResponse({ ok: false, error: "Unknown action" });

    })();

    return true; // keep the message channel open for the async response
});


// --------------------------------------------------
// Detect newly opened tabs
// --------------------------------------------------

chrome.tabs.onCreated.addListener((tab) => {

    if (!running) {
        return;
    }

    if (tab.id === STATE.listTabId) {
        return;
    }

    if (STATE.companyTabId !== null) {
        log("Another tab opened while already processing one:", tab.id);
        return;
    }

    STATE.companyTabId = tab.id;
    log("NEW COMPANY TAB CREATED:", STATE.companyTabId);
});


// --------------------------------------------------
// Detect when the new company tab finishes loading
// --------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {

    if (!running) {
        return;
    }

    if (tabId !== STATE.companyTabId) {
        return;
    }

    if (changeInfo.status !== "complete") {
        return;
    }

    log("COMPANY TAB LOADED:", tabId, "URL:", tab.url);

    if (!tab.url || !tab.url.includes("naukri.com")) {
        log("Not a Naukri company page. Ignoring.");
        return;
    }

    const processingTab = STATE.companyTabId;
    STATE.companyTabId = null; // prevent double-processing

    await processCompanyTab(processingTab);
});


// --------------------------------------------------
// Startup
// --------------------------------------------------
// If the service worker restarts mid-run (Chrome can unload it after
// ~30s idle), we do NOT auto-resume — tabs may no longer make sense.
// Just load the last known state so the popup can show it correctly,
// and make sure it's not stuck showing "running" with nothing running.

(async () => {
    await loadState();
    if (STATE.status === "running") {
        await saveState({ status: "stopped", lastMessage: "Service worker restarted mid-run. Click Start to resume from where you left off." });
    } else {
        updateBadge();
    }
})();
